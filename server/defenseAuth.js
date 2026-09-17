const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

// Uses secure environment variables during deployment.
const DEFENSE_MASTER_PASSWORD =
  process.env.DEFENSE_MASTER_PASSWORD || "AUS-Shield@2026";

const DEFENSE_TOKEN_SECRET =
  process.env.DEFENSE_TOKEN_SECRET ||
  "auction-under-siege-defense-development-secret";

/**
 * Compares two strings without leaking character-by-character timing data.
 */
function secureStringComparison(firstValue, secondValue) {
  const firstBuffer = Buffer.from(String(firstValue));
  const secondBuffer = Buffer.from(String(secondValue));

  if (firstBuffer.length !== secondBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(firstBuffer, secondBuffer);
}

/**
 * Validates the master password and generates a temporary Defence Lab token.
 */
function unlockDefenseAccess(masterPassword, authenticatedUser) {
  const passwordIsValid = secureStringComparison(
    masterPassword,
    DEFENSE_MASTER_PASSWORD,
  );

  if (!passwordIsValid) {
    return {
      success: false,
      status: 401,
      message: "The Defence Lab master password is incorrect.",
    };
  }

  const defenseToken = jwt.sign(
    {
      userId: authenticatedUser.userId,
      role: authenticatedUser.role,
      scope: "defense-lab",
    },
    DEFENSE_TOKEN_SECRET,
    {
      expiresIn: "30m",
      issuer: "auction-under-siege",
      audience: "defense-lab",
    },
  );

  return {
    success: true,
    status: 200,
    message: "Defence Lab access granted.",
    defenseToken,
    expiresIn: 1800,
  };
}

/**
 * Validates the temporary Defence Lab token on protected routes.
 */
function authenticateDefenseAccess(request, response, next) {
  const defenseToken = request.headers["x-defense-token"];

  if (!defenseToken) {
    return response.status(401).json({
      authorized: false,
      message: "Defence Lab authorization is required.",
    });
  }

  try {
    const payload = jwt.verify(defenseToken, DEFENSE_TOKEN_SECRET, {
      issuer: "auction-under-siege",
      audience: "defense-lab",
    });

    if (
      payload.scope !== "defense-lab" ||
      payload.userId !== request.user?.userId
    ) {
      throw new Error("Defence token identity mismatch.");
    }

    request.defenseAccess = payload;
    return next();
  } catch {
    return response.status(401).json({
      authorized: false,
      message: "Defence Lab access has expired. Unlock it again.",
    });
  }
}

module.exports = {
  authenticateDefenseAccess,
  unlockDefenseAccess,
};