const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { createClient } = require("redis");
const { runChaosSwarm } = require("./chaosSwarm");

const PORT = 3001;
const CLIENT_ORIGIN = "http://localhost:5173";

const app = express();
const server = http.createServer(app);

// Socket.IO sends live auction events to every connected dashboard.
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ["GET", "POST"],
  },
});

// Allow requests from the local React application.
app.use(
  cors({
    origin: CLIENT_ORIGIN,
  }),
);

// Convert incoming JSON bodies into JavaScript objects.
app.use(express.json());

// Redis stores the authoritative auction and item state.
const redis = createClient({
  url: "redis://localhost:6379",
});

// Prevent multiple swarms from running simultaneously.
let siegeRunning = false;

// Display Redis connection errors instead of failing silently.
redis.on("error", (error) => {
  console.error("Redis error:", error);
});

/*
  Redis executes this complete script atomically.

  No other bid can read or modify the auction while this script is running,
  which prevents simultaneous requests from corrupting the highest bid.
*/
const processBidScript = `
  local currentAmount = tonumber(
    redis.call("HGET", KEYS[1], "amount") or "0"
  )

  local newAmount = tonumber(ARGV[1])
  local bidderId = ARGV[2]
  local requestId = ARGV[3]

  local processedKey = KEYS[2]
  local itemKey = KEYS[3]

  local auctionStatus = redis.call(
    "HGET",
    itemKey,
    "status"
  )

  if auctionStatus ~= "open" then
    return {
      0,
      currentAmount,
      "AUCTION_CLOSED"
    }
  end

  if redis.call(
    "SISMEMBER",
    processedKey,
    requestId
  ) == 1 then
    return {
      0,
      currentAmount,
      "DUPLICATE_REQUEST"
    }
  end

  redis.call(
    "SADD",
    processedKey,
    requestId
  )

  if newAmount <= 0 then
    return {
      0,
      currentAmount,
      "INVALID_AMOUNT"
    }
  end

  if newAmount <= currentAmount then
    return {
      0,
      currentAmount,
      "BID_TOO_LOW"
    }
  end

  local sequence = redis.call(
    "HINCRBY",
    KEYS[1],
    "sequence",
    1
  )

  redis.call(
    "HSET",
    KEYS[1],
    "amount", newAmount,
    "bidderId", bidderId,
    "requestId", requestId,
    "sequence", sequence
  )

  return {
    1,
    newAmount,
    "ACCEPTED",
    sequence
  }
`;

/*
  Reads the authoritative bidding state and converts Redis strings into
  useful JavaScript values.
*/
async function getAuctionState() {
  const state = await redis.hGetAll("auction:main");

  return {
    amount: Number(state.amount || 0),
    bidderId: state.bidderId || null,
    requestId: state.requestId || null,
    sequence: Number(state.sequence || 0),
  };
}

/*
  Reads the item currently being sold and converts its price into a number.
*/
async function getAuctionItem() {
  const item = await redis.hGetAll("auction:item");

  if (!item.name) {
    return null;
  }

  return {
    ...item,
    startingPrice: Number(item.startingPrice || 0),
  };
}

/*
  Creates one default item when Redis does not contain an auction item.
  This makes the project usable immediately after its first installation.
*/
async function ensureDemoItem() {
  const existingItem = await getAuctionItem();

  if (existingItem) {
    return;
  }

  await redis.hSet("auction:item", {
    name: "Vintage Mechanical Keyboard",
    description:
      "A restored mechanical keyboard offered as the opening demo auction.",
    category: "Technology",
    startingPrice: "2500",
    sellerId: "demo-seller",
    status: "open",
  });

  await redis.hSet("auction:main", {
    amount: "2500",
    bidderId: "",
    requestId: "",
    sequence: "0",
  });
}

// Confirms that both the API and Redis connection are operational.
app.get("/api/health", async (request, response) => {
  const redisReply = await redis.ping();

  response.json({
    status: "healthy",
    redis: redisReply,
  });
});

// Returns the current highest bid and winning bidder.
app.get("/api/auction", async (request, response) => {
  const auction = await getAuctionState();
  response.json(auction);
});

// Returns the item currently offered by the seller.
app.get("/api/item", async (request, response) => {
  const item = await getAuctionItem();
  response.json(item);
});

/*
  Creates a new item and resets the auction to its starting price.

  Seller IDs are demonstration labels; full login authentication is not
  needed for the hackathon version.
*/
app.post("/api/item", async (request, response) => {
  const {
    name,
    description,
    category,
    startingPrice,
    sellerId,
  } = request.body;

  const numericStartingPrice = Number(startingPrice);

  // Reject incomplete items and invalid starting prices.
  if (
    typeof name !== "string" ||
    name.trim() === "" ||
    typeof description !== "string" ||
    description.trim() === "" ||
    typeof category !== "string" ||
    category.trim() === "" ||
    typeof sellerId !== "string" ||
    sellerId.trim() === "" ||
    !Number.isFinite(numericStartingPrice) ||
    numericStartingPrice <= 0
  ) {
    return response.status(400).json({
      created: false,
      reason: "INVALID_ITEM",
    });
  }

  // Store the newly created item as the active auction.
  await redis.hSet("auction:item", {
    name: name.trim(),
    description: description.trim(),
    category: category.trim(),
    startingPrice: String(numericStartingPrice),
    sellerId: sellerId.trim(),
    status: "open",
  });

  // Remove all bids and request IDs from the previous item.
  await redis.del(
    "auction:main",
    "auction:processed-requests",
  );

  // Begin bidding at the seller's chosen starting price.
  await redis.hSet("auction:main", {
    amount: String(numericStartingPrice),
    bidderId: "",
    requestId: "",
    sequence: "0",
  });

  const item = await getAuctionItem();
  const auction = await getAuctionState();

  // Update every open dashboard with the seller's new item.
  io.emit("item-created", {
    item,
    auction,
  });

  return response.status(201).json({
    created: true,
    item,
    auction,
  });
});

/*
  Closes the active auction.

  The atomic Lua script checks this status before accepting any later bid.
*/
app.post("/api/item/close", async (request, response) => {
  const item = await getAuctionItem();

  if (!item) {
    return response.status(404).json({
      closed: false,
      reason: "ITEM_NOT_FOUND",
    });
  }

  await redis.hSet(
    "auction:item",
    "status",
    "closed",
  );

  const closedItem = await getAuctionItem();
  const auction = await getAuctionState();

  // Notify every bidder that the seller closed the auction.
  io.emit("auction-closed", {
    item: closedItem,
    auction,
  });

  return response.json({
    closed: true,
    item: closedItem,
    auction,
  });
});

/*
  Validates the request, processes it atomically in Redis and broadcasts
  the resulting decision to every connected dashboard.
*/
app.post("/api/bid", async (request, response) => {
  const startedAt = performance.now();

  const {
    amount,
    bidderId,
    requestId,
    attackType = "MANUAL_BID",
  } = request.body;

  // Reject malformed requests before they reach Redis.
  if (
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

  // Execute the atomic bid comparison inside Redis.
  const result = await redis.eval(processBidScript, {
    keys: [
      "auction:main",
      "auction:processed-requests",
      "auction:item",
    ],
    arguments: [
      String(amount),
      bidderId.trim(),
      requestId.trim(),
    ],
  });

  const accepted = Number(result[0]) === 1;
  const highestBid = Number(result[1]);
  const reason = result[2];
  const sequence = Number(result[3] || 0);

  const latencyMs = Number(
    (performance.now() - startedAt).toFixed(2),
  );

  const event = {
    accepted,
    reason,
    attackType,
    submittedAmount: amount,
    highestBid,
    bidderId,
    requestId,
    sequence,
    latencyMs,
    timestamp: new Date().toISOString(),
  };

  // Broadcast accepted and rejected decisions for the live feed.
  io.emit("bid-decision", event);

  return response
    .status(accepted ? 201 : 409)
    .json(event);
});

/*
  Resets all bids while keeping the seller's current item.

  The item is also reopened so the demonstration can be repeated.
*/
app.post("/api/reset", async (request, response) => {
  const item = await getAuctionItem();
  const startingPrice = item?.startingPrice || 0;

  await redis.del(
    "auction:main",
    "auction:processed-requests",
  );

  await redis.hSet("auction:main", {
    amount: String(startingPrice),
    bidderId: "",
    requestId: "",
    sequence: "0",
  });

  if (item) {
    await redis.hSet(
      "auction:item",
      "status",
      "open",
    );
  }

  const state = await getAuctionState();
  const reopenedItem = await getAuctionItem();

  io.emit("auction-reset", state);
  io.emit("item-updated", reopenedItem);

  return response.json({
    auction: state,
    item: reopenedItem,
  });
});

/*
  Launches a controlled swarm against only this local API.

  The capped request count prevents accidental uncontrolled traffic.
*/
app.post("/api/siege/start", async (request, response) => {
  if (siegeRunning) {
    return response.status(409).json({
      started: false,
      reason: "SIEGE_ALREADY_RUNNING",
    });
  }

  const requestedTotal =
    Number(request.body.totalRequests) || 120;

  const totalRequests = Math.min(
    Math.max(requestedTotal, 10),
    300,
  );

  const auction = await getAuctionState();

  siegeRunning = true;

  // Respond immediately while the swarm continues in the background.
  response.status(202).json({
    started: true,
    totalRequests,
  });

  runChaosSwarm({
    // This hardcoded address restricts the simulator to our local project.
    apiUrl: `http://127.0.0.1:${PORT}`,
    totalRequests,
    highestBid: auction.amount,

    // Stream exact progress statistics to every dashboard.
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
        message:
          "The controlled siege could not finish.",
      });
    })
    .finally(() => {
      siegeRunning = false;
    });
});

/*
  Connects to Redis and prepares the default item before accepting any
  HTTP requests.
*/
async function startServer() {
  await redis.connect();

  // Seed an item only when Redis has no existing item.
  await ensureDemoItem();

  server.listen(PORT, () => {
    console.log(
      `Auction API running at http://localhost:${PORT}`,
    );
  });
}

// Exit clearly if Redis or the HTTP server cannot start.
startServer().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});