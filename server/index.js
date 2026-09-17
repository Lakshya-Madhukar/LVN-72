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

// Socket.IO broadcasts auction changes to every connected dashboard.
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ["GET", "POST"],
  },
});

// Allow the React frontend to access the API.
app.use(cors({ origin: CLIENT_ORIGIN }));

// Convert incoming JSON request bodies into JavaScript objects.
app.use(express.json());

// Redis stores the authoritative auction state.
const redis = createClient({
  url: "redis://localhost:6379",
});

// Prevents multiple swarms from accidentally running simultaneously.
let siegeRunning = false;

// Log Redis failures instead of silently losing the database connection.
redis.on("error", (error) => {
  console.error("Redis error:", error);
});

/*
  This Lua script executes completely inside Redis.

  Because Redis runs the entire script atomically, two simultaneous bids
  cannot read and update the highest bid at the same time.
*/
const processBidScript = `
  local currentAmount = tonumber(redis.call("HGET", KEYS[1], "amount") or "0")
  local newAmount = tonumber(ARGV[1])
  local bidderId = ARGV[2]
  local requestId = ARGV[3]
  local processedKey = KEYS[2]

  if redis.call("SISMEMBER", processedKey, requestId) == 1 then
    return {0, currentAmount, "DUPLICATE_REQUEST"}
  end

  redis.call("SADD", processedKey, requestId)

  if newAmount <= 0 then
    return {0, currentAmount, "INVALID_AMOUNT"}
  end

  if newAmount <= currentAmount then
    return {0, currentAmount, "BID_TOO_LOW"}
  end

  local sequence = redis.call("HINCRBY", KEYS[1], "sequence", 1)

  redis.call(
    "HSET",
    KEYS[1],
    "amount", newAmount,
    "bidderId", bidderId,
    "requestId", requestId,
    "sequence", sequence
  )

  return {1, newAmount, "ACCEPTED", sequence}
`;

/*
  Reads the current auction state from Redis and converts string values
  into the correct response types.
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

// Provides a simple check that Express and Redis are both operational.
app.get("/api/health", async (request, response) => {
  const redisReply = await redis.ping();

  response.json({
    status: "healthy",
    redis: redisReply,
  });
});

// Returns the latest authoritative auction state.
app.get("/api/auction", async (request, response) => {
  const auction = await getAuctionState();
  response.json(auction);
});

/*
  Validates a bid, sends it through the atomic Lua script and broadcasts
  the decision to every connected dashboard.
*/
app.post("/api/bid", async (request, response) => {
  const startedAt = performance.now();
  const { amount, bidderId, requestId, attackType = "MANUAL_BID",} = request.body;

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

  const result = await redis.eval(processBidScript, {
    keys: ["auction:main", "auction:processed-requests"],
    arguments: [String(amount), bidderId.trim(), requestId.trim()],
  });

  const accepted = Number(result[0]) === 1;
  const highestBid = Number(result[1]);
  const reason = result[2];
  const sequence = Number(result[3] || 0);
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));

  const event = {
    attackType,
    accepted,
    reason,
    submittedAmount: amount,
    highestBid,
    bidderId,
    requestId,
    sequence,
    latencyMs,
    timestamp: new Date().toISOString(),
  };

  // Broadcast both accepted and rejected decisions for the live feed.
  io.emit("bid-decision", event);

  return response.status(accepted ? 201 : 409).json(event);
});

// Clears the demo auction so every presentation can start cleanly.
app.post("/api/reset", async (request, response) => {
  await redis.del("auction:main", "auction:processed-requests");

  const state = await getAuctionState();

  io.emit("auction-reset", state);
  response.json(state);
});

/*
  Connects to Redis before opening the HTTP server, preventing requests
  from arriving before the database is ready.
*/
async function startServer() {
  await redis.connect();

  server.listen(PORT, () => {
    console.log(`Auction API running at http://localhost:${PORT}`);
  });
}

/*
  Starts a controlled swarm against only this local API. The request count
  is capped so the demonstration cannot create uncontrolled traffic.
*/
app.post("/api/siege/start", async (request, response) => {
  if (siegeRunning) {
    return response.status(409).json({
      started: false,
      reason: "SIEGE_ALREADY_RUNNING",
    });
  }

  const requestedTotal = Number(request.body.totalRequests) || 120;
  const totalRequests = Math.min(Math.max(requestedTotal, 10), 300);
  const auction = await getAuctionState();

  siegeRunning = true;

  response.status(202).json({
    started: true,
    totalRequests,
  });

  runChaosSwarm({
    apiUrl: `http://127.0.0.1:${PORT}`,
    totalRequests,
    highestBid: auction.amount,

    // Stream progress to every connected dashboard.
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
});

// Stop immediately if startup fails.
startServer().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});