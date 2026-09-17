import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useAuth } from "./AuthGate";
import "./App.css";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

/** Formats every monetary value using Indian currency notation. */
function formatCurrency(value) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

/** Converts unknown server values into safe numeric values. */
function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** Converts milliseconds into a judge-friendly countdown. */
function formatCountdown(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

/** Produces a blank controlled-siege status object. */
function emptySiege() {
  return {
    running: false,
    total: 120,
    completed: 0,
    accepted: 0,
    blocked: 0,
    failed: 0,
  };
}

/** Produces a blank server-invariant report. */
function emptyInvariants() {
  return {
    highestNeverDecreased: true,
    duplicateAcceptances: 0,
    orderedSequences: true,
    invalidAcceptances: 0,
    checkedDecisions: 0,
    allPassed: true,
  };
}

/** Extracts latency from every supported bid event shape. */
function eventLatency(event) {
  return toNumber(event.latencyMs ?? event.latency);
}

/** Extracts the submitted amount from every supported bid event shape. */
function eventAmount(event) {
  return toNumber(event.submittedAmount ?? event.amount ?? event.highestBid);
}

/** Calculates a latency percentile from a numeric collection. */
function percentile(values, targetPercentile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  const index = Math.ceil((targetPercentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/** Generates deterministic confetti pieces without adding another package. */
function Celebration({ result, onClose }) {
  const pieces = Array.from({ length: 72 }, (_, index) => ({
    id: index,
    left: `${(index * 37) % 100}%`,
    delay: `${(index % 12) * 0.07}s`,
    duration: `${2.4 + (index % 7) * 0.18}s`,
    color: ["#fbbf24", "#f97316", "#22c55e", "#60a5fa", "#f472b6"][
      index % 5
    ],
  }));

  return (
    <div className={`result-overlay ${result.type}`} role="dialog" aria-modal="true">
      {result.type === "winner" && (
        <div className="confetti-field" aria-hidden="true">
          {pieces.map((piece) => (
            <i
              key={piece.id}
              style={{
                left: piece.left,
                animationDelay: piece.delay,
                animationDuration: piece.duration,
                background: piece.color,
              }}
            />
          ))}
        </div>
      )}

      <section className="result-card">
        <span className="result-icon">
          {result.type === "winner" ? "★" : result.type === "eliminated" ? "!" : "↗"}
        </span>
        <p className="eyebrow">
          {result.type === "winner"
            ? "AUCTION WON"
            : result.type === "eliminated"
              ? "PARTICIPATION ENDED"
              : "AUCTION COMPLETED"}
        </p>
        <h2>
          {result.type === "winner"
            ? "Congratulations!"
            : result.type === "eliminated"
              ? "Bid window expired"
              : "Better luck next time"}
        </h2>
        <p>
          {result.type === "winner"
            ? `You secured ${result.itemName} for ${formatCurrency(result.amount)}.`
            : result.type === "eliminated"
              ? "You did not place a valid bid before the participation timer ended."
              : `${result.itemName} was won by another verified bidder.`}
        </p>
        <button type="button" onClick={onClose}>
          Explore other auctions
        </button>
      </section>
    </div>
  );
}

/** Displays the authenticated role-specific auction application. */
export default function App() {
  const { user, token } = useAuth();

  const [page, setPage] = useState("marketplace");
  const [auctions, setAuctions] = useState([]);
  const [selectedAuctionId, setSelectedAuctionId] = useState("");
  const [participant, setParticipant] = useState(null);
  const [bidAmount, setBidAmount] = useState("");
  const [decisions, setDecisions] = useState([]);
  const [message, setMessage] = useState("");
  const [connection, setConnection] = useState("connecting");
  const [now, setNow] = useState(Date.now());
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const [sellerForm, setSellerForm] = useState({
    name: "",
    description: "",
    category: "Technology",
    startingPrice: "",
    minimumIncrement: "",
    durationMinutes: "10",
    bidWindowSeconds: "30",
  });

  const [defenseToken, setDefenseToken] = useState(
    () => sessionStorage.getItem("auction-defense-token") || "",
  );
  const [masterPassword, setMasterPassword] = useState("");
  const [defenseError, setDefenseError] = useState("");
  const [siege, setSiege] = useState(emptySiege);
  const [invariants, setInvariants] = useState(emptyInvariants);
  const [attackFilter, setAttackFilter] = useState("latest");

  const selectedAuction = useMemo(
    () => auctions.find((auction) => auction.id === selectedAuctionId) || null,
    [auctions, selectedAuctionId],
  );

  const openAuctions = useMemo(
    () => auctions.filter((auction) => auction.status === "open"),
    [auctions],
  );

  const sellerAuctions = useMemo(
    () => auctions.filter((auction) => auction.sellerId === user.id),
    [auctions, user.id],
  );

  const validBidFeed = useMemo(
    () =>
      decisions
        .filter(
          (decision) =>
            decision.accepted && decision.auctionId === selectedAuctionId,
        )
        .slice(0, 12),
    [decisions, selectedAuctionId],
  );

  /** Creates standard authenticated API headers. */
  function authHeaders(json = false) {
    const headers = { Authorization: `Bearer ${token}` };
    if (json) headers["Content-Type"] = "application/json";
    return headers;
  }

  /** Creates double-authorized Defence Lab headers. */
  function defenseHeaders(json = false, overrideToken = defenseToken) {
    const headers = {
      Authorization: `Bearer ${token}`,
      "x-defense-token": overrideToken,
    };
    if (json) headers["Content-Type"] = "application/json";
    return headers;
  }

  /** Adds or replaces one auction without disturbing the others. */
  function upsertAuction(updatedAuction) {
    if (!updatedAuction?.id) return;
    setAuctions((current) => {
      const exists = current.some((auction) => auction.id === updatedAuction.id);
      return exists
        ? current.map((auction) =>
            auction.id === updatedAuction.id ? updatedAuction : auction,
          )
        : [...current, updatedAuction].sort((a, b) => a.endAt - b.endAt);
    });
  }

  /** Loads every auction card from the new marketplace endpoint. */
  async function loadAuctions() {
    try {
      const response = await fetch(`${API_URL}/api/auctions`);
      const data = await response.json();
      if (response.ok) setAuctions(data.auctions || []);
    } catch {
      setMessage("The marketplace server is unavailable.");
    }
  }

  /** Loads the latest correctness report for Defence Lab. */
  async function loadInvariants() {
    try {
      const response = await fetch(`${API_URL}/api/invariants`);
      if (response.ok) setInvariants(await response.json());
    } catch {
      setDefenseError("Invariant report unavailable.");
    }
  }

  useEffect(() => {
    loadAuctions();
    const clock = setInterval(() => setNow(Date.now()), 250);
    const refresh = setInterval(loadAuctions, 10000);
    return () => {
      clearInterval(clock);
      clearInterval(refresh);
    };
  }, []);

  useEffect(() => {
    const socket = io(API_URL, { transports: ["websocket", "polling"] });

    function handleDecision(decision) {
      const normalized = {
        ...decision,
        latencyMs: eventLatency(decision),
        submittedAmount: eventAmount(decision),
        receivedAt: decision.timestamp || new Date().toISOString(),
      };
      setDecisions((current) => [normalized, ...current].slice(0, 400));
    }

    function handleAuctionUpdate(auction) {
      upsertAuction(auction);
    }

    function handleAuctionEnded(event) {
      if (event.item) upsertAuction(event.item);

      if (
        user.role === "bidder" &&
        event.auctionId === selectedAuctionId &&
        participant
      ) {
        setResult({
          type: event.winnerId === user.id ? "winner" : "lost",
          itemName: event.item?.name || "the selected item",
          amount: event.winningBid,
        });
      }
    }

    function handleElimination(event) {
      if (event.bidderId === user.id && event.auctionId === selectedAuctionId) {
        setParticipant((current) =>
          current ? { ...current, eliminated: true } : current,
        );
        setResult({
          type: "eliminated",
          itemName: selectedAuction?.name || "this auction",
          amount: 0,
        });
      }
    }

    function handleSiegeProgress(progress) {
      setSiege({
        running: true,
        total: toNumber(progress.total),
        completed: toNumber(progress.completed),
        accepted: toNumber(progress.accepted),
        blocked: toNumber(progress.blocked),
        failed: toNumber(progress.failed),
      });
    }

    function handleSiegeComplete(summary) {
      setSiege({
        running: false,
        total: toNumber(summary.total),
        completed: toNumber(summary.completed),
        accepted: toNumber(summary.accepted),
        blocked: toNumber(summary.blocked),
        failed: toNumber(summary.failed),
      });
      loadInvariants();
    }

    socket.on("connect", () => setConnection("live"));
    socket.on("disconnect", () => setConnection("offline"));
    socket.on("bid-decision", handleDecision);
    socket.on("auction-created", handleAuctionUpdate);
    socket.on("auction-updated", handleAuctionUpdate);
    socket.on("auction-ended", handleAuctionEnded);
    socket.on("bidder-eliminated", handleElimination);
    socket.on("demo-auctions-refreshed", (event) =>
      setAuctions(event.auctions || []),
    );
    socket.on("invariant-update", setInvariants);
    socket.on("siege-progress", handleSiegeProgress);
    socket.on("siege-complete", handleSiegeComplete);
    socket.on("siege-error", () =>
      setSiege((current) => ({ ...current, running: false })),
    );

    return () => socket.disconnect();
  }, [participant, selectedAuction, selectedAuctionId, user.id, user.role]);

  /** Selects an auction and starts a verified bidder's bid deadline. */
  async function selectAuction(auction) {
    setSelectedAuctionId(auction.id);
    setMessage("");
    setResult(null);

    if (user.role !== "bidder") return;

    setBusy(true);
    try {
      const response = await fetch(`${API_URL}/api/auctions/${auction.id}/join`, {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({}),
      });
      const data = await response.json();

      if (!response.ok) {
        setParticipant(null);
        setMessage(
          data.reason === "BIDDER_ELIMINATED"
            ? "You were already eliminated from this auction."
            : "This auction is no longer open.",
        );
        return;
      }

      setParticipant(data.participant);
      upsertAuction(data.auction);
      setBidAmount(String(data.auction.nextMinimumBid));
    } catch {
      setMessage("Unable to enter this auction.");
    } finally {
      setBusy(false);
    }
  }

  /** Submits an authenticated atomic bid to the selected auction. */
  async function submitBid(event) {
    event.preventDefault();
    if (!selectedAuction || !participant || participant.eliminated) return;

    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`${API_URL}/api/bid`, {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({
          auctionId: selectedAuction.id,
          amount: toNumber(bidAmount),
          requestId: crypto.randomUUID(),
          attackType: "MANUAL_BID",
        }),
      });
      const decision = await response.json();

      if (!response.ok) {
        setMessage(`Bid blocked: ${decision.reason || "REJECTED"}`);
        return;
      }

      setParticipant((current) => ({ ...current, hasBid: true }));
      setBidAmount(
        String(decision.highestBid + selectedAuction.minimumIncrement),
      );
      setMessage("Bid accepted and serialized successfully.");
    } catch {
      setMessage("The bid could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  /** Creates a multi-item auction with seller-controlled timing and increments. */
  async function createAuction(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");

    try {
      const response = await fetch(`${API_URL}/api/auctions`, {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({
          name: sellerForm.name,
          description: sellerForm.description,
          category: sellerForm.category,
          startingPrice: toNumber(sellerForm.startingPrice),
          minimumIncrement: toNumber(sellerForm.minimumIncrement),
          durationSeconds: toNumber(sellerForm.durationMinutes) * 60,
          bidWindowSeconds: toNumber(sellerForm.bidWindowSeconds),
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        setMessage(data.reason || "Auction configuration was rejected.");
        return;
      }

      upsertAuction(data.auction);
      setSellerForm({
        name: "",
        description: "",
        category: "Technology",
        startingPrice: "",
        minimumIncrement: "",
        durationMinutes: "10",
        bidWindowSeconds: "30",
      });
      setMessage("Auction published to the live marketplace.");
    } catch {
      setMessage("Unable to publish the auction.");
    } finally {
      setBusy(false);
    }
  }

  /** Closes an auction owned by the signed-in seller. */
  async function closeAuction(auctionId) {
    setBusy(true);
    try {
      const response = await fetch(`${API_URL}/api/auctions/${auctionId}/close`, {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({}),
      });
      const data = await response.json();
      if (response.ok) upsertAuction(data.auction);
      else setMessage(data.reason || "Unable to close this auction.");
    } finally {
      setBusy(false);
    }
  }

  /** Opens Defence Lab only after verifying its second security token. */
  async function openDefense() {
    setDefenseError("");
    if (!defenseToken) {
      setPage("defense-lock");
      return;
    }

    try {
      const response = await fetch(`${API_URL}/api/auth/defense/verify`, {
        headers: defenseHeaders(),
      });
      if (!response.ok) throw new Error("expired");
      setPage("defense");
      loadInvariants();
    } catch {
      sessionStorage.removeItem("auction-defense-token");
      setDefenseToken("");
      setPage("defense-lock");
    }
  }

  /** Unlocks Defence Lab using its master password. */
  async function unlockDefense(event) {
    event.preventDefault();
    setBusy(true);
    setDefenseError("");
    try {
      const response = await fetch(`${API_URL}/api/auth/defense/unlock`, {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({ masterPassword }),
      });
      const data = await response.json();
      if (!response.ok) {
        setDefenseError(data.message || "Master authorization rejected.");
        return;
      }

      sessionStorage.setItem("auction-defense-token", data.defenseToken);
      setDefenseToken(data.defenseToken);
      setMasterPassword("");
      setPage("defense");
      loadInvariants();
    } catch {
      setDefenseError("The authorization server is unavailable.");
    } finally {
      setBusy(false);
    }
  }

  /** Launches the controlled swarm against the currently selected auction. */
  async function launchSiege() {
    const target = selectedAuction?.status === "open" ? selectedAuction : openAuctions[0];
    if (!target || siege.running) return;

    setDecisions([]);
    setInvariants(emptyInvariants());
    setSiege({ ...emptySiege(), running: true });

    try {
      const response = await fetch(`${API_URL}/api/siege/start`, {
        method: "POST",
        headers: defenseHeaders(true),
        body: JSON.stringify({ auctionId: target.id, totalRequests: 120 }),
      });
      if (!response.ok) {
        const data = await response.json();
        setDefenseError(data.reason || "Unable to start siege.");
        setSiege((current) => ({ ...current, running: false }));
      }
    } catch {
      setDefenseError("Chaos Bidder Swarm could not reach the server.");
      setSiege((current) => ({ ...current, running: false }));
    }
  }

  const latencyMetrics = useMemo(() => {
    const values = decisions.map(eventLatency);
    const average = values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : 0;
    return {
      average,
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      maximum: values.length ? Math.max(...values) : 0,
    };
  }, [decisions]);

  const chartData = useMemo(
    () =>
      decisions
        .slice(0, 70)
        .reverse()
        .map((decision, index) => ({
          request: index + 1,
          latency: eventLatency(decision),
        })),
    [decisions],
  );

  const filteredDecisions = useMemo(() => {
    const events = [...decisions];
    if (attackFilter === "slowest") {
      return events
        .filter((event) => !event.accepted)
        .sort((a, b) => eventLatency(b) - eventLatency(a))
        .slice(0, 10);
    }
    if (attackFilter === "fastest") {
      return events.sort((a, b) => eventLatency(a) - eventLatency(b)).slice(0, 25);
    }
    if (attackFilter === "highest-invalid") {
      return events
        .filter((event) => !event.accepted)
        .sort((a, b) => eventAmount(b) - eventAmount(a))
        .slice(0, 25);
    }
    if (attackFilter === "blocked") return events.filter((event) => !event.accepted).slice(0, 30);
    if (attackFilter === "accepted") return events.filter((event) => event.accepted).slice(0, 30);
    return events.slice(0, 30);
  }, [attackFilter, decisions]);

  const auctionRemaining = selectedAuction ? selectedAuction.endAt - now : 0;
  const participationRemaining = participant
    ? participant.deadlineAt - now
    : 0;

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => setPage("marketplace")}>
          <b>A</b>
          <span><strong>Auction Under Siege</strong><small>Verified atomic marketplace</small></span>
        </button>

        <nav>
          <button className={page === "marketplace" ? "active" : ""} type="button" onClick={() => setPage("marketplace")}>
            {user.role === "seller" ? "Seller Studio" : "Marketplace"}
          </button>
          <button className={page.startsWith("defense") ? "active danger" : "danger"} type="button" onClick={openDefense}>
            Defence Lab <small>{defenseToken ? "Unlocked" : "Master lock"}</small>
          </button>
        </nav>

        <div className="connection"><i className={connection} /><span>{connection === "live" ? "Live network" : "Reconnecting"}</span></div>
      </header>

      {page === "marketplace" && (
        <main className="market-page">
          <section className="market-hero">
            <div>
              <p className="eyebrow">{user.role.toUpperCase()} EXPERIENCE</p>
              <h1>{user.role === "seller" ? "Create desire. Control every detail." : "Rare finds. One decisive bid."}</h1>
              <p>{user.role === "seller" ? "Launch timed listings with protected increments and watch the market react live." : "Explore verified auctions, enter an item room and compete through an atomic bid engine."}</p>
            </div>
            <div className="hero-stats">
              <div><strong>{openAuctions.length}</strong><span>Live auctions</span></div>
              <div><strong>{decisions.filter((event) => event.accepted).length}</strong><span>Live valid bids</span></div>
              <div><strong>0</strong><span>Invalid acceptances</span></div>
            </div>
          </section>

          {message && <div className="notice">{message}</div>}

          {user.role === "seller" ? (
            <>
              <section className="seller-layout">
                <form className="glass-card create-card" onSubmit={createAuction}>
                  <div className="section-title"><div><p className="eyebrow">NEW LISTING</p><h2>Publish an auction</h2></div><span>Seller verified</span></div>
                  <label><span>Item name</span><input value={sellerForm.name} onChange={(event) => setSellerForm((form) => ({ ...form, name: event.target.value }))} placeholder="Collector mechanical keyboard" required /></label>
                  <label><span>Description</span><textarea rows="4" value={sellerForm.description} onChange={(event) => setSellerForm((form) => ({ ...form, description: event.target.value }))} placeholder="Condition, provenance and included accessories..." required /></label>
                  <div className="form-grid">
                    <label><span>Category</span><select value={sellerForm.category} onChange={(event) => setSellerForm((form) => ({ ...form, category: event.target.value }))}><option>Technology</option><option>Gaming</option><option>Art</option><option>Audio</option><option>Collectibles</option></select></label>
                    <label><span>Starting price</span><input type="number" min="1" value={sellerForm.startingPrice} onChange={(event) => setSellerForm((form) => ({ ...form, startingPrice: event.target.value }))} placeholder="2500" required /></label>
                    <label><span>Minimum bid increase</span><input type="number" min="1" value={sellerForm.minimumIncrement} onChange={(event) => setSellerForm((form) => ({ ...form, minimumIncrement: event.target.value }))} placeholder="250" required /></label>
                    <label><span>Auction duration (minutes)</span><input type="number" min="1" max="120" value={sellerForm.durationMinutes} onChange={(event) => setSellerForm((form) => ({ ...form, durationMinutes: event.target.value }))} required /></label>
                    <label><span>Bidder first-bid limit (seconds)</span><input type="number" min="10" max="300" value={sellerForm.bidWindowSeconds} onChange={(event) => setSellerForm((form) => ({ ...form, bidWindowSeconds: event.target.value }))} required /></label>
                  </div>
                  <button className="primary" disabled={busy}>Publish secure auction</button>
                </form>

                <section className="glass-card seller-listings">
                  <div className="section-title"><div><p className="eyebrow">YOUR INVENTORY</p><h2>Seller control</h2></div><strong>{sellerAuctions.length}</strong></div>
                  <div className="compact-list">
                    {sellerAuctions.length ? sellerAuctions.map((auction) => (
                      <article key={auction.id}>
                        <div><small>{auction.category}</small><h3>{auction.name}</h3><p>{formatCurrency(auction.auction.amount)} · +{formatCurrency(auction.minimumIncrement)}</p></div>
                        <div className="compact-actions"><span>{formatCountdown(auction.endAt - now)}</span><button type="button" disabled={busy || auction.status !== "open"} onClick={() => closeAuction(auction.id)}>{auction.status === "open" ? "Close" : "Closed"}</button></div>
                      </article>
                    )) : <div className="empty-state"><b>+</b><h3>No seller listings yet</h3><p>Your first auction will appear here.</p></div>}
                  </div>
                </section>
              </section>

              <section className="market-section">
                <div className="market-heading"><div><p className="eyebrow">LIVE MARKET OVERVIEW</p><h2>All verified sellers</h2></div><span>{openAuctions.length} active</span></div>
                <div className="auction-grid">{openAuctions.map((auction) => <AuctionCard key={auction.id} auction={auction} now={now} onSelect={selectAuction} label="Inspect listing" />)}</div>
              </section>
            </>
          ) : (
            <>
              {!selectedAuction ? (
                <section className="market-section">
                  <div className="market-heading"><div><p className="eyebrow">CURATED LIVE LOTS</p><h2>Select an auction room</h2></div><span>Selecting starts your first-bid timer</span></div>
                  <div className="auction-grid">{openAuctions.map((auction) => <AuctionCard key={auction.id} auction={auction} now={now} onSelect={selectAuction} label={busy ? "Entering..." : "Enter auction"} />)}</div>
                </section>
              ) : (
                <section className="bid-room">
                  <button className="back-button" type="button" onClick={() => { setSelectedAuctionId(""); setParticipant(null); setMessage(""); }}>← All auctions</button>
                  <div className="bid-room-grid">
                    <article className="lot-showcase glass-card">
                      <div className="lot-art"><span>{selectedAuction.category}</span><b>{selectedAuction.name.charAt(0)}</b><small>Verified by {selectedAuction.sellerName}</small></div>
                      <div className="lot-copy"><p className="eyebrow">LIVE LOT</p><h2>{selectedAuction.name}</h2><p>{selectedAuction.description}</p><div className="lot-details"><div><span>Auction closes in</span><strong>{formatCountdown(auctionRemaining)}</strong></div><div><span>Minimum increase</span><strong>{formatCurrency(selectedAuction.minimumIncrement)}</strong></div><div><span>Seller</span><strong>{selectedAuction.sellerName}</strong></div></div></div>
                    </article>

                    <article className="bid-panel glass-card">
                      <p className="eyebrow">ATOMIC BID CONSOLE</p>
                      <div className="current-price"><span>Current leader</span><strong>{formatCurrency(selectedAuction.auction.amount)}</strong><small>{selectedAuction.auction.bidderName || "Opening price"}</small></div>

                      {!participant?.hasBid && !participant?.eliminated && (
                        <div className={`participation-timer ${participationRemaining < 10000 ? "urgent" : ""}`}><span>Place one valid bid within</span><strong>{formatCountdown(participationRemaining)}</strong><small>or you will be eliminated from this item</small></div>
                      )}

                      {participant?.hasBid && <div className="qualified">✓ Participation secured for this auction</div>}
                      {participant?.eliminated && <div className="eliminated">Participation window expired</div>}

                      <form onSubmit={submitBid}>
                        <label><span>Your next bid</span><input type="number" min={selectedAuction.nextMinimumBid} value={bidAmount} onChange={(event) => setBidAmount(event.target.value)} disabled={participant?.eliminated || selectedAuction.status !== "open"} required /></label>
                        <button className="primary" disabled={busy || participant?.eliminated || selectedAuction.status !== "open"}>Submit atomic bid</button>
                      </form>
                    </article>
                  </div>

                  <section className="glass-card live-bids">
                    <div className="market-heading"><div><p className="eyebrow">REAL-TIME ACTIVITY</p><h2>Valid bids completed</h2></div><span className="live-dot">Live</span></div>
                    <div className="bid-feed">
                      {validBidFeed.length ? validBidFeed.map((bid, index) => (
                        <article key={bid.requestId || index}><i>✓</i><div><strong>{bid.bidderName || bid.bidderId}</strong><span>Atomic sequence #{bid.sequence}</span></div><b>{formatCurrency(bid.highestBid)}</b><small>{eventLatency(bid).toFixed(2)} ms</small></article>
                      )) : <div className="empty-feed">The first accepted bid will appear here instantly.</div>}
                    </div>
                  </section>
                </section>
              )}
            </>
          )}
        </main>
      )}

      {page === "defense-lock" && (
        <main className="defense-lock">
          <section><div className="shield">AUS</div><p className="eyebrow red">RESTRICTED SYSTEM</p><h1>Defence Lab</h1><p>Live adversarial testing requires verified identity and secondary master authorization.</p></section>
          <form className="glass-card unlock-card" onSubmit={unlockDefense}><span>Level 2 clearance</span><h2>Unlock attack controls</h2><p>The defence token expires automatically after 30 minutes.</p><label><span>Master password</span><input type="password" value={masterPassword} onChange={(event) => setMasterPassword(event.target.value)} placeholder="Enter master password" required /></label>{defenseError && <div className="error-box">{defenseError}</div>}<button className="primary" disabled={busy}>Authorize Defence Lab</button><button className="text-button" type="button" onClick={() => setPage("marketplace")}>Return to marketplace</button></form>
        </main>
      )}

      {page === "defense" && (
        <main className="defense-page">
          <section className="defense-heading"><div><p className="eyebrow red">SECURITY OPERATIONS</p><h1>Defence Lab</h1><p>Observe hostile traffic collide with atomic serialization.</p></div><button type="button" onClick={() => { sessionStorage.removeItem("auction-defense-token"); setDefenseToken(""); setPage("marketplace"); }}>Lock laboratory</button></section>

          {defenseError && <div className="notice danger-notice">{defenseError}</div>}

          <section className={`siege-card ${siege.running ? "under-attack" : ""}`}><div><p className="eyebrow red">{siege.running ? "SYSTEM UNDER ATTACK" : "CHAOS BIDDER SWARM"}</p><h2>{siege.running ? "Defending in real time" : "Pressure-test the live auction"}</h2><p>120 malicious and legitimate requests target an active item concurrently.</p></div><button type="button" onClick={launchSiege} disabled={siege.running}>{siege.running ? "Defending..." : "Launch controlled attack"}</button><div className="progress"><i style={{ width: `${siege.total ? (siege.completed / siege.total) * 100 : 0}%` }} /></div><div className="siege-stats"><div><span>Processed</span><strong>{siege.completed}/{siege.total}</strong></div><div><span>Accepted</span><strong className="green">{siege.accepted}</strong></div><div><span>Blocked</span><strong className="red">{siege.blocked}</strong></div><div><span>Failed</span><strong>{siege.failed}</strong></div></div></section>

          <section className="telemetry-grid">
            <article className="glass-card invariant-panel"><div className="section-title"><div><p className="eyebrow">INTEGRITY SHIELD</p><h2>Invariant proof</h2></div><span className={invariants.allPassed ? "pass" : "fail"}>{invariants.allPassed ? "Protected" : "Violation"}</span></div><div className="invariant-list"><div><span>Highest never decreased</span><b>{invariants.highestNeverDecreased ? "PASS" : "FAIL"}</b></div><div><span>Duplicate acceptances</span><b>{invariants.duplicateAcceptances}</b></div><div><span>Invalid acceptances</span><b>{invariants.invalidAcceptances}</b></div><div><span>Sequences ordered</span><b>{invariants.orderedSequences ? "PASS" : "FAIL"}</b></div></div></article>
            <article className="glass-card latency-panel"><div className="section-title"><div><p className="eyebrow">LATENCY TELEMETRY</p><h2>Request performance</h2></div><span className="live-dot">Live</span></div><div className="metric-row"><div><span>Average</span><b>{latencyMetrics.average.toFixed(2)} ms</b></div><div><span>P50</span><b>{latencyMetrics.p50.toFixed(2)} ms</b></div><div><span>P95</span><b>{latencyMetrics.p95.toFixed(2)} ms</b></div><div><span>Maximum</span><b>{latencyMetrics.maximum.toFixed(2)} ms</b></div></div><div className="chart"><ResponsiveContainer width="100%" height={220}><LineChart data={chartData}><CartesianGrid stroke="rgba(255,255,255,.06)" vertical={false} /><XAxis dataKey="request" hide /><YAxis stroke="#65656f" tick={{ fontSize: 10 }} width={36} /><Tooltip contentStyle={{ background: "#101012", border: "1px solid #333", borderRadius: 10 }} /><Line type="monotone" dataKey="latency" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false} /></LineChart></ResponsiveContainer></div></article>
          </section>

          <section className="glass-card intelligence"><div className="market-heading"><div><p className="eyebrow">ATTACK INTELLIGENCE</p><h2>Decision inspection</h2></div><span>{filteredDecisions.length} shown · {decisions.length} retained</span></div><div className="filters">{[["latest","Latest"],["slowest","Top 10 slowest"],["fastest","Fastest"],["highest-invalid","Highest invalid"],["blocked","Blocked"],["accepted","Accepted"]].map(([value,label]) => <button className={attackFilter === value ? "active" : ""} type="button" key={value} onClick={() => setAttackFilter(value)}>{label}</button>)}</div><div className="event-table"><div className="event-head"><span>Decision</span><span>Pattern</span><span>Auction</span><span>Amount</span><span>Latency</span></div>{filteredDecisions.length ? filteredDecisions.map((event, index) => <div className={`event-row ${event.accepted ? "accepted" : "blocked"}`} key={event.requestId || index}><span>{event.accepted ? "Accepted" : "Blocked"}</span><span>{event.attackType || event.reason}</span><span>{event.itemName || event.auctionId}</span><span>{formatCurrency(eventAmount(event))}</span><span>{eventLatency(event).toFixed(2)} ms</span></div>) : <div className="empty-feed">Launch an attack to populate intelligence.</div>}</div></section>
        </main>
      )}

      {result && <Celebration result={result} onClose={() => { setResult(null); setSelectedAuctionId(""); setParticipant(null); loadAuctions(); }} />}
    </div>
  );
}

/** Renders one marketplace item card with live price and countdown. */
function AuctionCard({ auction, now, onSelect, label }) {
  return (
    <article className="auction-card">
      <div className={`card-art category-${auction.category.toLowerCase()}`}><span>{auction.category}</span><b>{auction.name.charAt(0)}</b><small>{auction.sellerName}</small></div>
      <div className="card-body"><div><small>LIVE VERIFIED LOT</small><h3>{auction.name}</h3><p>{auction.description}</p></div><div className="card-price"><span>Current bid</span><strong>{formatCurrency(auction.auction.amount)}</strong></div><div className="card-meta"><span>+{formatCurrency(auction.minimumIncrement)} minimum</span><b>{formatCountdown(auction.endAt - now)}</b></div><button type="button" onClick={() => onSelect(auction)}>{label}</button></div>
    </article>
  );
}
