const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

function isTest() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "test";
}

function applyTestDefaults() {
  if (!isTest()) return;
  process.env.JWT_SECRET = (process.env.JWT_SECRET || "").trim() || "testsecret";
  process.env.MONGO_URI = (process.env.MONGO_URI || "").trim() || "mongodb://127.0.0.1:27017/testdb";
  process.env.REDIS_DISABLED = (process.env.REDIS_DISABLED || "").trim() || "true";
  process.env.JWT_EXPIRES_IN = (process.env.JWT_EXPIRES_IN || "").trim() || "1h";
  process.env.CORS_ORIGIN = (process.env.CORS_ORIGIN || "").trim() || "http://localhost:3000";
}

function applyDevelopmentFallbacks() {
  if (!isDevelopment()) return;

  const fallbacks = {
    SMTP_HOST: "smtp.test.local",
    SMTP_PORT: "1025",
    SMTP_USER: "test",
    SMTP_PASS: "test",
  };

  let usedFallback = false;
  for (const [key, value] of Object.entries(fallbacks)) {
    const current = String(process.env[key] || "").trim();
    if (!current) {
      process.env[key] = value;
      usedFallback = true;
    }
  }

  if (usedFallback) {
    console.warn("Using fallback env values in development");
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}

function isDevelopment() {
  return process.env.NODE_ENV === "development";
}

function isProduction() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function parseCorsOrigins() {
  const raw = String(process.env.CORS_ORIGIN || "http://localhost:3000").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 5000),
  mongoUri: "",
  jwtSecret: "",
  jwtExpiresIn: "",
  /** User app access JWT (auth.controller); defaults match prior hardcoded values. */
  jwtAccessExpiresIn: "15m",
  /** User app refresh JWT + cookie/session alignment. */
  jwtRefreshExpiresIn: "7d",
  corsOrigins: [],
  devRouteSecret: process.env.DEV_ROUTE_SECRET || "",
  enablePayments: true,
  enableEmails: true,
  enableNotifications: true,
};

function validateEnv() {
  process.env.NODE_ENV = String(process.env.NODE_ENV || "development").trim() || "development";
  applyTestDefaults();
  applyDevelopmentFallbacks();

  env.mongoUri = requireEnv("MONGO_URI");
  env.jwtSecret = requireEnv("JWT_SECRET");
  env.jwtExpiresIn = String(process.env.JWT_EXPIRES_IN || "1h").trim() || "1h";
  env.jwtAccessExpiresIn = String(process.env.JWT_ACCESS_EXPIRES_IN || "15m").trim() || "15m";
  env.jwtRefreshExpiresIn = String(process.env.JWT_REFRESH_EXPIRES_IN || "7d").trim() || "7d";

  env.corsOrigins = parseCorsOrigins();
  env.devRouteSecret = String(process.env.DEV_ROUTE_SECRET || "").trim();
  // Tri-state: explicit "false" disables; unset defaults to enabled (backward compatible).
  function triBool(name, defaultWhenUnset = true) {
    const v = String(process.env[name] ?? "").trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
    return defaultWhenUnset;
  }
  env.enablePayments = triBool("ENABLE_PAYMENTS", true);
  env.enableEmails = triBool("ENABLE_EMAILS", true);
  env.enableNotifications = triBool("ENABLE_NOTIFICATIONS", true);
}

function startupIntegrationStatus() {
  const redisDisabled = String(process.env.REDIS_DISABLED || "")
    .trim()
    .toLowerCase() === "true";
  const redisUrl = String(process.env.REDIS_URL || "").trim();
  const smtpHost = String(process.env.SMTP_HOST || "").trim();
  const smtpUser = String(process.env.SMTP_USER || process.env.MAIL_USER || "").trim();
  const smtpPass = String(process.env.SMTP_PASS || process.env.MAIL_PASS || "").trim();
  const razorpayKeyId = String(process.env.RAZORPAY_KEY_ID || "").trim();
  const razorpaySecret = String(process.env.RAZORPAY_KEY_SECRET || "").trim();
  const webhookSecret = String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();

  return {
    redis: {
      configured: !redisDisabled && Boolean(redisUrl),
      disabled: redisDisabled,
      warning: !redisDisabled && !redisUrl ? "REDIS_URL is missing" : "",
    },
    razorpay: {
      configured: Boolean(razorpayKeyId && razorpaySecret && webhookSecret),
      warning:
        razorpayKeyId && razorpaySecret && webhookSecret
          ? ""
          : "Razorpay env not fully configured (RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET/RAZORPAY_WEBHOOK_SECRET)",
    },
    smtp: {
      configured: Boolean(smtpHost && smtpUser && smtpPass),
      warning: smtpHost && smtpUser && smtpPass ? "" : "SMTP env not fully configured (SMTP_HOST/SMTP_USER/SMTP_PASS)",
    },
  };
}

module.exports = { env, validateEnv, isDevelopment, startupIntegrationStatus };
