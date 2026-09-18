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

  // The bounded pool avoids exhausting local sockets with 7,000 simultaneous
  // fetch objects while still creating heavy concurrent pressure.
  const workerCount = Math.min(350, totalRequests);
  let nextRequestIndex = 0;
  let lastProgressUpdate = 0;

  /** Publishes useful progress intervals without flooding Socket.IO. */
  function publishProgress(force = false) {
    const currentTime = Date.now();

    if (
      force ||
      statistics.completed % 50 === 0 ||
      currentTime - lastProgressUpdate >= 100
    ) {
      lastProgressUpdate = currentTime;
      onProgress({ ...statistics });
    }
  }

  /** Claims requests from the shared queue until all 7,000 are complete. */
  async function runWorker() {
    while (nextRequestIndex < totalRequests) {
      const index = nextRequestIndex;
      nextRequestIndex += 1;

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
      publishProgress();
    }
  }

  await Promise.all(
    Array.from({ length: workerCount }, () => runWorker()),
  );

  publishProgress(true);

  return {
    ...statistics,
    finishedAt: new Date().toISOString(),
  };
}

module.exports = {
  runChaosSwarm,
};
