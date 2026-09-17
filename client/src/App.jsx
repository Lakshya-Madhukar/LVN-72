import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const API_URL = "http://localhost:3001";

/*
  App controls the auction state, bid form and real-time event feed.
  Visual polish will be added after the complete workflow is functional.
*/
function App() {
  const [auction, setAuction] = useState({
    amount: 0,
    bidderId: null,
    sequence: 0,
  });

  const [amount, setAmount] = useState("");
  const [bidderId, setBidderId] = useState("human-tester");
  const [events, setEvents] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const [message, setMessage] = useState("");

  // Stores the live progress and results of the controlled siege.
const [siege, setSiege] = useState({
  running: false,
  total: 120,
  completed: 0,
  accepted: 0,
  blocked: 0,
  failed: 0,
});

  /*
    Loads the authoritative auction state when the dashboard first opens.
  */
  async function loadAuction() {
    const response = await fetch(`${API_URL}/api/auction`);
    const data = await response.json();
    setAuction(data);
  }

  /*
    Sends a bid with a unique request ID so Redis can detect replays.
  */
  async function submitBid(event) {
    event.preventDefault();
    setMessage("");

    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setMessage("Enter a valid positive bid.");
      return;
    }

    const response = await fetch(`${API_URL}/api/bid`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: numericAmount,
        bidderId,
        requestId: crypto.randomUUID(),
      }),
    });

    const result = await response.json();

    setMessage(
      result.accepted
        ? `Bid ₹${result.submittedAmount} accepted`
        : `Blocked: ${result.reason}`,
    );

    if (result.accepted) {
      setAmount("");
    }
  }

   /*
    Requests a controlled local siege and prepares the dashboard to receive
    live progress updates through Socket.IO.
  */
  async function launchSiege() {
    setMessage("");

    setSiege({
      running: true,
      total: 120,
      completed: 0,
      accepted: 0,
      blocked: 0,
      failed: 0,
    });

    try {
      const response = await fetch(`${API_URL}/api/siege/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          totalRequests: 120,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        setSiege((current) => ({
          ...current,
          running: false,
        }));

        setMessage(result.reason || "Could not launch siege.");
      }
    } catch {
      setSiege((current) => ({
        ...current,
        running: false,
      }));

      setMessage("Could not contact the siege controller.");
    }
  }


  /*
    Resets Redis state so a fresh demonstration can begin.
  */
  async function resetAuction() {
    await fetch(`${API_URL}/api/reset`, {
      method: "POST",
    });

    setEvents([]);

    setSiege({
      running: false,
      total: 120,
      completed: 0,
      accepted: 0,
      blocked: 0,
      failed: 0,
    });

    setMessage("Auction reset");
  }

  /*
    Opens the Socket.IO connection and responds to live server events.
  */
  useEffect(() => {
    loadAuction().catch(() => {
      setMessage("Could not load the auction.");
    });

    const socket = io(API_URL);

    socket.on("connect", () => {
      setConnectionStatus("connected");
    });

    socket.on("disconnect", () => {
      setConnectionStatus("disconnected");
    });

    socket.on("bid-decision", (decision) => {
  // Keep the latest 30 decisions visible without overloading the browser.
  setEvents((currentEvents) => [
    decision,
    ...currentEvents,
  ].slice(0, 30));

  if (decision.accepted) {
    setAuction({
      amount: decision.highestBid,
      bidderId: decision.bidderId,
      sequence: decision.sequence,
    });
  }

  // Count every simulated request directly from its decision event.
  if (decision.attackType !== "MANUAL_BID") {
    setSiege((current) => {
      const completed = Math.min(
        current.completed + 1,
        current.total,
      );

      return {
        ...current,
        completed,
        accepted:
          current.accepted + (decision.accepted ? 1 : 0),
        blocked:
          current.blocked + (decision.accepted ? 0 : 1),
        running: completed < current.total,
      };
    });
  }
});

    socket.on("auction-reset", (state) => {
      setAuction(state);
    });

    // Updates the counters while requests are being processed.
    socket.on("siege-progress", (statistics) => {
      setSiege({
        ...statistics,
        running: true,
      });
    });

    // Marks the simulation as finished while preserving its final totals.
    socket.on("siege-complete", (summary) => {
      setSiege({
        ...summary,
        running: false,
      });

      setMessage("Siege completed successfully.");
    });

    // Restores the controls if the simulator encounters an error.
    socket.on("siege-error", (error) => {
      setSiege((current) => ({
        ...current,
        running: false,
      }));

      setMessage(error.message);
    });

    // Disconnect when React removes this component.
    return () => {
      socket.disconnect();
    };
  }, []);

  return (
    <main className="dashboard">
      <header className="header">
        <div>
          <p className="eyebrow">LIVE DEFENSIVE AUCTION ENGINE</p>
          <h1>Auction Under Siege</h1>
        </div>

        <span className={`connection ${connectionStatus}`}>
          {connectionStatus}
        </span>
      </header>

      <section className="hero-card">
        <p>Current highest bid</p>
        <strong>₹{auction.amount.toLocaleString()}</strong>
        <span>
          {auction.bidderId
            ? `Leader: ${auction.bidderId} · Sequence ${auction.sequence}`
            : "Waiting for the opening bid"}
        </span>
      </section>

        <section className={`siege-panel ${siege.running ? "under-attack" : ""}`}>
        <div>
          <p className="eyebrow">
            {siege.running ? "SYSTEM UNDER ATTACK" : "CHAOS BIDDER SWARM"}
          </p>

          <h2>
            {siege.running
              ? "Siege in progress"
              : "Attack simulation ready"}
          </h2>

          <p className="siege-description">
            Launch 120 controlled concurrent requests containing malicious and
            legitimate bid patterns.
          </p>
        </div>

        <button
          className="siege-button"
          type="button"
          onClick={launchSiege}
          disabled={siege.running}
        >
          {siege.running ? "Defending..." : "Launch Siege"}
        </button>

        <div className="siege-progress">
          <div
            className="siege-progress-fill"
            style={{
              width: `${
                siege.total > 0
                  ? (siege.completed / siege.total) * 100
                  : 0
              }%`,
            }}
          />
        </div>

        <div className="siege-statistics">
          <article>
            <span>Processed</span>
            <strong>
              {siege.completed}/{siege.total}
            </strong>
          </article>

          <article>
            <span>Accepted</span>
            <strong className="green">{siege.accepted}</strong>
          </article>

          <article>
            <span>Attacks blocked</span>
            <strong className="red">{siege.blocked}</strong>
          </article>

          <article>
            <span>Failed</span>
            <strong>{siege.failed}</strong>
          </article>
        </div>
      </section>

      <section className="grid">
        <form className="panel bid-form" onSubmit={submitBid}>
          <h2>Place legitimate bid</h2>

          <label>
            Bidder ID
            <input
              value={bidderId}
              onChange={(event) => setBidderId(event.target.value)}
              required
            />
          </label>

          <label>
            Bid amount
            <input
              type="number"
              min="1"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="Enter amount"
              required
            />
          </label>

          <button type="submit">Submit Atomic Bid</button>
          <button className="secondary" type="button" onClick={resetAuction}>
            Reset Auction
          </button>

          {message && <p className="message">{message}</p>}
        </form>

        <section className="panel">
          <div className="panel-heading">
            <h2>Live decision feed</h2>
            <span>{events.length} events</span>
          </div>

          <div className="feed">
            {events.length === 0 && (
              <p className="empty">Submit a bid to begin.</p>
            )}

            {events.map((decision) => (
              <article
                className={`event ${
                  decision.accepted ? "accepted" : "rejected"
                }`}
                key={`${decision.requestId}-${decision.timestamp}`}
              >
                <div>
                   <strong>
                    {decision.accepted ? "ACCEPTED" : "BLOCKED"}
                  </strong>

                  <span>
                    {decision.attackType || "MANUAL_BID"} · {decision.reason}
                  </span>
                </div>

                <div className="event-value">
                  <strong>₹{decision.submittedAmount}</strong>
                  <span>{decision.latencyMs} ms</span>
                </div>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

export default App;