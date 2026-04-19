const express = require("express");
const { sendOtp, verifyOtp, refreshToken, logout } = require("../controllers/auth.controller");
const { validate } = require("../middleware/validate.middleware");
const { buildLimiter } = require("../middleware/rateLimit.middleware");
const { protect } = require("../middleware/auth.middleware");
const authValidation = require("../validations/auth.validation");

const router = express.Router();

const sendOtpLimiter = buildLimiter({
  windowMs: 60 * 1000,
  maxAuthenticated: 5,
  maxUnauthenticated: 5,
  message: "Too many OTP requests from this IP. Please try again after a few minutes.",
});

const verifyOtpLimiter = buildLimiter({
  windowMs: 60 * 1000,
  maxAuthenticated: 5,
  maxUnauthenticated: 5,
  message: "Too many verification attempts from this IP. Please try again later.",
});

router.post("/send-otp", sendOtpLimiter, validate(authValidation.sendOtp), sendOtp);
router.post("/verify-otp", verifyOtpLimiter, validate(authValidation.verifyOtp), verifyOtp);
// Canonical refresh endpoint.
router.post("/refresh", verifyOtpLimiter, refreshToken);
// Backward-compatible alias.
router.post("/refresh-token", verifyOtpLimiter, refreshToken);
router.post("/logout", protect, logout);

module.exports = router;
