import { createContext, useContext, useEffect, useState } from "react";
import "./AuthGate.css";

// Uses the deployed API URL when configured and localhost during development.
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

// Makes authenticated user information available to the rest of the application.
const AuthContext = createContext(null);

/**
 * Allows any child component to access the logged-in user and session token.
 */
export function useAuth() {
  return useContext(AuthContext);
}

/**
 * Blocks access to the auction dashboard until a verified user logs in.
 */
export default function AuthGate({ children }) {
  const [sessionStatus, setSessionStatus] = useState("checking");
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(
    () => localStorage.getItem("auction-auth-token") || "",
  );

  const [email, setEmail] = useState("bidder@auction.demo");
  const [password, setPassword] = useState("Bidder@123");
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  /**
   * Removes saved authentication information from the browser.
   */
  function clearSession() {
    localStorage.removeItem("auction-auth-token");
    localStorage.removeItem("auction-auth-user");

    setToken("");
    setUser(null);
    setSessionStatus("guest");
  }

  /**
   * Saves a successful verified-user session.
   */
  function saveSession(loginToken, authenticatedUser) {
    localStorage.setItem("auction-auth-token", loginToken);
    localStorage.setItem(
      "auction-auth-user",
      JSON.stringify(authenticatedUser),
    );

    setToken(loginToken);
    setUser(authenticatedUser);
    setSessionStatus("authenticated");
  }

  /**
   * Checks whether a previously stored token is still valid.
   */
  async function restoreSession(savedToken) {
    try {
      const response = await fetch(`${API_URL}/api/auth/me`, {
        headers: {
          Authorization: `Bearer ${savedToken}`,
        },
      });

      if (!response.ok) {
        clearSession();
        return;
      }

      const data = await response.json();

      if (!data.authenticated || !data.user?.verified) {
        clearSession();
        return;
      }

      setUser(data.user);
      setSessionStatus("authenticated");
    } catch {
      setMessage("Authentication server is currently unavailable.");
      setSessionStatus("guest");
    }
  }

  /**
   * Restores an existing session when the application first loads.
   */
  useEffect(() => {
    if (!token) {
      setSessionStatus("guest");
      return;
    }

    restoreSession(token);
  }, []);

  /**
   * Sends the entered credentials to the authentication API.
   */
  async function handleLogin(event) {
    event.preventDefault();

    setMessage("");
    setIsSubmitting(true);

    try {
      const response = await fetch(`${API_URL}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          password,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.authenticated) {
        setMessage(data.message || "Login was rejected.");
        return;
      }

      saveSession(data.token, data.user);
    } catch {
      setMessage(
        "Unable to contact the authentication server. Check that the backend is running.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  /**
   * Loads one of the verified demonstration accounts into the form.
   */
  function selectDemoAccount(role) {
    if (role === "seller") {
      setEmail("seller@auction.demo");
      setPassword("Seller@123");
    } else {
      setEmail("bidder@auction.demo");
      setPassword("Bidder@123");
    }

    setMessage("");
  }

  /**
   * Ends the current browser session.
   */
  function handleLogout() {
    clearSession();
    setEmail("bidder@auction.demo");
    setPassword("Bidder@123");
    setMessage("You have logged out securely.");
  }

  // Displays a secure-session check before exposing the dashboard.
  if (sessionStatus === "checking") {
    return (
      <main className="auth-loading">
        <div className="auth-loading-ring" />
        <p>Verifying secure session...</p>
      </main>
    );
  }

  // Displays the login screen when no valid session exists.
  if (sessionStatus !== "authenticated") {
    return (
      <main className="auth-page">
        <section className="auth-showcase">
          <div className="auth-brand">
            <span className="auth-brand-mark">AUS</span>

            <div>
              <strong>Auction Under Siege</strong>
              <span>Secure auction infrastructure</span>
            </div>
          </div>

          <div className="auth-showcase-content">
            <p className="auth-eyebrow">ZERO-TRUST AUCTION ACCESS</p>

            <h1>
              Bid securely.
              <span>Defend automatically.</span>
            </h1>

            <p className="auth-description">
              A real-time auction engine protected by atomic bid serialization,
              verified identities and live attack detection.
            </p>

            <div className="auth-security-list">
              <div>
                <span>01</span>
                <p>
                  <strong>Verified identities</strong>
                  Only approved sellers and bidders can enter.
                </p>
              </div>

              <div>
                <span>02</span>
                <p>
                  <strong>Protected credentials</strong>
                  Passwords are stored using salted cryptographic hashes.
                </p>
              </div>

              <div>
                <span>03</span>
                <p>
                  <strong>Role-based authority</strong>
                  Seller and bidder permissions remain separated.
                </p>
              </div>
            </div>
          </div>

          <p className="auth-showcase-footer">
            ATOMIC BIDDING · LIVE TELEMETRY · ACTIVE DEFENCE
          </p>
        </section>

        <section className="auth-panel">
          <form className="auth-card" onSubmit={handleLogin}>
            <div className="auth-card-header">
              <span className="auth-status">
                <i />
                Authentication online
              </span>

              <h2>Access the auction</h2>
              <p>Sign in using a verified seller or bidder account.</p>
            </div>

            <label className="auth-field">
              <span>Email address</span>

              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@example.com"
                autoComplete="email"
                required
              />
            </label>

            <label className="auth-field">
              <span>Password</span>

              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter your password"
                autoComplete="current-password"
                required
              />
            </label>

            {message && (
              <div className="auth-message" role="alert">
                {message}
              </div>
            )}

            <button
              className="auth-submit"
              type="submit"
              disabled={isSubmitting}
            >
              {isSubmitting ? "Verifying identity..." : "Secure login"}
            </button>

            <div className="auth-divider">
              <span>Hackathon demo accounts</span>
            </div>

            <div className="auth-demo-buttons">
              <button
                type="button"
                onClick={() => selectDemoAccount("bidder")}
              >
                <span>Bidder</span>
                bidder@auction.demo
              </button>

              <button
                type="button"
                onClick={() => selectDemoAccount("seller")}
              >
                <span>Seller</span>
                seller@auction.demo
              </button>
            </div>

            <p className="auth-encryption-note">
              Session access is protected using signed, expiring tokens.
            </p>
          </form>
        </section>
      </main>
    );
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        logout: handleLogout,
      }}
    >
      <div className="authenticated-app">
        <div className="session-bar">
          <div className="session-identity">
            <span className={`session-role session-role-${user.role}`}>
              {user.role}
            </span>

            <div>
              <strong>{user.name}</strong>
              <small>{user.email}</small>
            </div>
          </div>

          <div className="session-actions">
            <span className="verified-badge">Verified account</span>

            <button type="button" onClick={handleLogout}>
              Log out
            </button>
          </div>
        </div>

        {children}
      </div>
    </AuthContext.Provider>
  );
}