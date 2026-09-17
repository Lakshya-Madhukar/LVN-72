import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const API_URL = "http://localhost:3001";

// Returns a fresh siege state for launches and resets.
function createEmptySiege() {
  return {
    running: false,
    total: 120,
    completed: 0,
    accepted: 0,
    blocked: 0,
    failed: 0,
  };
}

// Returns a clean set of auction correctness proofs.
function createEmptyInvariants() {
  return {
    allPassed: true,
    highestNeverDecreased: true,
    duplicateAcceptances: 0,
    orderedSequences: true,
    invalidAcceptances: 0,
    checkedDecisions: 0,
  };
}

/*
  App manages both the seller and bidder demonstrations while receiving
  real-time auction events from the backend.
*/
function App() {
  const [role, setRole] = useState("bidder");
  const [item, setItem] = useState(null);

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
  const [siege, setSiege] = useState(createEmptySiege());
  const [invariants, setInvariants] = useState(createEmptyInvariants());
  
  const [sellerForm, setSellerForm] = useState({
    name: "",
    description: "",
    category: "Technology",
    startingPrice: "",
    sellerId: "seller-1",
  });

  /*
    Loads both the active item and authoritative auction state.
  */
  async function loadApplication() {
    const [
      itemResponse,
      auctionResponse,
      invariantResponse,
    ] = await Promise.all([
      fetch(`${API_URL}/api/item`),
      fetch(`${API_URL}/api/auction`),
      fetch(`${API_URL}/api/invariants`),
    ]);

    const [
      itemData,
      auctionData,
      invariantData,
    ] = await Promise.all([
      itemResponse.json(),
      auctionResponse.json(),
      invariantResponse.json(),
    ]);

    setItem(itemData);
    setAuction(auctionData);
    setInvariants(invariantData);
  }

  /*
    Updates one field in the seller form while preserving the others.
  */
  function updateSellerField(event) {
    const { name, value } = event.target;

    setSellerForm((current) => ({
      ...current,
      [name]: value,
    }));
  }

  /*
    Creates a new auction item through the seller API.
  */
  async function createItem(event) {
    event.preventDefault();
    setMessage("");

    const response = await fetch(`${API_URL}/api/item`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...sellerForm,
        startingPrice: Number(sellerForm.startingPrice),
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      setMessage(`Item rejected: ${result.reason}`);
      return;
    }

    setItem(result.item);
    setAuction(result.auction);
    setEvents([]);
    setSiege(createEmptySiege());
    setInvariants(createEmptyInvariants());
    setMessage("New auction created successfully.");

    setSellerForm((current) => ({
      ...current,
      name: "",
      description: "",
      startingPrice: "",
    }));
  }

  /*
    Sends a legitimate human bid with a unique replay-protection ID.
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
        ? `Bid ₹${result.submittedAmount.toLocaleString()} accepted`
        : `Blocked: ${result.reason}`,
    );

    if (result.accepted) {
      setAmount("");
    }
  }

  /*
    Closes the current item and prevents further bids at the Redis layer.
  */
  async function closeAuction() {
    const response = await fetch(`${API_URL}/api/item/close`, {
      method: "POST",
    });

    const result = await response.json();

    if (!response.ok) {
      setMessage(result.reason || "Could not close the auction.");
      return;
    }

    setItem(result.item);
    setAuction(result.auction);
    setMessage("Auction closed successfully.");
  }

  /*
    Launches the controlled local Chaos Bidder Swarm.
  */
  async function launchSiege() {
    setMessage("");
    setSiege({
      ...createEmptySiege(),
      running: true,
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
    Clears existing bids and reopens the current auction.
  */
  async function resetAuction() {
    const response = await fetch(`${API_URL}/api/reset`, {
      method: "POST",
    });

    const result = await response.json();

    setAuction(result.auction);
    setItem(result.item);
    setEvents([]);
    setSiege(createEmptySiege());
    setInvariants(createEmptyInvariants());
    setMessage("Auction reset successfully.");    
  }

  /*
    Opens the Socket.IO connection and subscribes to every live event used
    by the bidder, seller and siege interfaces.
  */
  useEffect(() => {
    loadApplication().catch(() => {
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
      // Render only recent events so heavy tests do not freeze the browser.
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

      // Provide immediate counter updates from the decision stream.
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

      // Receive correctness results calculated by the backend.
      socket.on("invariant-update", (proof) => {
        setInvariants(proof);
      });

      socket.on("item-created", ({ item: newItem, auction: newAuction }) => {      
      setItem(newItem);
      setAuction(newAuction);
      setEvents([]);
      setSiege(createEmptySiege());
    });

    socket.on("item-updated", (updatedItem) => {
      setItem(updatedItem);
    });

    socket.on("auction-closed", ({ item: closedItem, auction: finalState }) => {
      setItem(closedItem);
      setAuction(finalState);
    });

    socket.on("siege-progress", (statistics) => {
      setSiege({
        ...statistics,
        running: true,
      });
    });

    socket.on("siege-complete", (summary) => {
      setSiege({
        ...summary,
        running: false,
      });

      setMessage("Siege completed successfully.");
    });

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

        <div className="header-actions">
          <span className={`connection ${connectionStatus}`}>
            {connectionStatus}
          </span>

          <div className="role-switch">
            <button
              className={role === "bidder" ? "active" : ""}
              type="button"
              onClick={() => setRole("bidder")}
            >
              Bidder
            </button>

            <button
              className={role === "seller" ? "active" : ""}
              type="button"
              onClick={() => setRole("seller")}
            >
              Seller
            </button>
          </div>
        </div>
      </header>

      {item && (
        <section className="item-card">
          <div className="item-visual">
            <span>{item.category?.charAt(0) || "A"}</span>
          </div>

          <div className="item-details">
            <div className="item-meta">
              <span>{item.category}</span>

              <span className={`status-pill ${item.status}`}>
                {item.status}
              </span>
            </div>

            <h2>{item.name}</h2>
            <p>{item.description}</p>

            <div className="item-footer">
              <span>Seller: {item.sellerId}</span>
              <span>
                Starting price: ₹{item.startingPrice.toLocaleString()}
              </span>
            </div>
          </div>
        </section>
      )}

      {role === "seller" && (
        <section className="seller-layout">
          <form className="panel seller-form" onSubmit={createItem}>
            <p className="eyebrow">SELLER CONTROL</p>
            <h2>Create a new auction</h2>

            <label>
              Item name
              <input
                name="name"
                value={sellerForm.name}
                onChange={updateSellerField}
                placeholder="Example: Collector's Keyboard"
                required
              />
            </label>

            <label>
              Description
              <textarea
                name="description"
                value={sellerForm.description}
                onChange={updateSellerField}
                placeholder="Describe the item and its condition"
                required
              />
            </label>

            <label>
              Category
              <select
                name="category"
                value={sellerForm.category}
                onChange={updateSellerField}
              >
                <option>Technology</option>
                <option>Collectibles</option>
                <option>Art</option>
                <option>Fashion</option>
                <option>Gaming</option>
              </select>
            </label>

            <label>
              Starting price
              <input
                name="startingPrice"
                type="number"
                min="1"
                value={sellerForm.startingPrice}
                onChange={updateSellerField}
                placeholder="Enter starting price"
                required
              />
            </label>

            <label>
              Seller ID
              <input
                name="sellerId"
                value={sellerForm.sellerId}
                onChange={updateSellerField}
                required
              />
            </label>

            <button type="submit">Create Auction</button>
          </form>

          <section className="panel seller-status">
            <p className="eyebrow">ACTIVE AUCTION</p>
            <h2>Seller overview</h2>

            <div className="seller-price">
              <span>Current highest bid</span>
              <strong>₹{auction.amount.toLocaleString()}</strong>
            </div>

            <div className="seller-information">
              <span>
                Leader: {auction.bidderId || "No bidder yet"}
              </span>

              <span>Accepted bid sequence: {auction.sequence}</span>
            </div>

            <button
              className="danger-button"
              type="button"
              onClick={closeAuction}
              disabled={item?.status === "closed"}
            >
              {item?.status === "closed"
                ? "Auction Closed"
                : "Close Auction"}
            </button>

            <button
              className="secondary"
              type="button"
              onClick={resetAuction}
            >
              Reset and Reopen
            </button>

            {message && <p className="message">{message}</p>}
          </section>
        </section>
      )}

      {role === "bidder" && (
        <>
          <section className="hero-card">
            <p>Current highest bid</p>

            <strong>₹{auction.amount.toLocaleString()}</strong>

            <span>
              {item?.status === "closed"
                ? "Auction closed"
                : auction.bidderId
                  ? `Leader: ${auction.bidderId} · Sequence ${auction.sequence}`
                  : "Waiting for the opening bid"}
            </span>
          </section>

          <section
            className={`siege-panel ${
              siege.running ? "under-attack" : ""
            }`}
          >
            <div>
              <p className="eyebrow">
                {siege.running
                  ? "SYSTEM UNDER ATTACK"
                  : "CHAOS BIDDER SWARM"}
              </p>

              <h2>
                {siege.running
                  ? "Siege in progress"
                  : "Attack simulation ready"}
              </h2>

              <p className="siege-description">
                Launch 120 controlled concurrent requests containing
                malicious and legitimate bid patterns.
              </p>
            </div>

            <button
              className="siege-button"
              type="button"
              onClick={launchSiege}
              disabled={
                siege.running || item?.status !== "open"
              }
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
                <strong className="green">
                  {siege.accepted}
                </strong>
              </article>

              <article>
                <span>Attacks blocked</span>
                <strong className="red">
                  {siege.blocked}
                </strong>
              </article>

              <article>
                <span>Failed</span>
                <strong>{siege.failed}</strong>
              </article>
                      </div>
          </section>

          <section
            className={`invariant-shield ${
              invariants.allPassed ? "verified" : "breached"
            }`}
          >
            <div className="shield-heading">
              <div>
                <p className="eyebrow">SERVER-VERIFIED PROOF</p>
                <h2>Invariant Shield</h2>
              </div>

              <span className="shield-status">
                {invariants.allPassed
                  ? "ALL SYSTEMS VERIFIED"
                  : "INVARIANT BREACH"}
              </span>
            </div>

            <div className="invariant-grid">
              <article>
                <span>Highest bid</span>
                <strong>
                  {invariants.highestNeverDecreased
                    ? "Never decreased"
                    : "Violation found"}
                </strong>
              </article>

              <article>
                <span>Replay protection</span>
                <strong>
                  {invariants.duplicateAcceptances === 0
                    ? "Zero duplicates"
                    : `${invariants.duplicateAcceptances} failures`}
                </strong>
              </article>

              <article>
                <span>Serialization</span>
                <strong>
                  {invariants.orderedSequences
                    ? "Sequence ordered"
                    : "Order violation"}
                </strong>
              </article>

              <article>
                <span>Invalid acceptances</span>
                <strong>
                  {invariants.invalidAcceptances}
                </strong>
              </article>
            </div>

            <p className="proof-count">
              {invariants.checkedDecisions} decisions independently checked
              by the server
            </p>
          </section>

          <section className="grid">
            <form className="panel bid-form" onSubmit={submitBid}>
              <h2>Place legitimate bid</h2>

              <label>
                Bidder ID
                <input
                  value={bidderId}
                  onChange={(event) =>
                    setBidderId(event.target.value)
                  }
                  required
                />
              </label>

              <label>
                Bid amount
                <input
                  type="number"
                  min="1"
                  value={amount}
                  onChange={(event) =>
                    setAmount(event.target.value)
                  }
                  placeholder="Enter amount"
                  required
                />
              </label>

              <button
                type="submit"
                disabled={item?.status !== "open"}
              >
                {item?.status === "open"
                  ? "Submit Atomic Bid"
                  : "Auction Closed"}
              </button>

              <button
                className="secondary"
                type="button"
                onClick={resetAuction}
              >
                Reset Auction
              </button>

              {message && <p className="message">{message}</p>}
            </form>

            <section className="panel">
              <div className="panel-heading">
                <h2>Live decision feed</h2>
                <span>{events.length} recent events</span>
              </div>

              <div className="feed">
                {events.length === 0 && (
                  <p className="empty">
                    Submit a bid or launch a siege to begin.
                  </p>
                )}

                {events.map((decision) => (
                  <article
                    className={`event ${
                      decision.accepted
                        ? "accepted"
                        : "rejected"
                    }`}
                    key={`${decision.requestId}-${decision.timestamp}`}
                  >
                    <div>
                      <strong>
                        {decision.accepted
                          ? "ACCEPTED"
                          : "BLOCKED"}
                      </strong>

                      <span>
                        {decision.attackType || "MANUAL_BID"} ·{" "}
                        {decision.reason}
                      </span>
                    </div>

                    <div className="event-value">
                      <strong>
                        ₹{decision.submittedAmount.toLocaleString()}
                      </strong>

                      <span>{decision.latencyMs} ms</span>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </section>
        </>
      )}
    </main>
  );
}

export default App;