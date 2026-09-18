const express = require("express");
const cors = require("cors");
const http = require("http");
const crypto = require("node:crypto");
const { Server } = require("socket.io");
const { createClient } = require("redis");
const { runChaosSwarm } = require("./chaosSwarm");

const {
  authenticateToken,
  getUserProfile,
  initializeAuthDatabase,
  loginUser,
  requireRole,
} = require("./auth");

const {
  authenticateDefenseAccess,
  unlockDefenseAccess,
} = require("./defenseAuth");

const PORT = Number(process.env.PORT) || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const CHAOS_INTERNAL_SECRET =
  process.env.CHAOS_INTERNAL_SECRET ||
  "auction-under-siege-local-chaos-service";

const app = express();
const server = http.createServer(app);

// Socket.IO broadcasts auction changes, results and security telemetry.
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ["GET", "POST"],
  },
});

app.use(
  cors({
    origin: CLIENT_ORIGIN,
  }),
);
// Allows seller image data URLs while keeping request bodies size-limited.
app.use(express.json({ limit: "5mb" }));

// Creates the verified seller and bidder accounts before requests arrive.
initializeAuthDatabase();

// Redis remains the authoritative store for all live auction state.
const redis = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

let siegeRunning = false;
let siegeEventSampleCounter = 0;
let acceptedRequestIds = new Set();

let invariantState = {
  highestNeverDecreased: true,
  duplicateAcceptances: 0,
  orderedSequences: true,
  invalidAcceptances: 0,
  checkedDecisions: 0,
  lastHighest: 0,
  lastSequence: 0,
  minimumIncrement: 1,
};

// Five permanent demonstration lots keep the marketplace active for judges.
const DEMO_AUCTIONS = [
  {
    id: "demo-keyboard",
    name: "Vintage Mechanical Keyboard",
    description:
      "A restored aluminium keyboard with tactile switches and collector keycaps.",
    category: "Technology",
    startingPrice: 2500,
    minimumIncrement: 250,
    durationSeconds: 480,
    bidWindowSeconds: 35,
    sellerId: "seller-nova",
    sellerName: "Nova Collectives",
    imageUrl: "/auction-images/keyboard.webp",
  },
  {
    id: "demo-mouse",
    name: "Limited Edition Gaming Mouse",
    description:
      "A numbered lightweight release with a flawless sensor and presentation case.",
    category: "Gaming",
    startingPrice: 3200,
    minimumIncrement: 300,
    durationSeconds: 600,
    bidWindowSeconds: 40,
    sellerId: "seller-orbit",
    sellerName: "Orbit Gaming",
    imageUrl: "/auction-images/mouse.webp",
  },
  {
    id: "demo-tablet",
    name: "Signed Digital Art Tablet",
    description:
      "A professional pen display signed by its original concept-art team.",
    category: "Art",
    startingPrice: 8500,
    minimumIncrement: 500,
    durationSeconds: 720,
    bidWindowSeconds: 45,
    sellerId: "seller-canvas",
    sellerName: "Canvas House",
    imageUrl: "/auction-images/tablet.webp",
  },
  {
    id: "demo-headphones",
    name: "Studio Reference Headphones",
    description:
      "A pristine open-back reference pair supplied with balanced cables and case.",
    category: "Audio",
    startingPrice: 6000,
    minimumIncrement: 400,
    durationSeconds: 540,
    bidWindowSeconds: 35,
    sellerId: "seller-wave",
    sellerName: "Waveform Studio",
    imageUrl: "/auction-images/headphones.webp",
  },
  {
    id: "demo-camera",
    name: "Classic Street Photography Camera",
    description:
      "A serviced rangefinder-style camera with a fast prime lens and leather case.",
    category: "Collectibles",
    startingPrice: 12000,
    minimumIncrement: 750,
    durationSeconds: 660,
    bidWindowSeconds: 45,
    sellerId: "seller-frame",
    sellerName: "Frame Archive",
    imageUrl: "/auction-images/camera.webp",
  },
];

// Clearly named simulated bidders create visible activity during judge demos.
const DEMO_BIDDERS = [
  { id: "demo-bot-mira", name: "Demo Bot · Mira" },
  { id: "demo-bot-aryan", name: "Demo Bot · Aryan" },
  { id: "demo-bot-zoya", name: "Demo Bot · Zoya" },
  { id: "demo-bot-kabir", name: "Demo Bot · Kabir" },
  { id: "demo-bot-isha", name: "Demo Bot · Isha" },
];

let demoBidCursor = 0;

redis.on("error", (error) => {
  console.error("Redis error:", error);
});

/**
 * Creates the Redis key containing one auction's item configuration.
 */
function itemKey(auctionId) {
  return `auction:item:${auctionId}`;
}

/**
 * Creates the Redis key containing one auction's highest-bid state.
 */
function bidKey(auctionId) {
  return `auction:bid:${auctionId}`;
}

/**
 * Creates the replay-protection key for one auction.
 */
function processedRequestsKey(auctionId) {
  return `auction:processed:${auctionId}`;
}

/**
 * Creates the set key containing every bidder who joined an auction.
 */
function participantIndexKey(auctionId) {
  return `auction:participants:${auctionId}`;
}

/**
 * Creates the Redis key containing one bidder's participation deadline.
 */
function participantKey(auctionId, bidderId) {
  return `auction:participant:${auctionId}:${bidderId}`;
}

/**
 * Converts Redis string values into a frontend-safe auction item.
 */
function normalizeItem(item) {
  if (!item?.id) {
    return null;
  }

  return {
    ...item,
    startingPrice: Number(item.startingPrice || 0),
    minimumIncrement: Number(item.minimumIncrement || 1),
    durationSeconds: Number(item.durationSeconds || 0),
    bidWindowSeconds: Number(item.bidWindowSeconds || 0),
    createdAt: Number(item.createdAt || 0),
    startAt: Number(item.startAt || 0),
    endAt: Number(item.endAt || 0),
    winnerAmount: Number(item.winnerAmount || 0),
  };
}

/**
 * Reads one item from Redis.
 */
async function getAuctionItem(auctionId) {
  return normalizeItem(await redis.hGetAll(itemKey(auctionId)));
}

/**
 * Reads one auction's current highest-bid state.
 */
async function getAuctionState(auctionId) {
  const state = await redis.hGetAll(bidKey(auctionId));

  return {
    auctionId,
    amount: Number(state.amount || 0),
    bidderId: state.bidderId || null,
    bidderName: state.bidderName || null,
    requestId: state.requestId || null,
    sequence: Number(state.sequence || 0),
  };
}

/**
 * Combines item and bid state into one card-ready response.
 */
async function getAuctionView(auctionId) {
  const [item, auction] = await Promise.all([
    getAuctionItem(auctionId),
    getAuctionState(auctionId),
  ]);

  if (!item) {
    return null;
  }

  return {
    ...item,
    auction,
    remainingMs: Math.max(0, item.endAt - Date.now()),
    nextMinimumBid: auction.amount + item.minimumIncrement,
  };
}

/**
 * Lists every stored auction, optionally restricting results by status.
 */
async function listAuctions(status = null) {
  const auctionIds = await redis.sMembers("auctions:index");
  const auctions = await Promise.all(auctionIds.map(getAuctionView));

  return auctions
    .filter(Boolean)
    .filter((auction) => !status || auction.status === status)
    .sort((first, second) => first.endAt - second.endAt);
}

/**
 * Creates a new per-item auction and its independent bid state.
 */
async function createAuctionRecord({
  id = crypto.randomUUID(),
  name,
  description,
  category,
  startingPrice,
  minimumIncrement,
  durationSeconds,
  bidWindowSeconds,
  sellerId,
  sellerName,
  imageUrl = "",
}) {
  const now = Date.now();
  const endAt = now + durationSeconds * 1000;

  await redis.sAdd("auctions:index", id);

  await redis.hSet(itemKey(id), {
    id,
    name,
    description,
    category,
    startingPrice: String(startingPrice),
    minimumIncrement: String(minimumIncrement),
    durationSeconds: String(durationSeconds),
    bidWindowSeconds: String(bidWindowSeconds),
    sellerId,
    sellerName,
    imageUrl,
    status: "open",
    createdAt: String(now),
    startAt: String(now),
    endAt: String(endAt),
    winnerId: "",
    winnerName: "",
    winnerAmount: "0",
  });

  await redis.del(
    bidKey(id),
    processedRequestsKey(id),
    participantIndexKey(id),
  );

  await redis.hSet(bidKey(id), {
    amount: String(startingPrice),
    bidderId: "",
    bidderName: "",
    requestId: "",
    sequence: "0",
  });

  return getAuctionView(id);
}

/**
 * Seeds multiple sellers and listings so judges immediately see a marketplace.
 */
async function seedDemoAuctions() {
  await Promise.all(DEMO_AUCTIONS.map(createAuctionRecord));
}

/**
 * Restores demo listings whenever no open auctions remain.
 */
async function ensureDemoAuctions() {
  for (const demoAuction of DEMO_AUCTIONS) {
    const existing = await getAuctionItem(demoAuction.id);

    if (
      !existing ||
      existing.status !== "open" ||
      existing.endAt <= Date.now() ||
      existing.imageUrl !== demoAuction.imageUrl
    ) {
      await createAuctionRecord(demoAuction);
    }
  }
}

/**
 * Resets server-side correctness proof tracking for a siege target.
 */
function resetInvariantState(startingAmount = 0, minimumIncrement = 1) {
  acceptedRequestIds = new Set();

  invariantState = {
    highestNeverDecreased: true,
    duplicateAcceptances: 0,
    orderedSequences: true,
    invalidAcceptances: 0,
    checkedDecisions: 0,
    lastHighest: Number(startingAmount),
    lastSequence: 0,
    minimumIncrement: Number(minimumIncrement),
  };
}

/**
 * Evaluates every siege decision against serialization invariants.
 */
function evaluateInvariants(decision) {
  invariantState.checkedDecisions += 1;

  if (decision.accepted) {
    if (decision.highestBid < invariantState.lastHighest) {
      invariantState.highestNeverDecreased = false;
    }

    if (decision.sequence <= invariantState.lastSequence) {
      invariantState.orderedSequences = false;
    }

    if (
      !Number.isFinite(decision.submittedAmount) ||
      decision.submittedAmount <
        invariantState.lastHighest + invariantState.minimumIncrement
    ) {
      invariantState.invalidAcceptances += 1;
    }

    if (acceptedRequestIds.has(decision.requestId)) {
      invariantState.duplicateAcceptances += 1;
    }

    acceptedRequestIds.add(decision.requestId);
    invariantState.lastHighest = decision.highestBid;
    invariantState.lastSequence = decision.sequence;
  }

  return {
    ...invariantState,
    allPassed:
      invariantState.highestNeverDecreased &&
      invariantState.orderedSequences &&
      invariantState.invalidAcceptances === 0 &&
      invariantState.duplicateAcceptances === 0,
  };
}

/*
  Redis runs this script atomically. It checks the item deadline, replay ID,
  minimum increment and bidder deadline before committing the new leader.
*/
const processBidScript = `
  local itemStatus = redis.call("HGET", KEYS[3], "status")
  local currentAmount = tonumber(redis.call("HGET", KEYS[1], "amount") or "0")
  local currentSequence = tonumber(redis.call("HGET", KEYS[1], "sequence") or "0")
  local endAt = tonumber(redis.call("HGET", KEYS[3], "endAt") or "0")
  local minimumIncrement = tonumber(redis.call("HGET", KEYS[3], "minimumIncrement") or "1")
  local newAmount = tonumber(ARGV[1])
  local bidderId = ARGV[2]
  local bidderName = ARGV[3]
  local requestId = ARGV[4]
  local now = tonumber(ARGV[5])
  local isChaos = ARGV[6]

  if itemStatus ~= "open" then
    return { 0, currentAmount, "AUCTION_CLOSED", currentSequence }
  end

  if now >= endAt then
    redis.call("HSET", KEYS[3], "status", "closed")
    return { 0, currentAmount, "AUCTION_EXPIRED", currentSequence }
  end

  if redis.call("SISMEMBER", KEYS[2], requestId) == 1 then
    return { 0, currentAmount, "DUPLICATE_REQUEST", currentSequence }
  end

  redis.call("SADD", KEYS[2], requestId)

  if not newAmount or newAmount <= 0 then
    return { 0, currentAmount, "INVALID_AMOUNT", currentSequence }
  end

  if isChaos ~= "1" then
    local joinedAt = redis.call("HGET", KEYS[4], "joinedAt")
    local eliminated = redis.call("HGET", KEYS[4], "eliminated")
    local hasBid = redis.call("HGET", KEYS[4], "hasBid")
    local deadlineAt = tonumber(redis.call("HGET", KEYS[4], "deadlineAt") or "0")

    if not joinedAt then
      return { 0, currentAmount, "BIDDER_NOT_JOINED", currentSequence }
    end

    if eliminated == "1" then
      return { 0, currentAmount, "BIDDER_ELIMINATED", currentSequence }
    end

    if hasBid ~= "1" and now >= deadlineAt then
      redis.call("HSET", KEYS[4], "eliminated", "1")
      return { 0, currentAmount, "BIDDER_ELIMINATED", currentSequence }
    end
  end

  if newAmount < currentAmount + minimumIncrement then
    return { 0, currentAmount, "MINIMUM_INCREMENT_NOT_MET", currentSequence }
  end

  local sequence = redis.call("HINCRBY", KEYS[1], "sequence", 1)

  redis.call(
    "HSET",
    KEYS[1],
    "amount", newAmount,
    "bidderId", bidderId,
    "bidderName", bidderName,
    "requestId", requestId,
    "sequence", sequence
  )

  if isChaos ~= "1" then
    redis.call("HSET", KEYS[4], "hasBid", "1")
  end

  return { 1, newAmount, "ACCEPTED", sequence }
`;

/*
  Atomically closes an expired auction once and returns the final winner.
*/
const closeExpiredAuctionScript = `
  local status = redis.call("HGET", KEYS[1], "status")
  local endAt = tonumber(redis.call("HGET", KEYS[1], "endAt") or "0")
  local now = tonumber(ARGV[1])

  if status ~= "open" or now < endAt then
    return { 0 }
  end

  local amount = redis.call("HGET", KEYS[2], "amount") or "0"
  local bidderId = redis.call("HGET", KEYS[2], "bidderId") or ""
  local bidderName = redis.call("HGET", KEYS[2], "bidderName") or ""

  redis.call(
    "HSET",
    KEYS[1],
    "status", "closed",
    "winnerId", bidderId,
    "winnerName", bidderName,
    "winnerAmount", amount
  )

  return { 1, amount, bidderId, bidderName }
`;

/**
 * Lets verified bidders use /api/bid while allowing the internal swarm only
 * when it supplies the server-only chaos key.
 */
function authenticateBidAccess(request, response, next) {
  if (request.headers["x-chaos-secret"] === CHAOS_INTERNAL_SECRET) {
    request.isChaos = true;
    return next();
  }

  return authenticateToken(request, response, () => {
    if (request.user.role !== "bidder") {
      return response.status(403).json({
        accepted: false,
        reason: "BIDDER_ROLE_REQUIRED",
      });
    }

    request.isChaos = false;
    return next();
  });
}

/**
 * Closes expired auctions and eliminates bidders who never placed a valid bid.
 */
async function maintainAuctionTimers() {
  const auctionIds = await redis.sMembers("auctions:index");
  const now = Date.now();

  for (const auctionId of auctionIds) {
    const closeResult = await redis.eval(closeExpiredAuctionScript, {
      keys: [itemKey(auctionId), bidKey(auctionId)],
      arguments: [String(now)],
    });

    if (Number(closeResult[0]) === 1) {
      const auction = await getAuctionView(auctionId);

      io.emit("auction-ended", {
        auctionId,
        item: auction,
        winnerId: closeResult[2] || null,
        winnerName: closeResult[3] || null,
        winningBid: Number(closeResult[1] || 0),
        endedAt: now,
      });

      // Permanent demo lots restart immediately with fresh prices and timers.
      const demoConfiguration = DEMO_AUCTIONS.find(
        (demoAuction) => demoAuction.id === auctionId,
      );

      if (demoConfiguration) {
        const restartedAuction = await createAuctionRecord(demoConfiguration);
        io.emit("auction-restarted", restartedAuction);
      }
    }

    const bidderIds = await redis.sMembers(participantIndexKey(auctionId));

    for (const bidderId of bidderIds) {
      const key = participantKey(auctionId, bidderId);
      const participant = await redis.hGetAll(key);

      if (
        participant.joinedAt &&
        participant.hasBid !== "1" &&
        participant.eliminated !== "1" &&
        now >= Number(participant.deadlineAt || 0)
      ) {
        await redis.hSet(key, "eliminated", "1");

        io.emit("bidder-eliminated", {
          auctionId,
          bidderId,
          reason: "PARTICIPATION_DEADLINE_EXPIRED",
          eliminatedAt: now,
        });
      }
    }
  }

  // Restores any missing demo lot so at least five remain available.
  await ensureDemoAuctions();
}

/**
 * Submits one clearly labelled simulated bid every few seconds so the judge
 * dashboard shows an active market even when only one person is testing it.
 */
async function submitDemoBid() {
  if (process.env.DEMO_BIDDING_ENABLED === "false" || siegeRunning) {
    return;
  }

  const openAuctions = await listAuctions("open");

  if (!openAuctions.length) {
    return;
  }

  const auction = openAuctions[demoBidCursor % openAuctions.length];
  const demoBidder = DEMO_BIDDERS[demoBidCursor % DEMO_BIDDERS.length];
  const increaseMultiplier = 1 + (demoBidCursor % 3);
  const amount =
    auction.auction.amount +
    auction.minimumIncrement * increaseMultiplier;

  demoBidCursor += 1;

  await fetch(`http://127.0.0.1:${PORT}/api/bid`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-chaos-secret": CHAOS_INTERNAL_SECRET,
    },
    body: JSON.stringify({
      auctionId: auction.id,
      amount,
      bidderId: demoBidder.id,
      bidderName: demoBidder.name,
      requestId: `demo-bid-${Date.now()}-${demoBidCursor}`,
      attackType: "SIMULATED_DEMO_BID",
    }),
  });
}

/**
 * Validates seller input and converts it into safe numeric configuration.
 */
function validateAuctionInput(body) {
  const startingPrice = Number(body.startingPrice);
  const minimumIncrement = Number(body.minimumIncrement);
  const durationSeconds = Number(body.durationSeconds);
  const bidWindowSeconds = Number(body.bidWindowSeconds);
  const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl : "";

  // Only local demo artwork or common browser-safe image data URLs are stored.
  const imageIsValid =
    imageUrl === "" ||
    imageUrl.startsWith("/auction-images/") ||
    /^data:image\/(png|jpeg|webp);base64,/i.test(imageUrl);

  const valid =
    typeof body.name === "string" &&
    body.name.trim().length >= 3 &&
    typeof body.description === "string" &&
    body.description.trim().length >= 10 &&
    typeof body.category === "string" &&
    body.category.trim() !== "" &&
    Number.isFinite(startingPrice) &&
    startingPrice > 0 &&
    Number.isFinite(minimumIncrement) &&
    minimumIncrement > 0 &&
    Number.isFinite(durationSeconds) &&
    durationSeconds >= 30 &&
    durationSeconds <= 7200 &&
    Number.isFinite(bidWindowSeconds) &&
    bidWindowSeconds >= 10 &&
    bidWindowSeconds <= Math.min(300, durationSeconds) &&
    imageIsValid &&
    imageUrl.length <= 5_000_000;

  return {
    valid,
    values: {
      name: String(body.name || "").trim(),
      description: String(body.description || "").trim(),
      category: String(body.category || "").trim(),
      startingPrice,
      minimumIncrement,
      durationSeconds,
      bidWindowSeconds,
      imageUrl,
    },
  };
}

// Authenticates a verified user using their database credentials.
app.post("/api/auth/login", (request, response) => {
  const result = loginUser(request.body.email, request.body.password);

  return response.status(result.status).json({
    authenticated: result.success,
    message: result.message,
    token: result.token,
    user: result.user,
  });
});

// Restores a signed login session.
app.get("/api/auth/me", authenticateToken, (request, response) => {
  const user = getUserProfile(request.user.userId);

  if (!user || !user.verified) {
    return response.status(401).json({
      authenticated: false,
      message: "This user account is unavailable.",
    });
  }

  return response.json({ authenticated: true, user });
});

// Exchanges the master password for a short-lived Defence Lab token.
app.post(
  "/api/auth/defense/unlock",
  authenticateToken,
  (request, response) => {
    const result = unlockDefenseAccess(
      request.body.masterPassword,
      request.user,
    );

    return response.status(result.status).json({
      authorized: result.success,
      message: result.message,
      defenseToken: result.defenseToken,
      expiresIn: result.expiresIn,
    });
  },
);

// Verifies both normal login and secondary Defence Lab authorization.
app.get(
  "/api/auth/defense/verify",
  authenticateToken,
  authenticateDefenseAccess,
  (request, response) => {
    response.json({
      authorized: true,
      message: "Defence Lab session is valid.",
    });
  },
);

// Reports API and Redis health.
app.get("/api/health", async (request, response) => {
  response.json({
    status: "healthy",
    redis: await redis.ping(),
  });
});

// Returns every auction for the marketplace browsing screen.
app.get("/api/auctions", async (request, response) => {
  await maintainAuctionTimers();
  const status = request.query.status || null;
  response.json({ auctions: await listAuctions(status) });
});

// Returns one selected auction and its current leader.
app.get("/api/auctions/:auctionId", async (request, response) => {
  await maintainAuctionTimers();
  const auction = await getAuctionView(request.params.auctionId);

  if (!auction) {
    return response.status(404).json({ message: "Auction not found." });
  }

  return response.json(auction);
});

// Creates an auction owned by the authenticated seller.
app.post(
  "/api/auctions",
  authenticateToken,
  requireRole("seller"),
  async (request, response) => {
    const validation = validateAuctionInput(request.body);

    if (!validation.valid) {
      return response.status(400).json({
        created: false,
        reason: "INVALID_AUCTION_CONFIGURATION",
      });
    }

    const seller = getUserProfile(request.user.userId);
    const auction = await createAuctionRecord({
      ...validation.values,
      sellerId: seller.id,
      sellerName: seller.name,
    });

    io.emit("auction-created", auction);
    return response.status(201).json({ created: true, auction });
  },
);

// Lets a bidder select an auction and starts their participation countdown.
app.post(
  "/api/auctions/:auctionId/join",
  authenticateToken,
  requireRole("bidder"),
  async (request, response) => {
    const auction = await getAuctionView(request.params.auctionId);

    if (!auction || auction.status !== "open" || auction.endAt <= Date.now()) {
      return response.status(409).json({
        joined: false,
        reason: "AUCTION_NOT_OPEN",
      });
    }

    const bidder = getUserProfile(request.user.userId);
    const key = participantKey(auction.id, bidder.id);
    const existing = await redis.hGetAll(key);

    if (existing.eliminated === "1") {
      return response.status(409).json({
        joined: false,
        reason: "BIDDER_ELIMINATED",
      });
    }

    if (!existing.joinedAt) {
      const joinedAt = Date.now();
      const deadlineAt = Math.min(
        auction.endAt,
        joinedAt + auction.bidWindowSeconds * 1000,
      );

      await redis.sAdd(participantIndexKey(auction.id), bidder.id);
      await redis.hSet(key, {
        bidderId: bidder.id,
        bidderName: bidder.name,
        joinedAt: String(joinedAt),
        deadlineAt: String(deadlineAt),
        hasBid: "0",
        eliminated: "0",
      });
    }

    const participant = await redis.hGetAll(key);

    return response.json({
      joined: true,
      participant: {
        ...participant,
        joinedAt: Number(participant.joinedAt),
        deadlineAt: Number(participant.deadlineAt),
        hasBid: participant.hasBid === "1",
        eliminated: participant.eliminated === "1",
      },
      auction,
    });
  },
);

// Returns the logged-in bidder's state for one selected auction.
app.get(
  "/api/auctions/:auctionId/participation",
  authenticateToken,
  requireRole("bidder"),
  async (request, response) => {
    const participant = await redis.hGetAll(
      participantKey(request.params.auctionId, request.user.userId),
    );

    if (!participant.joinedAt) {
      return response.status(404).json({ joined: false });
    }

    return response.json({
      joined: true,
      participant: {
        ...participant,
        joinedAt: Number(participant.joinedAt),
        deadlineAt: Number(participant.deadlineAt),
        hasBid: participant.hasBid === "1",
        eliminated: participant.eliminated === "1",
      },
    });
  },
);

// Closes only an auction owned by the authenticated seller.
app.post(
  "/api/auctions/:auctionId/close",
  authenticateToken,
  requireRole("seller"),
  async (request, response) => {
    const auction = await getAuctionView(request.params.auctionId);

    if (!auction) {
      return response.status(404).json({ closed: false });
    }

    if (auction.sellerId !== request.user.userId) {
      return response.status(403).json({
        closed: false,
        reason: "NOT_AUCTION_OWNER",
      });
    }

    await redis.hSet(itemKey(auction.id), {
      status: "closed",
      winnerId: auction.auction.bidderId || "",
      winnerName: auction.auction.bidderName || "",
      winnerAmount: String(auction.auction.amount),
    });

    const closedAuction = await getAuctionView(auction.id);

    io.emit("auction-ended", {
      auctionId: auction.id,
      item: closedAuction,
      winnerId: closedAuction.winnerId || null,
      winnerName: closedAuction.winnerName || null,
      winningBid: closedAuction.winnerAmount,
      endedAt: Date.now(),
    });

    return response.json({ closed: true, auction: closedAuction });
  },
);

// Processes a human or controlled-chaos bid atomically.
app.post("/api/bid", authenticateBidAccess, async (request, response) => {
  const startedAt = performance.now();
  const {
    auctionId,
    amount,
    requestId,
    attackType = "MANUAL_BID",
  } = request.body;

  const bidderId = request.isChaos
    ? request.body.bidderId
    : request.user.userId;

  const bidderProfile = request.isChaos
    ? null
    : getUserProfile(request.user.userId);

  const bidderName = request.isChaos
    ? request.body.bidderName || request.body.bidderId
    : bidderProfile.name;

  if (
    typeof auctionId !== "string" ||
    auctionId.trim() === "" ||
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    typeof bidderId !== "string" ||
    bidderId.trim() === "" ||
    typeof requestId !== "string" ||
    requestId.trim() === ""
  ) {
    return response.status(400).json({
      accepted: false,
      reason: "INVALID_REQUEST",
    });
  }

  const item = await getAuctionItem(auctionId);

  if (!item) {
    return response.status(404).json({
      accepted: false,
      reason: "AUCTION_NOT_FOUND",
    });
  }

  const result = await redis.eval(processBidScript, {
    keys: [
      bidKey(auctionId),
      processedRequestsKey(auctionId),
      itemKey(auctionId),
      participantKey(auctionId, bidderId),
    ],
    arguments: [
      String(amount),
      bidderId.trim(),
      bidderName,
      requestId.trim(),
      String(Date.now()),
      request.isChaos ? "1" : "0",
    ],
  });

  const accepted = Number(result[0]) === 1;
  const highestBid = Number(result[1]);
  const reason = result[2];
  const sequence = Number(result[3] || 0);
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));

  const event = {
    auctionId,
    itemName: item.name,
    accepted,
    reason,
    attackType,
    submittedAmount: amount,
    highestBid,
    minimumIncrement: item.minimumIncrement,
    bidderId,
    bidderName,
    requestId,
    sequence,
    latencyMs,
    timestamp: new Date().toISOString(),
  };

  let shouldBroadcastDecision = true;

  if (request.isChaos) {
    const invariants = evaluateInvariants(event);
    siegeEventSampleCounter += 1;

    // All decisions are verified, but the visual feed samples rejected events
    // so 7,000 React updates do not freeze the judge dashboard.
    shouldBroadcastDecision =
      accepted ||
      attackType === "SIMULATED_DEMO_BID" ||
      siegeEventSampleCounter % 20 === 0;

    if (shouldBroadcastDecision) {
      io.emit("invariant-update", invariants);
    }
  }

  if (shouldBroadcastDecision) {
    io.emit("bid-decision", event);
  }

  if (accepted) {
    io.emit("auction-updated", await getAuctionView(auctionId));
  }

  return response.status(accepted ? 201 : 409).json(event);
});

// Returns the latest server-side serialization proof.
app.get("/api/invariants", (request, response) => {
  response.json({
    ...invariantState,
    allPassed:
      invariantState.highestNeverDecreased &&
      invariantState.orderedSequences &&
      invariantState.invalidAcceptances === 0 &&
      invariantState.duplicateAcceptances === 0,
  });
});

// Starts the protected controlled swarm against a selected auction.
app.post(
  "/api/siege/start",
  authenticateToken,
  authenticateDefenseAccess,
  async (request, response) => {
    if (siegeRunning) {
      return response.status(409).json({
        started: false,
        reason: "SIEGE_ALREADY_RUNNING",
      });
    }

    let auction = request.body.auctionId
      ? await getAuctionView(request.body.auctionId)
      : null;

    if (!auction || auction.status !== "open") {
      [auction] = await listAuctions("open");
    }

    if (!auction) {
      return response.status(409).json({
        started: false,
        reason: "NO_OPEN_AUCTION",
      });
    }

    const requestedTotal = Number(request.body.totalRequests) || 7000;
    const totalRequests = Math.min(Math.max(requestedTotal, 10), 7000);

    siegeRunning = true;
    siegeEventSampleCounter = 0;
    resetInvariantState(
      auction.auction.amount,
      auction.minimumIncrement,
    );

    response.status(202).json({
      started: true,
      auctionId: auction.id,
      totalRequests,
    });

    runChaosSwarm({
      apiUrl: `http://127.0.0.1:${PORT}`,
      auctionId: auction.id,
      totalRequests,
      highestBid: auction.auction.amount,
      minimumIncrement: auction.minimumIncrement,
      chaosSecret: CHAOS_INTERNAL_SECRET,
      onProgress: (statistics) => {
        io.emit("siege-progress", statistics);
      },
    })
      .then((summary) => {
        io.emit("siege-complete", summary);
      })
      .catch((error) => {
        console.error("Siege failed:", error);
        io.emit("siege-error", {
          message: "The controlled siege could not finish.",
        });
      })
      .finally(() => {
        siegeRunning = false;
      });
  },
);

/*
  Compatibility routes keep the previous frontend functional while the new
  multi-auction interface is being installed.
*/
app.get("/api/item", async (request, response) => {
  const [auction] = await listAuctions("open");
  response.json(auction || null);
});

app.get("/api/auction", async (request, response) => {
  const [auction] = await listAuctions("open");
  response.json(auction?.auction || null);
});

app.post(
  "/api/item",
  authenticateToken,
  requireRole("seller"),
  async (request, response) => {
    const adaptedBody = {
      ...request.body,
      minimumIncrement: request.body.minimumIncrement || 100,
      durationSeconds: request.body.durationSeconds || 600,
      bidWindowSeconds: request.body.bidWindowSeconds || 30,
    };

    const validation = validateAuctionInput(adaptedBody);

    if (!validation.valid) {
      return response.status(400).json({
        created: false,
        reason: "INVALID_AUCTION_CONFIGURATION",
      });
    }

    const seller = getUserProfile(request.user.userId);
    const auction = await createAuctionRecord({
      ...validation.values,
      sellerId: seller.id,
      sellerName: seller.name,
    });

    io.emit("auction-created", auction);
    return response.status(201).json({
      created: true,
      item: auction,
      auction: auction.auction,
    });
  },
);

// Connects Redis, seeds demo listings and starts the timer supervisor.
async function startServer() {
  await redis.connect();
  await ensureDemoAuctions();

  setInterval(() => {
    maintainAuctionTimers().catch((error) => {
      console.error("Auction timer error:", error);
    });
  }, 1000);

  // Creates honest, visibly labelled demo activity every four seconds.
  setInterval(() => {
    submitDemoBid().catch((error) => {
      console.error("Demo bidder error:", error);
    });
  }, 4000);

  server.listen(PORT, () => {
    console.log(`Auction API running at http://localhost:${PORT}`);
    console.log("Multi-auction timer supervisor active.");
  });
}

startServer().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});
