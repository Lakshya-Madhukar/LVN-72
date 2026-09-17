const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const jwt = require("jsonwebtoken");

// Stores authentication data outside the source files.
const databaseDirectory = path.join(__dirname, "data");
const databasePath = path.join(databaseDirectory, "auction-users.db");

// Creates the database directory when it does not already exist.
fs.mkdirSync(databaseDirectory, { recursive: true });

// Opens SQLite and creates the database file automatically.
const database = new DatabaseSync(databasePath);

// Uses a deployment secret when available and a local-only development fallback.
const JWT_SECRET =
  process.env.JWT_SECRET || "auction-under-siege-local-development-secret";

// Creates the verified-user database table.
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('seller', 'bidder')),
    verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )
`);

/**
 * Converts email addresses into a consistent database format.
 */
function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/**
 * Hashes a password using scrypt and a unique random salt.
 */
function hashPassword(password, suppliedSalt = null) {
  const salt = suppliedSalt || crypto.randomBytes(16).toString("hex");

  const passwordHash = crypto
    .scryptSync(String(password), salt, 64)
    .toString("hex");

  return {
    salt,
    passwordHash,
  };
}

/**
 * Compares a submitted password against its securely stored hash.
 */
function verifyPassword(password, storedHash, storedSalt) {
  const submittedHash = Buffer.from(
    hashPassword(password, storedSalt).passwordHash,
    "hex",
  );

  const savedHash = Buffer.from(storedHash, "hex");

  if (submittedHash.length !== savedHash.length) {
    return false;
  }

  return crypto.timingSafeEqual(submittedHash, savedHash);
}

/**
 * Creates a signed two-hour session token.
 */
function createAccessToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
    },
    JWT_SECRET,
    {
      expiresIn: "2h",
      issuer: "auction-under-siege",
      audience: "auction-dashboard",
    },
  );
}

/**
 * Inserts a verified demo user unless that email already exists.
 */
function seedVerifiedUser({ name, email, password, role }) {
  const normalizedEmail = normalizeEmail(email);

  const existingUser = database
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(normalizedEmail);

  if (existingUser) {
    return;
  }

  const { passwordHash, salt } = hashPassword(password);

  database
    .prepare(`
      INSERT INTO users (
        id,
        name,
        email,
        password_hash,
        password_salt,
        role,
        verified,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `)
    .run(
      crypto.randomUUID(),
      name,
      normalizedEmail,
      passwordHash,
      salt,
      role,
      new Date().toISOString(),
    );
}

/**
 * Creates the verified seller and bidder demo accounts.
 */
function initializeAuthDatabase() {
  seedVerifiedUser({
    name: "Demo Seller",
    email: "seller@auction.demo",
    password: "Seller@123",
    role: "seller",
  });

  seedVerifiedUser({
    name: "Demo Bidder",
    email: "bidder@auction.demo",
    password: "Bidder@123",
    role: "bidder",
  });

  console.log("Authentication database ready.");
}

/**
 * Validates credentials and returns a signed token with a safe profile.
 */
function loginUser(email, password) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || typeof password !== "string" || !password) {
    return {
      success: false,
      status: 400,
      message: "Email and password are required.",
    };
  }

  const user = database
    .prepare(`
      SELECT
        id,
        name,
        email,
        password_hash,
        password_salt,
        role,
        verified
      FROM users
      WHERE email = ?
    `)
    .get(normalizedEmail);

  // A generic rejection prevents attackers from discovering registered emails.
  if (
    !user ||
    !verifyPassword(password, user.password_hash, user.password_salt)
  ) {
    return {
      success: false,
      status: 401,
      message: "The email or password is incorrect.",
    };
  }

  if (!user.verified) {
    return {
      success: false,
      status: 403,
      message: "This account has not been verified.",
    };
  }

  const safeUser = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    verified: Boolean(user.verified),
  };

  return {
    success: true,
    status: 200,
    message: "Login successful.",
    token: createAccessToken(safeUser),
    user: safeUser,
  };
}

/**
 * Verifies the Bearer token before protected endpoints can run.
 */
function authenticateToken(request, response, next) {
  const authorizationHeader = request.headers.authorization;

  if (!authorizationHeader?.startsWith("Bearer ")) {
    return response.status(401).json({
      authenticated: false,
      message: "Authentication is required.",
    });
  }

  const token = authorizationHeader.slice("Bearer ".length);

  try {
    request.user = jwt.verify(token, JWT_SECRET, {
      issuer: "auction-under-siege",
      audience: "auction-dashboard",
    });

    return next();
  } catch {
    return response.status(401).json({
      authenticated: false,
      message: "Your session is invalid or has expired.",
    });
  }
}

/**
 * Restricts a protected endpoint to one account role.
 */
function requireRole(requiredRole) {
  return (request, response, next) => {
    if (request.user?.role !== requiredRole) {
      return response.status(403).json({
        authorized: false,
        message: `Only ${requiredRole} accounts can perform this action.`,
      });
    }

    return next();
  };
}

/**
 * Finds the current user's safe profile without returning password data.
 */
function getUserProfile(userId) {
  const user = database
    .prepare(`
      SELECT id, name, email, role, verified, created_at
      FROM users
      WHERE id = ?
    `)
    .get(userId);

  if (!user) {
    return null;
  }

  return {
    ...user,
    verified: Boolean(user.verified),
  };
}

// Exposes authentication functions using CommonJS.
module.exports = {
  authenticateToken,
  getUserProfile,
  initializeAuthDatabase,
  loginUser,
  requireRole,
};