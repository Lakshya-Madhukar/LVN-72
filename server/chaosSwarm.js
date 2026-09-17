/*
  Creates one simulated bid using a rotating set of legitimate and hostile
  patterns. Every request targets a specific auction so multiple auctions can
  run safely at the same time.
*/
function createChaosBid(index, highestBid, minimumIncrement, auctionId) {
  const attackType = index % 6;
  const uniqueId = `siege-${Date.now()}-${index}`;

  switch (attackType) {
    case 0:
      return {
        auctionId,
        amount: -100,
        bidderId: `chaos-${index}`,
        requestId: uniqueId,
        attackType: "NEGATIVE_BID",
      };

    case 1:
      return {
        auctionId,
        amount: 0,
        bidderId: `chaos-${index}`,
        requestId: uniqueId,
        attackType: "ZERO_BID",
      };

    case 2:
      return {
        auctionId,
        amount: Math.max(1, highestBid - 1),
        bidderId: `chaos-${index}`,
        requestId: uniqueId,
        attackType: "BELOW_HIGHEST",
      };

    case 3:
      return {
        auctionId,
        amount: highestBid,
        bidderId: `chaos-${index}`,
        requestId: uniqueId,
        attackType: "EQUAL_HIGHEST",
      };

    case 4:
      return {
        auctionId,
        amount: highestBid + minimumIncrement + index + 1,
        bidderId: `legitimate-racer-${index}`,
        requestId: uniqueId,
        attackType: "VALID_RACE_BID",
      };

    default:
      return {
        auctionId,
        amount: highestBid + minimumIncrement,
        bidderId: `replay-${index}`,
        requestId: "replayed-request-id",
        attackType: "REPLAY_ATTACK",
      };
  }
}

/*
  Sends one simulated request to the local API. The internal key lets the
  controlled swarm use the bid engine without pretending to be a human user.
*/
async function sendChaosBid(apiUrl, bid, chaosSecret) {
  const response = await fetch(`${apiUrl}/api/bid`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-chaos-secret": chaosSecret,
    },
    body: JSON.stringify(bid),
  });

  return response.json();
}

/*
  Launches the simulated clients concurrently and reports exact progress to
  the Socket.IO dashboard after every completed request.
*/
async function runChaosSwarm({
  apiUrl,
  auctionId,
  totalRequests,
  highestBid,
  minimumIncrement,
  chaosSecret,
  onProgress,
}) {
  const statistics = {
    auctionId,
    total: totalRequests,
    completed: 0,
    accepted: 0,
    blocked: 0,
    failed: 0,
  };

  const tasks = Array.from({ length: totalRequests }, async (_, index) => {
    const bid = createChaosBid(
      index,
      highestBid,
      minimumIncrement,
      auctionId,
    );

    try {
      const decision = await sendChaosBid(apiUrl, bid, chaosSecret);

      if (decision.accepted) {
        statistics.accepted += 1;
      } else {
        statistics.blocked += 1;
      }
    } catch {
      statistics.failed += 1;
    }

    statistics.completed += 1;
    onProgress({ ...statistics });
  });

  await Promise.all(tasks);

  return {
    ...statistics,
    finishedAt: new Date().toISOString(),
  };
}

module.exports = {
  runChaosSwarm,
};
