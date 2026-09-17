/*
  Creates one simulated bid using a rotating set of legitimate and hostile
  patterns. The target URL is provided internally by our server.
*/
function createChaosBid(index, highestBid) {
  const attackType = index % 6;
  const uniqueId = `siege-${Date.now()}-${index}`;

  switch (attackType) {
    case 0:
      return {
        amount: -100,
        bidderId: `chaos-${index}`,
        requestId: uniqueId,
        attackType: "NEGATIVE_BID",
      };

    case 1:
      return {
        amount: 0,
        bidderId: `chaos-${index}`,
        requestId: uniqueId,
        attackType: "ZERO_BID",
      };

    case 2:
      return {
        amount: Math.max(1, highestBid - 1),
        bidderId: `chaos-${index}`,
        requestId: uniqueId,
        attackType: "BELOW_HIGHEST",
      };

    case 3:
      return {
        amount: highestBid,
        bidderId: `chaos-${index}`,
        requestId: uniqueId,
        attackType: "EQUAL_HIGHEST",
      };

    case 4:
      return {
        amount: highestBid + index + 1,
        bidderId: `legitimate-racer-${index}`,
        requestId: uniqueId,
        attackType: "VALID_RACE_BID",
      };

    default:
      return {
        amount: highestBid + 1,
        bidderId: `replay-${index}`,
        requestId: "replayed-request-id",
        attackType: "REPLAY_ATTACK",
      };
  }
}

/*
  Sends one simulated request to our own auction endpoint and returns the
  structured server decision even when the bid is rejected.
*/
async function sendChaosBid(apiUrl, bid) {
  const response = await fetch(`${apiUrl}/api/bid`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bid),
  });

  return response.json();
}

/*
  Launches all simulated clients concurrently and calculates the final
  accepted, blocked and failed totals.
*/
async function runChaosSwarm({
  apiUrl,
  totalRequests,
  highestBid,
  onProgress,
}) {
  const statistics = {
    total: totalRequests,
    completed: 0,
    accepted: 0,
    blocked: 0,
    failed: 0,
  };

  const tasks = Array.from({ length: totalRequests }, async (_, index) => {
    const bid = createChaosBid(index, highestBid);

    try {
      const decision = await sendChaosBid(apiUrl, bid);

      if (decision.accepted) {
        statistics.accepted += 1;
      } else {
        statistics.blocked += 1;
      }
    } catch {
      statistics.failed += 1;
    }

    statistics.completed += 1;

    // Send a copied object so later mutations do not change old events.
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