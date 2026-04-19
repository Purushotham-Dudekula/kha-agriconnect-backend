const express = require("express");
const { protectAdmin } = require("../middleware/adminAuth.middleware");
const { requireAdmin } = require("../middleware/admin.middleware");
const { buildLimiter } = require("../middleware/rateLimit.middleware");
const { validate } = require("../middleware/validate.middleware");
const { validateTractorServiceTypes } = require("../middleware/serviceValidation.middleware");
const adminValidation = require("../validations/admin.validation");
const {
  adminLogin,
  adminForgotPassword,
  adminVerifyOtp,
  adminResetPassword,
} = require("../controllers/adminAuth.controller");
const { createOffer, updateOffer, deleteOffer } = require("../controllers/offers.controller");
const {
  verifyOperator,
  rejectOperator,
  verifyTractor,
  rejectTractor,
  listUsers,
  listBookings,
  listPendingTractors,
  getLiveBookings,
  blockUser,
  listAdminAuditLogs,
  listComplaints,
  respondComplaint,
  upsertPricing,
  listPricing,
  upsertSeasonalPricing,
  listSeasonalPricing,
  deleteSeasonalPricing,
  upsertCommission,
  getCommission,
  getAdminDashboard,
  getAdminRevenueAnalytics,
  getAdminDemandAnalytics,
  broadcastNotification,
  processRefund,
  getAdminMe,
  getSecureTractorDocument,
  getSecureOperatorDocument,
  verifyOperatorDocuments,
  verifyTractorDocument,
} = require("../controllers/admin.controller");
const {
  adminCreateTractor,
  adminUpdateTractor,
  adminDeleteTractor,
  listAllTractors,
} = require("../controllers/tractor.controller");
const {
  getAdminDashboardBookingStats,
  getAdminDashboardRevenueStats,
  getAdminDashboardUserStats,
} = require("../controllers/adminDashboard.controller");

const router = express.Router();

const adminAuthLimiter = buildLimiter({
  windowMs: 60 * 1000,
  maxAuthenticated: 5,
  maxUnauthenticated: 5,
  message: "Too many attempts from this IP. Please try again in a minute.",
});

router.post("/login", adminAuthLimiter, validate(adminValidation.adminLogin), adminLogin);
router.post("/forgot-password", adminForgotPassword);
router.post("/verify-otp", adminAuthLimiter, validate(adminValidation.verifyAdminOtp), adminVerifyOtp);
router.post("/reset-password", adminResetPassword);

// Admin profile
router.get("/me", protectAdmin, requireAdmin, getAdminMe);

// Approval queue
router.get("/tractors/pending", protectAdmin, requireAdmin, listPendingTractors);
router.get("/live-bookings", protectAdmin, requireAdmin, getLiveBookings);

router.patch("/verify-operator/:id", protectAdmin, requireAdmin, verifyOperator);
router.patch(
  "/reject-operator/:id",
  protectAdmin,
  requireAdmin,
  validate(adminValidation.rejectReason),
  rejectOperator
);
router.patch("/verify-tractor/:id", protectAdmin, requireAdmin, verifyTractor);
router.patch(
  "/reject-tractor/:id",
  protectAdmin,
  requireAdmin,
  validate(adminValidation.rejectReason),
  rejectTractor
);
router.get("/users", protectAdmin, requireAdmin, listUsers);
router.get("/bookings", protectAdmin, requireAdmin, listBookings);
router.patch(
  "/block-user/:id",
  protectAdmin,
  requireAdmin,
  validate(adminValidation.blockUser),
  blockUser
);
router.get("/audit-logs", protectAdmin, requireAdmin, listAdminAuditLogs);
router.get("/complaints", protectAdmin, requireAdmin, listComplaints);
router.patch(
  "/complaints/:id/respond",
  protectAdmin,
  requireAdmin,
  validate(adminValidation.respondComplaint),
  respondComplaint
);

// Admin analytics
router.get("/dashboard", protectAdmin, requireAdmin, getAdminDashboard);
router.get("/dashboard/bookings", protectAdmin, requireAdmin, getAdminDashboardBookingStats);
router.get("/dashboard/revenue", protectAdmin, requireAdmin, getAdminDashboardRevenueStats);
router.get("/dashboard/users", protectAdmin, requireAdmin, getAdminDashboardUserStats);
router.get("/revenue", protectAdmin, requireAdmin, getAdminRevenueAnalytics);
router.get("/demand-analytics", protectAdmin, requireAdmin, getAdminDemandAnalytics);

// Admin announcements (broadcast)
router.post(
  "/notifications/broadcast",
  protectAdmin,
  requireAdmin,
  validate(adminValidation.broadcastNotification),
  broadcastNotification
);

// Admin refund decisions (updates booking.refundStatus)
router.post(
  "/refunds/:bookingId",
  protectAdmin,
  requireAdmin,
  validate(adminValidation.refundDecision),
  processRefund
);

// Dynamic pricing
router.post(
  "/pricing",
  protectAdmin,
  requireAdmin,
  validate(adminValidation.upsertPricing),
  upsertPricing
);
router.get("/pricing", protectAdmin, requireAdmin, listPricing);
router.post(
  "/seasonal-pricing",
  protectAdmin,
  requireAdmin,
  validate(adminValidation.upsertSeasonalPricing),
  upsertSeasonalPricing
);
router.get("/seasonal-pricing", protectAdmin, requireAdmin, listSeasonalPricing);
router.delete("/seasonal-pricing/:id", protectAdmin, requireAdmin, deleteSeasonalPricing);

// Commission
router.post(
  "/commission",
  protectAdmin,
  requireAdmin,
  validate(adminValidation.upsertCommission),
  upsertCommission
);
router.get("/commission", protectAdmin, requireAdmin, getCommission);

// Offers
router.post(
  "/offers",
  protectAdmin,
  requireAdmin,
  validate(adminValidation.createOffer),
  createOffer
);
router.patch(
  "/offers/:id",
  protectAdmin,
  requireAdmin,
  validate(adminValidation.updateOffer),
  updateOffer
);
router.delete("/offers/:id", protectAdmin, requireAdmin, deleteOffer);

// Admin tractor management
router.get("/tractors", protectAdmin, requireAdmin, listAllTractors);
router.get("/tractor/:id/document/:type", protectAdmin, requireAdmin, getSecureTractorDocument);
router.patch(
  "/tractor/:id/verify-document",
  protectAdmin,
  requireAdmin,
  validate(adminValidation.verifyTractorDocument),
  verifyTractorDocument
);
router.get("/operator/:id/document/:type", protectAdmin, requireAdmin, getSecureOperatorDocument);
router.patch(
  "/operator/:id/verify-documents",
  protectAdmin,
  requireAdmin,
  verifyOperatorDocuments
);
router.post(
  "/tractors",
  protectAdmin,
  requireAdmin,
  validate(adminValidation.adminCreateTractor),
  validateTractorServiceTypes,
  adminCreateTractor
);
router.patch(
  "/tractors/:id",
  protectAdmin,
  requireAdmin,
  validate(adminValidation.adminUpdateTractor),
  validateTractorServiceTypes,
  adminUpdateTractor
);
router.delete("/tractors/:id", protectAdmin, requireAdmin, adminDeleteTractor);

module.exports = router;
