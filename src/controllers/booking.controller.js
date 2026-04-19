const mongoose = require("mongoose");
const Booking = require("../models/booking.model");
const { applyAdvanceFieldDedupe } = Booking;
const User = require("../models/user.model");
const Tractor = require("../models/tractor.model");
const Payment = require("../models/payment.model");
const Pricing = require("../models/pricing.model");
const SeasonalPricing = require("../models/seasonalPricing.model");
const Commission = require("../models/commission.model");
const Offer = require("../models/offer.model");
const { getActiveCommissionCached } = require("../services/commissionCache.service");
const { getPricingByServiceTypeCached } = require("../services/pricingCache.service");
const { notifyUser, notifyAdvanceReceived } = require("../services/notification.service");
const {
  verifyPayment,
  fetchPaymentAmountRupees,
  isPaymentIdReused,
} = require("../services/payment.service");
const { logPaymentSuccess } = require("../services/ledger.service");
const { applyBookingSettlementAfterFullPayment } = require("../services/bookingSettlement.service");
const { fetchRazorpayPaymentStatus } = require("../services/razorpayStatus.service");
const { invokeFinalizeRazorpayPaymentCaptured } = require("../services/paymentFinalizerInvoke.service");
const { resolveRefundSnapshot } = require("../utils/refundCalculation");
const { AppError } = require("../utils/AppError");
const userFacing = require("../constants/userFacing");
const { cleanUserResponse } = require("../utils/cleanUserResponse");
const { canOperatorServeBookings } = require("../services/operatorEligibility.service");
const { getDistanceAndETA } = require("../services/maps.service");
const { sendSuccess } = require("../utils/apiResponse");
const { logger } = require("../utils/logger");
const { uploadFile, resolveDocumentInput } = require("../services/storage.service");
const { logAuditAction } = require("../services/auditLog.service");
const { acquireLock, releaseLock } = require("../services/redisLock.service");
const { isPaymentsEnabled } = require("../utils/featureFlags");

/** Operator cannot accept another booking while these are open. */
const OPERATOR_RESPOND_BUSY_STATUSES = ["accepted", "confirmed", "en_route", "in_progress"];

const { DEFAULT_GST_RATE: GST_RATE } = require("../constants/financial");
const ADVANCE_RATE = 0.3;
const { PAYMENT_PENDING_TTL_MS } = require("../jobs/bookingPaymentLock.cron");

const FARMER_DUPLICATE_BOOKING_STATUSES = Booking.FARMER_ACTIVE_BOOKING_STATUSES;

const OPERATOR_PUBLIC_SELECT =
  "name phone village role isOnline averageRating reviewCount verificationStatus aadhaarVerified";
const FARMER_PUBLIC_SELECT = "name phone village role landArea";

const ACTION_BLOCKED_STATUSES = new Set(["cancelled", "closed", "rejected"]);
const PAYMENT_TERMINAL_STATUSES = new Set(["cancelled", "closed", "rejected"]);
/** Final payment recorded (canonical `fully_paid`; legacy `paid` still supported). */
const PAID_LIKE_PAYMENT_STATUSES = ["fully_paid", "paid"];
function isPaidLikePaymentStatus(paymentStatus) {
  return PAID_LIKE_PAYMENT_STATUSES.includes(paymentStatus);
}
const STATUS_MESSAGE_MAP = {
  pending: "Waiting for operator to accept",
  accepted: "Operator accepted, please pay advance",
  confirmed: "Booking confirmed",
  in_progress: "Work is in progress",
  completed: "Work completed, please pay remaining",
  closed: "Booking completed successfully",
  cancelled: "Booking cancelled",
};

function isProduction() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function buildPaymentLogContext({ req, bookingId, paymentId, stage, error }) {
  return {
    type: "PAYMENT",
    userId: req?.user?._id ? String(req.user._id) : null,
    bookingId: bookingId ? String(bookingId) : null,
    paymentId: paymentId || null,
    paymentStage: stage || null,
    requestId: req?.requestId || null,
    timestamp: new Date().toISOString(),
    ...(error ? { error: error?.message || String(error) } : {}),
  };
}

function schedulePaymentRecoveryCheck({ paymentId, bookingId }) {
  const pid = typeof paymentId === "string" ? paymentId.trim() : "";
  if (!pid) return;
  const delayMs = 45_000;
  const timer = setTimeout(async () => {
    try {
      if (!isPaymentsEnabled()) {
        logger.info("[PAYMENT_QUEUE_SKIP] Recovery timer skipped (payments disabled)", {
          tag: "PAYMENT_QUEUE_SKIP",
          paymentId: pid,
          bookingId: bookingId ? String(bookingId) : null,
        });
        return;
      }
      const statusResult = await fetchRazorpayPaymentStatus(pid);
      if (!statusResult.ok) return;
      if (String(statusResult.status || "").toLowerCase() !== "captured") return;
      logger.warn("[RECOVERY] Webhook delayed, manual verification triggered", {
        type: "PAYMENT",
        action: "payment.recovery",
        status: "RECOVERY_TRIGGERED",
        paymentId: pid,
        bookingId: bookingId ? String(bookingId) : null,
        timestamp: new Date().toISOString(),
      });
      await invokeFinalizeRazorpayPaymentCaptured({
        paymentId: pid,
        webhookEvent: "payment.captured",
        source: "recovery",
      });
    } catch (error) {
      logger.error("[PAYMENT_ERROR] Payment recovery finalize failed", {
        tag: "PAYMENT_ERROR",
        operation: "schedulePaymentRecoveryCheck",
        type: "PAYMENT",
        action: "payment.failed",
        status: "FAILED",
        paymentId: pid,
        bookingId: bookingId ? String(bookingId) : null,
        error: error?.message || String(error),
        timestamp: new Date().toISOString(),
      });
    }
  }, delayMs);
  if (typeof timer?.unref === "function") timer.unref();
}

function assertBookingTransition(fromStatus, toStatus, actionLabel) {
  // Canonical strict map (requested):
  // REQUESTED → ACCEPTED → PAYMENT_PENDING → CONFIRMED → IN_PROGRESS → COMPLETED
  // We do not rename stored statuses; we validate on the existing ones.
  const allowed = new Map([
    ["pending", new Set(["accepted", "rejected", "cancelled"])],
    // Strict path for payments: accepted -> payment_pending -> confirmed
    ["accepted", new Set(["payment_pending", "cancelled"])],
    // payment_pending transitions:
    // - after advance webhook: payment_pending -> confirmed
    // - after remaining webhook: payment_pending -> closed
    ["payment_pending", new Set(["confirmed", "closed", "cancelled"])],
    ["confirmed", new Set(["in_progress", "cancelled"])],
    ["en_route", new Set(["in_progress", "cancelled"])],
    ["in_progress", new Set(["completed", "cancelled"])],
    // Keep current behavior: completed can be closed after remaining payment settlement.
    ["completed", new Set(["payment_pending", "closed", "cancelled"])],
  ]);

  const set = allowed.get(fromStatus);
  if (!set || !set.has(toStatus)) {
    throw new AppError(
      `Invalid booking status transition: ${fromStatus} → ${toStatus}`,
      400,
      {
        code: "INVALID_BOOKING_TRANSITION",
        userTip: `Cannot ${actionLabel || "update booking"} from '${fromStatus}' to '${toStatus}'.`,
        retryable: false,
      }
    );
  }
}

function logStatusTransition({ event, bookingId, userId, before, after, paymentId, idempotencyKey }) {
  logger.info(event, {
    bookingId: bookingId ? String(bookingId) : null,
    userId: userId ? String(userId) : null,
    paymentId: paymentId || null,
    idempotencyKey: idempotencyKey || null,
    before,
    after,
  });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  // Great-circle distance (Haversine). Returns kilometers.
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371; // earth radius km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function assertNotActionBlocked(booking) {
  if (!booking) return;
  if (ACTION_BLOCKED_STATUSES.has(booking.status)) {
    throw new AppError(`This booking is ${booking.status} and no further actions are allowed.`, 400, {
      code: "BOOKING_TERMINAL",
      userTip: "If you need help, contact support with your booking id.",
      retryable: false,
    });
  }
}

function assertPaymentNotTerminal(booking) {
  if (!booking) return;
  if (PAYMENT_TERMINAL_STATUSES.has(booking.status)) {
    throw new AppError("Cannot process payment for this booking", 400, {
      code: "PAYMENT_TERMINAL_BOOKING",
      retryable: false,
    });
  }
}

function assertStatus(booking, allowedStatuses, actionLabel) {
  if (!allowedStatuses.includes(booking.status)) {
    throw new AppError(
      `Cannot ${actionLabel} while booking status is '${booking.status}'.`,
      400,
      {
        code: "INVALID_BOOKING_STATUS",
        userTip: "Check the booking lifecycle and try the correct next step.",
        retryable: false,
      }
    );
  }
}

function assertPaymentStatus(booking, allowedPaymentStatuses, actionLabel) {
  if (!allowedPaymentStatuses.includes(booking.paymentStatus)) {
    throw new AppError(
      `Cannot ${actionLabel} while paymentStatus is '${booking.paymentStatus}'.`,
      400,
      {
        code: "INVALID_PAYMENT_STATUS",
        userTip: "Complete the required payment step first.",
        retryable: false,
      }
    );
  }
}

function withStatusMessage(bookingLike) {
  const obj = bookingLike && typeof bookingLike.toObject === "function" ? bookingLike.toObject() : bookingLike;
  if (!obj) return obj;
  return {
    ...obj,
    statusMessage: STATUS_MESSAGE_MAP[obj.status] || "Status updated",
  };
}

/** Mongo duplicate key on partial unique index `farmer_one_active_booking`. */
function isFarmerActiveBookingDuplicateKey(err) {
  if (!err) return false;
  const candidates = [];
  candidates.push(err);
  if (err.cause) candidates.push(err.cause);
  if (Array.isArray(err.writeErrors)) {
    for (const we of err.writeErrors) {
      if (we && we.err) candidates.push(we.err);
      else candidates.push(we);
    }
  }
  for (const dup of candidates) {
    if (!dup || (dup.code !== 11000 && dup.code !== 11001)) continue;
    if (dup.keyPattern && Object.prototype.hasOwnProperty.call(dup.keyPattern, "farmer")) return true;
    if (dup.keyValue && Object.prototype.hasOwnProperty.call(dup.keyValue, "farmer")) return true;
    const msg = String(dup.message || err.message || "");
    if (/dup key/i.test(msg) && /farmer/i.test(msg)) return true;
  }
  return false;
}

/** Mongo duplicate key on partial unique index `machine_slot_unique_active` (tractor + date + time). */
function isMachineSlotBookingDuplicateKey(err) {
  if (!err) return false;
  const candidates = [];
  candidates.push(err);
  if (err.cause) candidates.push(err.cause);
  if (Array.isArray(err.writeErrors)) {
    for (const we of err.writeErrors) {
      if (we && we.err) candidates.push(we.err);
      else candidates.push(we);
    }
  }
  for (const dup of candidates) {
    if (!dup || (dup.code !== 11000 && dup.code !== 11001)) continue;
    const kp = dup.keyPattern || {};
    if (kp.tractor && kp.date && kp.time) return true;
    const kv = dup.keyValue || {};
    if (kv.tractor != null && kv.date != null && kv.time != null) return true;
    const msg = String(dup.message || err.message || "");
    if (/machine_slot_unique_active/i.test(msg)) return true;
    if (/dup key/i.test(msg) && /tractor/i.test(msg) && /time/i.test(msg)) return true;
  }
  return false;
}

function parsePagination(query = {}) {
  const pageRaw = parseInt(query.page, 10);
  const page = Math.max(1, Number.isFinite(pageRaw) ? pageRaw : 1);

  const limitRaw = parseInt(query.limit, 10);
  const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 10), 100);

  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

async function createBooking(req, res, next) {
  try {
    if (req.user.role !== "farmer") {
      res.status(403);
      throw new Error("Only farmers can create bookings.");
    }

    const {
      operatorId,
      tractorId,
      landArea,
      serviceType,
      date,
      time,
      address,
      baseAmount: _baseAmountInput,
      totalAmount: _totalAmountLegacy,
    } = req.body;

    // New behavior:
    // - If `tractorId` is provided, derive `operatorId` from the tractor.
    // - If `operatorId` is provided (legacy flow), keep existing logic unchanged.
    let resolvedOperatorId = operatorId;
    let resolvedTractorId = tractorId;
    let tractor = null;

    const tractorIdProvided = resolvedTractorId != null && String(resolvedTractorId).trim() !== "";
    const operatorIdProvided = resolvedOperatorId != null && String(resolvedOperatorId).trim() !== "";

    if (tractorIdProvided) {
      if (!mongoose.Types.ObjectId.isValid(resolvedTractorId)) {
        res.status(400);
        throw new Error("tractorId must be a valid ID.");
      }

      tractor = await Tractor.findById(resolvedTractorId).lean();
      if (!tractor) {
        res.status(404);
        throw new Error("Tractor not found.");
      }
      if (tractor.isDeleted === true) {
        res.status(404);
        throw new Error("Tractor not found.");
      }
      // Requirement: ensure approved + available in tractor-based flow.
      if (tractor.verificationStatus !== "approved" || tractor.isAvailable !== true) {
        res.status(400);
        throw new Error("Selected tractor must be approved and available.");
      }

      // Derive operatorId from tractor.
      resolvedOperatorId = tractor.operatorId;

      // If legacy clients still send operatorId alongside tractorId, ensure they match.
      if (operatorIdProvided && String(resolvedOperatorId) !== String(operatorId)) {
        res.status(400);
        throw new Error("Selected tractor does not belong to selected operator.");
      }
    } else {
      // Legacy operator-based flow expects both operatorId and tractorId for selection.
      if (!operatorIdProvided) {
        res.status(400);
        throw new Error("tractorId or operatorId is required.");
      }
      if (!mongoose.Types.ObjectId.isValid(resolvedOperatorId)) {
        res.status(400);
        throw new Error("operatorId must be a valid ID.");
      }
      if (!resolvedTractorId || !mongoose.Types.ObjectId.isValid(resolvedTractorId)) {
        res.status(400);
        throw new Error("tractorId must be a valid ID.");
      }
    }

    // Reduce farmer input burden:
    // - If landArea isn't provided, fall back to farmer profile.
    // - If still missing, reject the request.
    const landAreaResolved =
      landArea !== undefined && landArea !== null && landArea !== "" ? landArea : req.user.landArea;
    if (landAreaResolved === undefined || landAreaResolved === null || landAreaResolved === "") {
      res.status(400);
      throw new Error("landArea is required (either in body or from farmer profile).");
    }

    const land = Number(landAreaResolved);
    if (!Number.isFinite(land) || land <= 0) {
      res.status(400);
      throw new Error("landArea must be greater than 0.");
    }

    if (!serviceType || typeof serviceType !== "string" || !serviceType.trim()) {
      res.status(400);
      throw new Error("serviceType is required.");
    }

    if (date === undefined || date === null || date === "") {
      res.status(400);
      throw new Error("date is required.");
    }

    const bookingDate = new Date(date);
    if (Number.isNaN(bookingDate.getTime())) {
      res.status(400);
      throw new Error("date must be a valid date.");
    }
    if (bookingDate.getTime() <= Date.now()) {
      res.status(400);
      throw new Error("date must be in the future.");
    }
    if (typeof time !== "string" || !/^\d{1,2}:\d{2}$/.test(time.trim())) {
      res.status(400);
      throw new Error("time is required and must be in HH:mm format.");
    }

    const serviceTypeTrimmed = serviceType.trim();
    const serviceTypeNormalized = serviceTypeTrimmed.toLowerCase();

    const [pricingDoc, activeCommission, seasonalPricing] = await Promise.all([
      getPricingByServiceTypeCached(serviceTypeNormalized, 300),
      getActiveCommissionCached(300),
      SeasonalPricing.findOne({
        serviceType: serviceTypeNormalized,
        startDate: { $lte: new Date() },
        endDate: { $gte: new Date() },
      })
        .sort({ startDate: -1 })
        .lean(),
    ]);

    const pricingDocEffective = req.serviceConfig?.pricingDoc || pricingDoc || null;
    if (!activeCommission || !Number.isFinite(activeCommission.percentage)) {
      res.status(400);
      throw new Error("Commission is not configured or not active.");
    }

    const commissionPercentage = Number(activeCommission.percentage);

    let baseAmount;
    const typePricePerAcre = Number(req.serviceConfig?.selectedTypePricing?.pricePerAcre || 0);
    const typePricePerHour = Number(req.serviceConfig?.selectedTypePricing?.pricePerHour || 0);
    const servicePricePerAcre = Number(
      req.serviceConfig?.servicePricing?.pricePerAcre || pricingDocEffective?.pricePerAcre || 0
    );
    const servicePricePerHour = Number(
      req.serviceConfig?.servicePricing?.pricePerHour || pricingDocEffective?.pricePerHour || 0
    );
    const pricePerAcre = typePricePerAcre > 0 ? typePricePerAcre : servicePricePerAcre;
    const pricePerHour = typePricePerHour > 0 ? typePricePerHour : servicePricePerHour;

    if (pricePerAcre > 0) {
      baseAmount = round2(pricePerAcre * land);
    } else if (pricePerHour > 0) {
      // Time-based pricing requires `hours` in the request body.
      const hoursRaw = req.body?.hours;
      const hours =
        hoursRaw !== undefined && hoursRaw !== null && hoursRaw !== "" ? Number(hoursRaw) : null;
      if (!Number.isFinite(hours) || hours <= 0) {
        res.status(400);
        throw new Error("Pricing for this serviceType requires `hours` in request body.");
      }
      baseAmount = round2(pricePerHour * hours);
    } else {
      res.status(400);
      throw new Error("Pricing not configured for this service");
    }

    if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
      res.status(400);
      throw new Error("baseAmount must be a positive number.");
    }

    const seasonalMultiplierRaw = Number(seasonalPricing?.multiplier || 1);
    const seasonalMultiplier =
      Number.isFinite(seasonalMultiplierRaw) && seasonalMultiplierRaw > 0
        ? seasonalMultiplierRaw
        : 1;
    baseAmount = round2(baseAmount * seasonalMultiplier);

    const farmerHasActive = await Booking.exists({
      farmer: req.user._id,
      status: { $in: FARMER_DUPLICATE_BOOKING_STATUSES },
    });
    if (farmerHasActive) {
      throw new AppError(userFacing.DUPLICATE_BOOKING.message, 409, {
        code: userFacing.DUPLICATE_BOOKING.code,
        userTip: userFacing.DUPLICATE_BOOKING.userTip,
        retryable: userFacing.DUPLICATE_BOOKING.retryable,
      });
    }

    if (String(resolvedOperatorId) === String(req.user._id)) {
      throw new AppError("You cannot book yourself as the operator.", 400, {
        code: "INVALID_OPERATOR",
        userTip: "Choose a different operator.",
        retryable: false,
      });
    }

    const operator = await User.findById(resolvedOperatorId).select("role");

    if (!operator) {
      res.status(404);
      throw new Error("Operator not found.");
    }

    if (operator.role !== "operator") {
      res.status(400);
      throw new Error("Selected user is not an operator.");
    }

    const eligible = await canOperatorServeBookings(resolvedOperatorId);
    if (!eligible) {
      throw new AppError(
        "This operator is not verified or has no approved tractor available for booking.",
        400,
        {
          code: "OPERATOR_NOT_ELIGIBLE",
          userTip: "Choose another operator from nearby listings.",
          retryable: false,
        }
      );
    }

    // In tractor-based flow we already fetched `tractor`; in operator-based flow we fetch here.
    if (!tractor) {
      tractor = await Tractor.findById(resolvedTractorId).lean();
      if (!tractor) {
        res.status(404);
        throw new Error("Tractor not found.");
      }
      if (tractor.isDeleted === true) {
        res.status(404);
        throw new Error("Tractor not found.");
      }
    }
    if (String(tractor.operatorId) !== String(resolvedOperatorId)) {
      res.status(400);
      throw new Error("Selected tractor does not belong to selected operator.");
    }
    if (tractor.verificationStatus !== "approved" || tractor.isAvailable !== true) {
      res.status(400);
      throw new Error("Selected tractor must be approved and available.");
    }

    const tractorServiceCodes = (tractor.machineryTypes || []).map((c) =>
      String(c || "")
        .trim()
        .toLowerCase()
    );
    if (!tractorServiceCodes.includes(serviceTypeNormalized)) {
      res.status(400);
      throw new Error("Invalid or unsupported service type");
    }

    const bookingSubtype =
      typeof req.body?.type === "string" && req.body.type.trim()
        ? req.body.type.trim().toLowerCase()
        : "";
    if (bookingSubtype) {
      const subs = (tractor.machinerySubTypes || []).map((s) =>
        String(s || "")
          .trim()
          .toLowerCase()
      ).filter(Boolean);
      if (subs.length > 0 && !subs.includes(bookingSubtype)) {
        res.status(400);
        throw new Error("Invalid service type");
      }
    }

    const gstAmount = round2(baseAmount * GST_RATE);
    const platformFee = round2(baseAmount * (commissionPercentage / 100));
    const totalAmount = round2(baseAmount + gstAmount + platformFee);

    // Apply active offer discount (if any) on the full total.
    const now = new Date();
    const activeOffer = await Offer.findOne({
      isActive: true,
      startDate: { $lte: now },
      endDate: { $gte: now },
    })
      .sort({ startDate: -1 })
      .lean();

    let discountApplied = 0; // stored as percentage
    let discountAmount = 0; // stored as absolute amount
    let finalAmount = totalAmount;
    if (activeOffer) {
      const discountPercentage = Number(activeOffer.discountPercentage);
      if (Number.isFinite(discountPercentage) && discountPercentage > 0) {
        discountApplied = round2(discountPercentage);
        discountAmount = round2((totalAmount * discountApplied) / 100);
        finalAmount = round2(Math.max(0, totalAmount - discountAmount));
      }
    }

    const advanceAmount = round2(finalAmount * ADVANCE_RATE);
    const remainingAmount = round2(finalAmount - advanceAmount);

    const bookingPayload = {
      farmer: req.user._id,
      operator: resolvedOperatorId,
      tractor: resolvedTractorId,
      status: "pending",
      paymentStatus: "no_payment",
      landArea: land,
      serviceType: serviceTypeTrimmed,
      date: bookingDate,
      time: time != null && typeof time === "string" ? time.trim() : "",
      address: address != null && typeof address === "string" ? address.trim() : "",
      baseAmount,
      gstAmount,
      platformFee,
      totalAmount: totalAmount,
      discountApplied,
      discountAmount,
      estimatedAmount: finalAmount,
      finalAmount: finalAmount,
      advancePayment: advanceAmount,
      advanceAmount,
      remainingAmount,
      seasonalMultiplier,
      seasonalPricingId: seasonalPricing?._id || null,
    };

    // Distributed lock: prevent concurrent create attempts for same farmer and same machine-slot.
    const lockTtlMs = 30_000;
    const farmerLockKey = `lock:booking:create:farmer:${String(req.user._id)}`;
    const slotLockKey = `lock:booking:slot:${String(resolvedTractorId)}:${bookingDate.toISOString().slice(0, 10)}:${String(time || "").trim()}`;
    const locks = [];
    const acquireOrHandle = async (key) => {
      const lock = await acquireLock(key, lockTtlMs);
      if (!lock.acquired) {
        throw new AppError("Booking is being processed. Please retry.", 409, {
          code: "BOOKING_LOCKED",
          retryable: true,
        });
      }
      locks.push({ key, token: lock.token });
    };
    // Acquire in deterministic order to avoid deadlocks.
    await acquireOrHandle(farmerLockKey);
    await acquireOrHandle(slotLockKey);

    let booking;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const dup = await Booking.findOne({
          farmer: req.user._id,
          status: { $in: FARMER_DUPLICATE_BOOKING_STATUSES },
        })
          .session(session)
          .lean();
        if (dup) {
          throw new AppError(userFacing.DUPLICATE_BOOKING.message, 409, {
            code: userFacing.DUPLICATE_BOOKING.code,
            userTip: userFacing.DUPLICATE_BOOKING.userTip,
            retryable: userFacing.DUPLICATE_BOOKING.retryable,
          });
        }
        const [created] = await Booking.create([bookingPayload], { session });
        booking = created;
      });
    } catch (err) {
      if (err instanceof AppError) {
        throw err;
      }
      if (isFarmerActiveBookingDuplicateKey(err)) {
        throw new AppError(userFacing.DUPLICATE_BOOKING.message, 409, {
          code: userFacing.DUPLICATE_BOOKING.code,
          userTip: userFacing.DUPLICATE_BOOKING.userTip,
          retryable: userFacing.DUPLICATE_BOOKING.retryable,
        });
      }
      if (isMachineSlotBookingDuplicateKey(err)) {
        throw new AppError(userFacing.SLOT_TAKEN.message, 409, {
          code: userFacing.SLOT_TAKEN.code,
          userTip: userFacing.SLOT_TAKEN.userTip,
          retryable: userFacing.SLOT_TAKEN.retryable,
        });
      }
      throw err;
    } finally {
      await session.endSession();
      // Release locks best-effort.
      for (const l of locks.reverse()) {
        try {
          await releaseLock(l.key, l.token);
        } catch {
          // ignore
        }
      }
    }
    if (!booking || !booking._id) {
      logger.error("[BOOKING_ERROR] createBooking produced no persisted document", {
        tag: "BOOKING_ERROR",
        operation: "createBooking",
        userId: req.user?._id ? String(req.user._id) : null,
      });
      throw new AppError(userFacing.BOOKING_FAILED.message, 500, {
        code: userFacing.BOOKING_FAILED.code,
        userTip: userFacing.BOOKING_FAILED.userTip,
        retryable: userFacing.BOOKING_FAILED.retryable,
      });
    }
    logger.info("[EVENT] Booking created", {
      requestId: req.requestId || null,
      userId: req.user?._id ? String(req.user._id) : null,
      bookingId: booking._id.toString(),
      paymentId: null,
      action: "booking.create",
      status: "CREATED",
      timestamp: new Date().toISOString(),
    });
    void logAuditAction(req.user?._id, "BOOKING_CREATED");

    await notifyUser({
      req,
      app: null,
      userId: resolvedOperatorId,
      message: "New booking request received.",
      type: "booking",
      title: "New booking request",
      bookingId: booking._id,
    });

    const bookingPopulated = await Booking.findById(booking._id).populate(
      "tractor",
      "tractorType brand model registrationNumber machineryTypes tractorPhoto isAvailable verificationStatus"
    );

    return sendSuccess(res, 201, "Booking created successfully.", {
      booking: withStatusMessage(bookingPopulated),
      pricingBreakdown: {
        baseAmount: booking.baseAmount,
        gstAmount: booking.gstAmount,
        platformFee: booking.platformFee,
        totalAmount: booking.totalAmount,
        discountApplied: booking.discountApplied,
        discountAmount: booking.discountAmount,
        finalAmount: booking.finalAmount,
        advanceAmount: booking.advanceAmount,
        remainingAmount: booking.remainingAmount,
        // Derived earnings (non-breaking; do not change DB fields)
        operatorEarning: booking.baseAmount,
        platformEarning: booking.platformFee,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function respondToBooking(req, res, next) {
  try {
    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only operators can respond to bookings.");
    }

    const { id } = req.params;
    const { action } = req.body;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid booking id is required.");
    }

    if (action === undefined || action === null) {
      res.status(400);
      throw new Error("action is required.");
    }

    if (typeof action !== "string") {
      res.status(400);
      throw new Error('action must be a string: "accept" or "reject".');
    }

    const normalized = action.trim().toLowerCase();
    if (!normalized) {
      res.status(400);
      throw new Error('action must be "accept" or "reject".');
    }

    if (!["accept", "reject"].includes(normalized)) {
      res.status(400);
      throw new Error('action must be "accept" or "reject".');
    }

    const booking = await Booking.findById(id);

    if (!booking) {
      res.status(404);
      throw new Error("Booking not found.");
    }

    if (!booking.operator.equals(req.user._id)) {
      res.status(403);
      throw new Error("You can only respond to bookings assigned to you.");
    }

    assertNotActionBlocked(booking);
    if (booking.status !== "pending") {
      throw new AppError(
        `Cannot accept/reject unless booking status is pending (current: ${booking.status}).`,
        400,
        {
          code: "INVALID_BOOKING_TRANSITION",
          userTip: "This booking is already in progress. Try the correct next step.",
          retryable: false,
        }
      );
    }

    const throwIfNoAtomicMatch = async () => {
      const fresh = await Booking.findById(id);
      if (!fresh) {
        res.status(404);
        throw new Error("Booking not found.");
      }
      if (!fresh.operator.equals(req.user._id)) {
        res.status(403);
        throw new Error("You can only respond to bookings assigned to you.");
      }
      assertNotActionBlocked(fresh);
      if (fresh.status === "pending") {
        throw new AppError(userFacing.BOOKING_FAILED.message, 400, {
          code: userFacing.BOOKING_FAILED.code,
          userTip: userFacing.BOOKING_FAILED.userTip,
          retryable: userFacing.BOOKING_FAILED.retryable,
        });
      }
      throw new AppError(
        `Cannot accept/reject unless booking status is pending (current: ${fresh.status}).`,
        400,
        {
          code: "INVALID_BOOKING_TRANSITION",
          userTip: "This booking is already in progress. Try the correct next step.",
          retryable: false,
        }
      );
    };

    let bookingAfter;

    if (normalized === "accept") {
      const eligible = await canOperatorServeBookings(req.user._id);
      if (!eligible) {
        throw new AppError(
          "You must be verified and have at least one approved, available tractor before accepting bookings.",
          403,
          {
            code: "OPERATOR_NOT_ELIGIBLE",
            userTip: "Complete KYC and tractor verification, then try again.",
            retryable: false,
          }
        );
      }

      const otherBusy = {
        operator: req.user._id,
        _id: { $ne: booking._id },
        status: { $in: OPERATOR_RESPOND_BUSY_STATUSES },
      };

      const operatorBusy = await Booking.exists(otherBusy);
      if (operatorBusy) {
        throw new AppError(userFacing.OPERATOR_BUSY.message, 409, {
          code: userFacing.OPERATOR_BUSY.code,
          userTip: userFacing.OPERATOR_BUSY.userTip,
          retryable: userFacing.OPERATOR_BUSY.retryable,
        });
      }

      const slotTaken = await Booking.exists({
        operator: req.user._id,
        _id: { $ne: booking._id },
        date: booking.date,
        time: booking.time,
        status: { $in: OPERATOR_RESPOND_BUSY_STATUSES },
      });
      if (slotTaken) {
        throw new AppError(userFacing.SLOT_TAKEN.message, 409, {
          code: userFacing.SLOT_TAKEN.code,
          userTip: userFacing.SLOT_TAKEN.userTip,
          retryable: userFacing.SLOT_TAKEN.retryable,
        });
      }

      const now = new Date();
      const acceptSet = {
        status: "accepted",
        respondedAt: now,
        acceptedAt: now,
      };
      if (booking.paymentStatus === "no_payment") {
        acceptSet.paymentStatus = "advance_due";
      }

      assertBookingTransition("pending", "accepted", "accept booking");
      logStatusTransition({
        event: "[BOOKING_TRANSITION] operator accept",
        bookingId: booking._id,
        userId: req.user?._id,
        before: { status: booking.status },
        after: { status: "accepted" },
      });

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          // Atomic global operator guard (as requested): prevent accepting when operator has an active booking.
          const existingActive = await Booking.findOne({
            operator: req.user._id,
            _id: { $ne: booking._id },
            status: { $in: ["accepted", "in_progress"] },
          })
            .session(session)
            .lean();
          if (existingActive) {
            const err = new Error("Operator already has active booking");
            err.code = "OPERATOR_ALREADY_ACTIVE";
            throw err;
          }

          bookingAfter = await Booking.findOneAndUpdate(
            {
              _id: booking._id,
              operator: req.user._id,
              status: "pending",
            },
            { $set: acceptSet },
            { returnDocument: "after", session }
          );

          if (!bookingAfter) {
            const err = new Error("Booking already accepted");
            err.code = "BOOKING_ALREADY_ACCEPTED";
            throw err;
          }
        });
      } catch (txErr) {
        if (txErr?.code === "OPERATOR_ALREADY_ACTIVE") {
          res.status(409);
          throw new Error("Operator already has active booking");
        }
        if (txErr?.code === "BOOKING_ALREADY_ACCEPTED") {
          res.status(409);
          throw new Error("Booking already accepted");
        }
        throw txErr;
      } finally {
        await session.endSession();
      }

      logger.info("[EVENT] Booking accepted", {
        type: "BOOKING",
        action: "booking.accept",
        status: "ACCEPTED",
        timestamp: new Date().toISOString(),
        requestId: req.requestId || null,
        userId: req.user?._id ? String(req.user._id) : null,
        bookingId: bookingAfter?._id ? String(bookingAfter._id) : null,
        paymentId: null,
      });

      await notifyUser({
        req,
        app: null,
        userId: bookingAfter.farmer,
        message: "Your booking was accepted by the operator.",
        type: "booking",
        title: "Booking accepted",
        bookingId: bookingAfter._id,
      });
    } else {
      const now = new Date();
      assertBookingTransition("pending", "rejected", "reject booking");
      bookingAfter = await Booking.findOneAndUpdate(
        {
          _id: booking._id,
          operator: req.user._id,
          status: "pending",
        },
        { $set: { status: "rejected", respondedAt: now } },
        { returnDocument: "after" }
      );

      if (!bookingAfter) {
        await throwIfNoAtomicMatch();
      }
    }

    return sendSuccess(
      res,
      200,
      normalized === "accept" ? "Booking accepted successfully." : "Booking rejected successfully.",
      { booking: withStatusMessage(bookingAfter) }
    );
  } catch (error) {
    return next(error);
  }
}

async function payAdvance(req, res, next) {
  let paymentLock = null;
  let paymentLockKey = "";
  try {
    if (req.user.role !== "farmer") {
      res.status(403);
      throw new Error("Only farmers can pay advance for a booking.");
    }
    if (!isPaymentsEnabled()) {
      return next(
        new AppError("Payments are disabled.", 503, {
          code: "PAYMENTS_DISABLED",
          userTip: "Payments are temporarily unavailable.",
          retryable: true,
        })
      );
    }

    const { id } = req.params;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid booking id is required.");
    }

    const paymentMethod = req.body?.paymentMethod;
    const transactionId =
      req.body?.transactionId != null ? String(req.body.transactionId).trim() : "";
    if (!paymentMethod) {
      res.status(400);
      throw new Error('paymentMethod must be "upi".');
    }
    if (paymentMethod === "cash") {
      res.status(400);
      throw new Error("Cash payments are not supported");
    }
    if (paymentMethod !== "upi") {
      res.status(400);
      throw new Error('paymentMethod must be "upi".');
    }

    const orderId =
      req.body?.orderId != null ? String(req.body.orderId).trim() : "";
    const paymentId =
      req.body?.paymentId != null ? String(req.body.paymentId).trim() : "";
    logger.info("[EVENT] Payment initiated", {
      ...buildPaymentLogContext({ req, bookingId: id, paymentId, stage: "advance" }),
      action: "payment.start",
      status: "INITIATED",
    });
    // Strict payment-level lock: prevents concurrent processing for same paymentId.
    // Must be released at the end of the request.
    paymentLockKey = paymentId ? `lock:payment:${paymentId}` : "";
    if (paymentLockKey) {
      paymentLock = await acquireLock(paymentLockKey, 30_000);
      if (!paymentLock?.acquired) {
        return res.status(409).json({ success: false, message: "Payment already processing" });
      }
    }

    if (paymentMethod === "upi") {
      const isProduction = String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
      const sigRaw = req.body?.signature ?? req.body?.razorpay_signature;
      const sig = sigRaw != null ? String(sigRaw).trim() : "";
      if (isProduction && (!orderId || !paymentId || !sig)) {
        res.status(400);
        throw new Error("orderId, paymentId and signature are required for UPI payment verification.");
      }
      let vr;
      try {
        vr = await verifyPayment({
          orderId,
          paymentId,
          signature: sig,
          razorpay_order_id: orderId,
          razorpay_payment_id: paymentId,
          razorpay_signature: sig,
        });
      } catch (error) {
        logger.error("[EVENT] Payment failed", {
          ...buildPaymentLogContext({ req, bookingId: id, paymentId, stage: "advance", error }),
          action: "payment.failed",
          status: "FAILED",
        });
        logger.error("Payment verification call failed", {
          bookingId: id.toString(),
          paymentStage: "advance",
          message: error?.message || String(error),
        });
        res.status(400);
        throw new Error("Payment verification failed, try again");
      }
      if (!vr.verified && isProduction) {
        logger.error("[EVENT] Payment failed", {
          ...buildPaymentLogContext({ req, bookingId: id, paymentId, stage: "advance" }),
          action: "payment.failed",
          status: "FAILED",
          error: "Payment verification failed",
        });
        logger.warn("Payment verification failed", { bookingId: id.toString(), paymentStage: "advance" });
        res.status(400);
        throw new Error("Payment verification failed, try again");
      }
    }

    // Fetch booking before any payment idempotency/creation logic.
    const booking = await Booking.findById(id).lean();
    if (!booking) {
      res.status(404);
      throw new Error("Booking not found.");
    }
    if (!booking.farmer || String(booking.farmer) !== String(req.user._id)) {
      res.status(403);
      throw new Error("You can only pay advance for your own bookings.");
    }
    // Disallow payments for terminal booking states (cancelled/closed/rejected).
    assertPaymentNotTerminal(booking);

    // Prevent re-use of a paymentId across different bookings (best-effort integrity check).
    if (paymentId) {
      const reused = await isPaymentIdReused(paymentId, booking._id);
      if (reused) {
        logger.warn("PaymentId reuse detected (advance)", { bookingId: id.toString() });
        res.status(400);
        throw new Error("Invalid payment reference.");
      }
    }

    // Idempotency: if payment already exists for this booking+type, return it.
    // IMPORTANT: treat PENDING as already-created to prevent duplicate processing.
    const existingPayment = await Payment.findOne({
      bookingId: id,
      type: "advance",
      status: { $in: ["PENDING", "SUCCESS"] },
    }).lean();
    if (existingPayment) {
      const latestBooking = await Booking.findById(id).lean();
      if (!latestBooking) {
        res.status(404);
        throw new Error("Booking not found.");
      }
      if (!latestBooking.farmer || String(latestBooking.farmer) !== String(req.user._id)) {
        res.status(403);
        throw new Error("You can only pay advance for your own bookings.");
      }
      assertPaymentNotTerminal(latestBooking);

      return sendSuccess(res, 200, "Advance payment already recorded.", {
        booking: withStatusMessage(latestBooking),
        payment: existingPayment,
      });
    }

    const session = await mongoose.startSession();
    let updatedBooking;
    let payment;
    const lockKey = `lock:payment:advance:${String(id)}`;
    const lock = await acquireLock(lockKey, 30_000);
    if (!lock.acquired && isProduction()) {
      res.status(409);
      throw new Error("Payment is already being processed. Please retry.");
    }
    if (!lock.acquired && !isProduction()) {
      logger.warn("[lock] payAdvance lock contention (dev continues)", { bookingId: String(id) });
    }
    try {
      await session.withTransaction(async () => {
        const row = await Booking.findOne({
          _id: id,
          farmer: req.user._id,
          status: "accepted",
          paymentStatus: "advance_due",
        }).session(session);

        if (!row) {
          const err = new Error("BOOKING_PAY_TX_NO_MATCH");
          err.code = "BOOKING_PAY_TX_NO_MATCH";
          throw err;
        }

        const advanceAmt = Number(row.advanceAmount || row.advancePayment || 0);
        if (!Number.isFinite(advanceAmt) || advanceAmt <= 0) {
          const err = new Error("BOOKING_PAY_TX_BAD_ADVANCE");
          err.code = "BOOKING_PAY_TX_BAD_ADVANCE";
          throw err;
        }

        const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
        const isProduction = nodeEnv === "production";
        const skipRazorpayAmountVerification = !isProduction;

        if (!skipRazorpayAmountVerification) {
          // Amount integrity (always enforced server-side):
          // Compare server-calculated expected amount with Razorpay payment amount.
          const fetched = await fetchPaymentAmountRupees(paymentId);
          if (!fetched.ok) {
            const err = new Error("BOOKING_PAY_TX_RZP_FETCH_FAILED");
            err.code = "BOOKING_PAY_TX_RZP_FETCH_FAILED";
            throw err;
          }
          const expected = Number(advanceAmt);
          const actual = Number(fetched.amountRupees);
          if (!Number.isFinite(actual) || Math.abs(actual - expected) > 0.01) {
            const err = new Error("BOOKING_PAY_TX_AMOUNT_MISMATCH");
            err.code = "BOOKING_PAY_TX_AMOUNT_MISMATCH";
            err.meta = { expected, actual };
            throw err;
          }
        } else {
          logger.warn("DEV MODE: Skipping Razorpay advance amount verification", {
            bookingId: id.toString(),
            paymentStage: "advance",
          });
        }

        const [createdPayment] = await Payment.create(
          [
            {
              bookingId: row._id,
              userId: req.user._id,
              amount: advanceAmt,
              type: "advance",
              status: "PENDING",
              paymentMethod,
              transactionId,
              orderId,
              paymentId,
            },
          ],
          { session }
        );
        payment = createdPayment;

        // Do NOT confirm before webhook success.
        assertBookingTransition("accepted", "payment_pending", "record advance payment");
        const lockExpiresAt = new Date(Date.now() + PAYMENT_PENDING_TTL_MS);
        const upd = await Booking.findOneAndUpdate(
          { _id: id, farmer: req.user._id, status: "accepted", paymentStatus: "advance_due" },
          { $set: { paymentStatus: "advance_paid", status: "payment_pending", lockExpiresAt } },
          { returnDocument: "after", session }
        );

        if (!upd) {
          const err = new Error("BOOKING_PAY_TX_RACE");
          err.code = "BOOKING_PAY_TX_RACE";
          throw err;
        }
        updatedBooking = upd;
      });
    } catch (e) {
      if (e && (e.code === 11000 || e.code === 11001)) {
        payment = await Payment.findOne({
          bookingId: id,
          type: "advance",
          status: { $in: ["PENDING", "SUCCESS"] },
        }).lean();
        if (payment) {
          const latestBooking = await Booking.findById(id).lean();
          if (!latestBooking) {
            res.status(404);
            throw new Error("Booking not found.");
          }
          if (!latestBooking.farmer || String(latestBooking.farmer) !== String(req.user._id)) {
            res.status(403);
            throw new Error("You can only pay advance for your own bookings.");
          }
          assertPaymentNotTerminal(latestBooking);
          return sendSuccess(res, 200, "Advance payment already recorded.", {
            booking: withStatusMessage(latestBooking),
            payment,
          });
        }
      }

      const retryPayment = await Payment.findOne({
        bookingId: id,
        type: "advance",
        status: { $in: ["PENDING", "SUCCESS"] },
      }).lean();
      if (retryPayment) {
        const latestBooking = await Booking.findById(id).lean();
        if (!latestBooking) {
          res.status(404);
          throw new Error("Booking not found.");
        }
        if (!latestBooking.farmer || String(latestBooking.farmer) !== String(req.user._id)) {
          res.status(403);
          throw new Error("You can only pay advance for your own bookings.");
        }
        assertPaymentNotTerminal(latestBooking);
        return sendSuccess(res, 200, "Advance payment already recorded.", {
          booking: withStatusMessage(latestBooking),
          payment: retryPayment,
        });
      }

      if (e && e.code === "BOOKING_PAY_TX_AMOUNT_MISMATCH") {
        logger.warn("Advance payment amount mismatch", { bookingId: id.toString() });
        res.status(400);
        throw new Error("Payment amount mismatch.");
      }
      if (e && e.code === "BOOKING_PAY_TX_RZP_FETCH_FAILED") {
        logger.warn("Razorpay payment fetch failed (advance)", { bookingId: id.toString() });
        res.status(400);
        throw new Error("Payment verification failed.");
      }
      if (e && e.code === "BOOKING_PAY_TX_BAD_ADVANCE") {
        res.status(400);
        throw new Error("Advance amount is not available for this booking.");
      }
      if (
        e &&
        (e.code === "BOOKING_PAY_TX_NO_MATCH" ||
          e.code === "BOOKING_PAY_TX_RACE" ||
          e.code === 11000 ||
          e.code === 11001)
      ) {
        res.status(400);
        throw new Error("Cannot process payment for this booking");
      }
      throw e;
    } finally {
      session.endSession();
      try {
        await releaseLock(lockKey, lock.token);
      } catch {
        // ignore
      }
    }

    if (!payment || !updatedBooking) {
      res.status(400);
      throw new Error("Cannot process payment for this booking");
    }

    logger.info("[EVENT] Payment recorded (awaiting webhook confirmation)", {
      requestId: req.requestId || null,
      userId: req.user?._id ? String(req.user._id) : null,
      bookingId: id.toString(),
      amount: Number(payment?.amount) || 0,
      paymentType: "advance",
      paymentId: paymentId || null,
      idempotencyKey: req.get("Idempotency-Key") || null,
      action: "payment.create",
      status: "PENDING",
      timestamp: new Date().toISOString(),
    });
    logger.info("[EVENT] Payment initiated, awaiting verification", {
      ...buildPaymentLogContext({ req, bookingId: id, paymentId, stage: "advance" }),
      action: "payment.awaiting_verification",
      status: "PENDING",
    });
    void logAuditAction(req.user?._id, "PAYMENT_ADVANCE_SUCCESS");

    await logPaymentSuccess({
      userId: req.user._id,
      bookingId: updatedBooking._id,
      amount: payment?.amount ?? 0,
      ledgerKey: payment?._id ? `payment:${payment._id}` : undefined,
    });

    await notifyAdvanceReceived(req, updatedBooking.operator, updatedBooking._id);
    schedulePaymentRecoveryCheck({ paymentId, bookingId: id });
    await notifyUser({
      req,
      app: null,
      userId: updatedBooking.farmer,
      message: "Payment initiated, awaiting verification",
      type: "payment",
      title: "Payment initiated, awaiting verification",
      bookingId: updatedBooking._id,
    });

    return sendSuccess(res, 200, "Advance payment recorded successfully.", {
      booking: withStatusMessage(updatedBooking),
      payment,
      paymentPending: true,
    });
  } catch (error) {
    logger.error("[EVENT] Payment failed", {
      ...buildPaymentLogContext({
        req,
        bookingId: req?.params?.id,
        paymentId: req?.body?.paymentId != null ? String(req.body.paymentId).trim() : "",
        stage: "advance",
        error,
      }),
      action: "payment.failed",
      status: "FAILED",
    });
    return next(error);
  } finally {
    // Best-effort release of strict payment lock
    try {
      if (typeof paymentLockKey === "string" && paymentLockKey && paymentLock?.token) {
        await releaseLock(paymentLockKey, paymentLock.token);
      }
    } catch {
      // ignore
    }
  }
}

async function startJob(req, res, next) {
  try {
    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only operators can start a job.");
    }

    const { id } = req.params;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid booking id is required.");
    }

    const phaseRaw = req.body?.phase;
    const phase =
      typeof phaseRaw === "string" ? phaseRaw.trim().toLowerCase() : "start";

    const booking = await Booking.findById(id);

    if (!booking) {
      res.status(404);
      throw new Error("Booking not found.");
    }

    if (!booking.operator.equals(req.user._id)) {
      res.status(403);
      throw new Error("You can only start jobs for your own bookings.");
    }

    assertNotActionBlocked(booking);
    assertStatus(booking, ["confirmed", "en_route"], "start job");
    assertPaymentStatus(booking, ["advance_paid"], "start job");

    if (phase === "en_route") {
      throw new AppError(
        "en_route is not allowed in the production booking lifecycle. Use phase 'start' to move to in_progress.",
        400,
        { code: "INVALID_BOOKING_TRANSITION", retryable: false }
      );
    }

    booking.status = "in_progress";
    booking.startTime = new Date();
    // Initialize job progress for the new lifecycle fields.
    booking.progress = 0;
    booking.progressImages = [];

    await notifyUser({
      req,
      app: null,
      userId: booking.farmer,
      message: "The operator has started the job.",
      type: "job",
      title: "Job started",
      bookingId: booking._id,
    });

    await booking.save();
    logger.info(`[EVENT] Job started: ${booking._id.toString()}`);

    return sendSuccess(res, 200, "Job started successfully.", {
      booking: withStatusMessage(booking),
    });
  } catch (error) {
    return next(error);
  }
}

async function completeJob(req, res, next) {
  try {
    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only operators can complete a job.");
    }

    const { id } = req.params;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid booking id is required.");
    }

    const booking = await Booking.findById(id);

    if (!booking) {
      res.status(404);
      throw new Error("Booking not found.");
    }

    if (!booking.operator.equals(req.user._id)) {
      res.status(403);
      throw new Error("You can only complete jobs for your own bookings.");
    }

    assertNotActionBlocked(booking);
    assertStatus(booking, ["in_progress"], "complete job");
    assertPaymentStatus(booking, ["advance_paid"], "complete job");

    if (!booking.startTime) {
      res.status(400);
      throw new Error("Cannot complete job before it has been started.");
    }

    booking.status = "completed";
    booking.paymentStatus = "balance_due";
    // Mark completion progress (do not finalize payment here; existing flow remains unchanged).
    booking.progress = 100;
    if (req.body?.finalAmount !== undefined && req.body?.finalAmount !== null && req.body?.finalAmount !== "") {
      const finalAmount = Number(req.body.finalAmount);
      if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
        res.status(400);
        throw new Error("finalAmount must be a positive number.");
      }
      booking.finalAmount = finalAmount;
      booking.priceDifferenceReason =
        typeof req.body?.priceDifferenceReason === "string" ? req.body.priceDifferenceReason.trim() : "";
      booking.remainingAmount = round2(Math.max(0, finalAmount - (booking.advanceAmount || 0)));
    }
    booking.endTime = new Date();
    await booking.save();
    logger.info(`[EVENT] Job completed: ${booking._id.toString()}`);

    await notifyUser({
      req,
      app: null,
      userId: booking.farmer,
      message: "Job completed. Please pay remaining amount",
      type: "job",
      title: "Job completed",
      bookingId: booking._id,
    });
    await notifyUser({
      req,
      app: null,
      userId: booking.farmer,
      message: "Payment pending: please complete the remaining balance.",
      type: "payment",
      title: "Payment pending",
      bookingId: booking._id,
    });

    return sendSuccess(res, 200, "Job completed successfully.", {
      booking: withStatusMessage(booking),
    });
  } catch (error) {
    return next(error);
  }
}

async function updateBookingProgress(req, res, next) {
  try {
    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only operators can update job progress.");
    }

    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid booking id is required.");
    }

    const booking = await Booking.findById(id);
    if (!booking) {
      res.status(404);
      throw new Error("Booking not found.");
    }

    if (!booking.operator.equals(req.user._id)) {
      res.status(403);
      throw new Error("You can only update progress for your own bookings.");
    }

    assertNotActionBlocked(booking);
    assertStatus(booking, ["in_progress"], "update progress");

    // Multipart form-data often sends numeric fields as strings.
    // Convert safely so subsequent validations/guards work consistently.
    if (typeof req.body?.progress === "string") {
      req.body.progress = Number(req.body.progress);
    }

    const progressRaw = req.body?.progress;
    const progress =
      typeof progressRaw === "number" ? progressRaw : Number(progressRaw);

    if (!Number.isFinite(progress)) {
      res.status(400);
      throw new Error("progress must be a valid number.");
    }

    booking.progress = progress;

    const fs = require("fs");
    const path = require("path");

    const normalizeBodyImages = (images) => {
      if (images == null) return [];
      return Array.isArray(images) ? images : [images];
    };

    const getFileInputsFromReqFiles = (files) => {
      if (!files) return [];
      if (Array.isArray(files)) return files;
      if (typeof files !== "object") return [];
      // Typical multer shape: { images: [file, file] }.
      return Object.values(files).flatMap((v) => {
        if (!v) return [];
        if (Array.isArray(v)) return v;
        return [v];
      });
    };

    const bodyInputs = normalizeBodyImages(req.body?.images);
    const fileInputs = getFileInputsFromReqFiles(req.files);

    const combinedInputs = [...fileInputs, ...bodyInputs].slice(0, 5);
    const nonEmptyInputs = combinedInputs.filter((x) => x != null);

    let successfulUrls = [];
    let allImagesUploadedOrResolved = true;

    const resolveImageInputToUrl = async (img) => {
      // Direct URL string
      if (typeof img === "string") {
        const s = img.trim();
        return s ? s : "";
      }

      // { url: "..." }
      if (img && typeof img === "object" && typeof img.url === "string") {
        const s = img.url.trim();
        return s ? s : "";
      }

      // Multer memory: { buffer, originalname, mimetype }
      if (img && typeof img === "object" && Buffer.isBuffer(img.buffer)) {
        const uploadedUrl = await resolveDocumentInput(img);
        return typeof uploadedUrl === "string" ? uploadedUrl : "";
      }

      // Multer disk: { path, originalname, mimetype }
      if (img && typeof img === "object" && typeof img.path === "string" && img.path) {
        const buffer = await fs.promises.readFile(img.path);
        const originalname =
          typeof img.originalname === "string" && img.originalname.trim()
            ? img.originalname.trim()
            : path.basename(img.path);
        const mimetype =
          typeof img.mimetype === "string" && img.mimetype.trim()
            ? img.mimetype.trim()
            : "application/octet-stream";

        const uploaded = await uploadFile({ buffer, originalname, mimetype });
        return uploaded?.url || "";
      }

      return "";
    };

    if (nonEmptyInputs.length > 0) {
      await Promise.all(
        nonEmptyInputs.map(async (img) => {
          try {
            const url = await resolveImageInputToUrl(img);
            const normalized = typeof url === "string" ? url.trim() : "";
            if (normalized) {
              successfulUrls.push(normalized);
            } else {
              allImagesUploadedOrResolved = false;
            }
          } catch (e) {
            allImagesUploadedOrResolved = false;
            logger.error(`[ERROR] Progress image upload failed: bookingId=${booking._id}`, {
              error: e?.message || String(e),
            });
          }
        })
      );

      // Partial success: store only successfully uploaded URLs.
      if (successfulUrls.length > 0) {
        booking.progressImages = successfulUrls.slice(0, 5);
      }
    }

    await booking.save();

    // Best-effort: notify farmer about progress update.
    try {
      await notifyUser({
        req,
        app: null,
        userId: booking.farmer,
        message: `Operator updated job progress to ${progress}%.`,
        type: "job",
        title: "Job progress updated",
        bookingId: booking._id,
      });
    } catch {
      // Do not fail the API if notifications fail.
    }

    const imagesUploaded = nonEmptyInputs.length === 0 ? false : allImagesUploadedOrResolved;

    return sendSuccess(res, 200, "Job progress updated successfully.", {
      booking: withStatusMessage(booking),
      progress: booking.progress,
      imagesUploaded,
    });
  } catch (error) {
    return next(error);
  }
}

async function payRemaining(req, res, next) {
  let paymentLock = null;
  let paymentLockKey = "";
  try {
    if (req.user.role !== "farmer") {
      res.status(403);
      throw new Error("Only farmers can pay the remaining amount.");
    }
    if (!isPaymentsEnabled()) {
      return next(
        new AppError("Payments are disabled.", 503, {
          code: "PAYMENTS_DISABLED",
          userTip: "Payments are temporarily unavailable.",
          retryable: true,
        })
      );
    }

    const { id } = req.params;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid booking id is required.");
    }

    const paymentMethod = req.body?.paymentMethod;
    const transactionId =
      req.body?.transactionId != null ? String(req.body.transactionId).trim() : "";
    if (!paymentMethod) {
      res.status(400);
      throw new Error('paymentMethod must be "upi".');
    }
    if (paymentMethod === "cash") {
      res.status(400);
      throw new Error("Cash payments are not supported");
    }
    if (paymentMethod !== "upi") {
      res.status(400);
      throw new Error('paymentMethod must be "upi".');
    }

    const orderId =
      req.body?.orderId != null ? String(req.body.orderId).trim() : "";
    const paymentId =
      req.body?.paymentId != null ? String(req.body.paymentId).trim() : "";
    logger.info("[EVENT] Payment initiated", {
      ...buildPaymentLogContext({ req, bookingId: id, paymentId, stage: "remaining" }),
      action: "payment.start",
      status: "INITIATED",
    });
    // Strict payment-level lock: prevents concurrent processing for same paymentId.
    // Must be released at the end of the request.
    paymentLockKey = paymentId ? `lock:payment:${paymentId}` : "";
    if (paymentLockKey) {
      paymentLock = await acquireLock(paymentLockKey, 30_000);
      if (!paymentLock?.acquired) {
        return res.status(409).json({ success: false, message: "Payment already processing" });
      }
    }

    if (paymentMethod === "upi") {
      const isProduction = String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
      const sigRaw = req.body?.signature ?? req.body?.razorpay_signature;
      const sig = sigRaw != null ? String(sigRaw).trim() : "";
      if (isProduction && (!orderId || !paymentId || !sig)) {
        res.status(400);
        throw new Error("orderId, paymentId and signature are required for UPI payment verification.");
      }
      let vr;
      try {
        vr = await verifyPayment({
          orderId,
          paymentId,
          signature: sig,
          razorpay_order_id: orderId,
          razorpay_payment_id: paymentId,
          razorpay_signature: sig,
        });
      } catch (error) {
        logger.error("[EVENT] Payment failed", {
          ...buildPaymentLogContext({ req, bookingId: id, paymentId, stage: "remaining", error }),
          action: "payment.failed",
          status: "FAILED",
        });
        logger.error("Payment verification call failed", {
          bookingId: id.toString(),
          paymentStage: "remaining",
          message: error?.message || String(error),
        });
        res.status(400);
        throw new Error("Payment verification failed, try again");
      }
      if (!vr.verified && isProduction) {
        logger.error("[EVENT] Payment failed", {
          ...buildPaymentLogContext({ req, bookingId: id, paymentId, stage: "remaining" }),
          action: "payment.failed",
          status: "FAILED",
          error: "Payment verification failed",
        });
        logger.warn("Payment verification failed", { bookingId: id.toString(), paymentStage: "remaining" });
        res.status(400);
        throw new Error("Payment verification failed, try again");
      }
    }

    // Fetch booking before any payment idempotency/creation logic.
    const booking = await Booking.findById(id).lean();
    if (!booking) {
      res.status(404);
      throw new Error("Booking not found.");
    }
    if (!booking.farmer || String(booking.farmer) !== String(req.user._id)) {
      res.status(403);
      throw new Error("You can only pay remaining balance for your own bookings.");
    }
    // Disallow payments for terminal booking states (cancelled/closed/rejected).
    assertPaymentNotTerminal(booking);

    // Prevent re-use of a paymentId across different bookings (best-effort integrity check).
    if (paymentId) {
      const reused = await isPaymentIdReused(paymentId, booking._id);
      if (reused) {
        logger.warn("PaymentId reuse detected (remaining)", { bookingId: id.toString() });
        res.status(400);
        throw new Error("Invalid payment reference.");
      }
    }

    // Idempotency: if payment already exists (PENDING or SUCCESS), return it.
    const existingPayment = await Payment.findOne({
      bookingId: id,
      type: "remaining",
      status: { $in: ["PENDING", "SUCCESS"] },
    }).lean();
    if (existingPayment) {
      const latestBooking = await Booking.findById(id).lean();
      if (!latestBooking) {
        res.status(404);
        throw new Error("Booking not found.");
      }
      if (!latestBooking.farmer || String(latestBooking.farmer) !== String(req.user._id)) {
        res.status(403);
        throw new Error("You can only pay remaining balance for your own bookings.");
      }
      const idempotentPaid =
        latestBooking.status === "closed" && isPaidLikePaymentStatus(latestBooking.paymentStatus);
      if (!idempotentPaid) {
        assertPaymentNotTerminal(latestBooking);
      }
      if (latestBooking.status === "closed" && isPaidLikePaymentStatus(latestBooking.paymentStatus)) {
        await applyBookingSettlementAfterFullPayment(id);
      }
      const settledBooking =
        (await Booking.findById(id).lean()) || latestBooking;

      return sendSuccess(res, 200, "Remaining payment already recorded.", {
        booking: withStatusMessage(settledBooking),
        payment: existingPayment,
      });
    }

    const session = await mongoose.startSession();
    let updatedBooking;
    let payment;
    const lockKey = `lock:payment:remaining:${String(id)}`;
    const lock = await acquireLock(lockKey, 30_000);
    if (!lock.acquired && isProduction()) {
      res.status(409);
      throw new Error("Payment is already being processed. Please retry.");
    }
    if (!lock.acquired && !isProduction()) {
      logger.warn("[lock] payRemaining lock contention (dev continues)", { bookingId: String(id) });
    }
    try {
      await session.withTransaction(async () => {
        const row = await Booking.findOne({
          _id: id,
          farmer: req.user._id,
          status: "completed",
          paymentStatus: "balance_due",
        }).session(session);

        if (!row) {
          const err = new Error("BOOKING_PAY_TX_NO_MATCH");
          err.code = "BOOKING_PAY_TX_NO_MATCH";
          throw err;
        }

        const remainingAmt = Number(row.remainingAmount || 0);
        if (!Number.isFinite(remainingAmt) || remainingAmt <= 0) {
          const err = new Error("BOOKING_PAY_TX_BAD_REMAINING");
          err.code = "BOOKING_PAY_TX_BAD_REMAINING";
          throw err;
        }

        const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
        const isProduction = nodeEnv === "production";
        const skipRazorpayAmountVerification = !isProduction;

        if (!skipRazorpayAmountVerification) {
          // Amount integrity (always enforced server-side):
          // Compare server-calculated expected amount with Razorpay payment amount.
          const fetched = await fetchPaymentAmountRupees(paymentId);
          if (!fetched.ok) {
            const err = new Error("BOOKING_PAY_TX_RZP_FETCH_FAILED");
            err.code = "BOOKING_PAY_TX_RZP_FETCH_FAILED";
            throw err;
          }
          const expected = Number(remainingAmt);
          const actual = Number(fetched.amountRupees);
          if (!Number.isFinite(actual) || Math.abs(actual - expected) > 0.01) {
            const err = new Error("BOOKING_PAY_TX_AMOUNT_MISMATCH");
            err.code = "BOOKING_PAY_TX_AMOUNT_MISMATCH";
            err.meta = { expected, actual };
            throw err;
          }
        } else {
          logger.warn("DEV MODE: Skipping Razorpay remaining amount verification", {
            bookingId: id.toString(),
            paymentStage: "remaining",
          });
        }

        const [createdPayment] = await Payment.create(
          [
            {
              bookingId: row._id,
              userId: req.user._id,
              amount: remainingAmt,
              type: "remaining",
              status: "PENDING",
              paymentMethod,
              transactionId,
              orderId,
              paymentId,
            },
          ],
          { session }
        );
        payment = createdPayment;

        // Do NOT close before webhook success.
        assertBookingTransition("completed", "payment_pending", "record remaining payment");
        const lockExpiresAt = new Date(Date.now() + PAYMENT_PENDING_TTL_MS);
        const upd = await Booking.findOneAndUpdate(
          { _id: id, farmer: req.user._id, status: "completed", paymentStatus: "balance_due" },
          { $set: { paymentStatus: "fully_paid", status: "payment_pending", lockExpiresAt } },
          { returnDocument: "after", session }
        );

        if (!upd) {
          const err = new Error("BOOKING_PAY_TX_RACE");
          err.code = "BOOKING_PAY_TX_RACE";
          throw err;
        }
        updatedBooking = upd;
      });
    } catch (e) {
      if (e && (e.code === 11000 || e.code === 11001)) {
        payment = await Payment.findOne({
          bookingId: id,
          type: "remaining",
          status: { $in: ["PENDING", "SUCCESS"] },
        }).lean();
        if (payment) {
          const latestBooking = await Booking.findById(id).lean();
          if (!latestBooking) {
            res.status(404);
            throw new Error("Booking not found.");
          }
          if (!latestBooking.farmer || String(latestBooking.farmer) !== String(req.user._id)) {
            res.status(403);
            throw new Error("You can only pay remaining balance for your own bookings.");
          }
          const idempotentPaidDup =
            latestBooking.status === "closed" && isPaidLikePaymentStatus(latestBooking.paymentStatus);
          if (!idempotentPaidDup) {
            assertPaymentNotTerminal(latestBooking);
          }
          if (latestBooking.status === "closed" && isPaidLikePaymentStatus(latestBooking.paymentStatus)) {
            await applyBookingSettlementAfterFullPayment(id);
          }
          const settledBooking = (await Booking.findById(id).lean()) || latestBooking;

          return sendSuccess(res, 200, "Remaining payment already recorded.", {
            booking: withStatusMessage(settledBooking),
            payment,
          });
        }
      }

      const retryBooking = await Booking.findById(id).lean();
      if (!retryBooking) {
        res.status(404);
        throw new Error("Booking not found.");
      }

      const retryPayment = await Payment.findOne({
        bookingId: id,
        type: "remaining",
        status: { $in: ["PENDING", "SUCCESS"] },
      }).lean();
      if (retryPayment) {
        const retryIdempotentPaid =
          retryBooking.status === "closed" && isPaidLikePaymentStatus(retryBooking.paymentStatus);
        if (!retryIdempotentPaid) {
          assertPaymentNotTerminal(retryBooking);
        }
        if (retryBooking.status === "closed" && isPaidLikePaymentStatus(retryBooking.paymentStatus)) {
          await applyBookingSettlementAfterFullPayment(id);
        }
        const settledRetry = (await Booking.findById(id).lean()) || retryBooking;
        return sendSuccess(res, 200, "Remaining payment already recorded.", {
          booking: withStatusMessage(settledRetry),
          payment: retryPayment,
        });
      }

      if (e && e.code === "BOOKING_PAY_TX_AMOUNT_MISMATCH") {
        logger.warn("Remaining payment amount mismatch", { bookingId: id.toString() });
        res.status(400);
        throw new Error("Payment amount mismatch.");
      }
      if (e && e.code === "BOOKING_PAY_TX_RZP_FETCH_FAILED") {
        logger.warn("Razorpay payment fetch failed (remaining)", { bookingId: id.toString() });
        res.status(400);
        throw new Error("Payment verification failed.");
      }
      if (e && e.code === "BOOKING_PAY_TX_BAD_REMAINING") {
        res.status(400);
        throw new Error("Remaining amount is not available for this booking.");
      }
      if (
        e &&
        (e.code === "BOOKING_PAY_TX_NO_MATCH" ||
          e.code === "BOOKING_PAY_TX_RACE" ||
          e.code === 11000 ||
          e.code === 11001)
      ) {
        assertPaymentNotTerminal(retryBooking);
        res.status(400);
        throw new Error("Cannot process payment for this booking");
      }
      throw e;
    } finally {
      session.endSession();
      try {
        await releaseLock(lockKey, lock.token);
      } catch {
        // ignore
      }
    }

    if (!payment || !updatedBooking) {
      res.status(400);
      throw new Error("Cannot process payment for this booking");
    }

    logger.info("[EVENT] Payment recorded (awaiting webhook confirmation)", {
      requestId: req.requestId || null,
      userId: req.user?._id ? String(req.user._id) : null,
      bookingId: id.toString(),
      amount: Number(payment?.amount) || 0,
      paymentType: "remaining",
      paymentId: paymentId || null,
      idempotencyKey: req.get("Idempotency-Key") || null,
      action: "payment.create",
      status: "PENDING",
      timestamp: new Date().toISOString(),
    });
    logger.info("[EVENT] Payment initiated, awaiting verification", {
      ...buildPaymentLogContext({ req, bookingId: id, paymentId, stage: "remaining" }),
      action: "payment.awaiting_verification",
      status: "PENDING",
    });
    void logAuditAction(req.user?._id, "PAYMENT_REMAINING_SUCCESS");

    await logPaymentSuccess({
      userId: req.user._id,
      bookingId: updatedBooking._id,
      amount: payment?.amount ?? 0,
      ledgerKey: payment?._id ? `payment:${payment._id}` : undefined,
    });

    // Settlement is only valid after webhook-confirmed close.
    const bookingAfterSettlement = await Booking.findById(id).lean();

    schedulePaymentRecoveryCheck({ paymentId, bookingId: id });
    // Notifications: farmer completed, operator received.
    await notifyUser({
      req,
      app: null,
      userId: updatedBooking.farmer,
      message: "Payment initiated, awaiting verification",
      type: "payment",
      title: "Payment initiated, awaiting verification",
      bookingId: updatedBooking._id,
    });
    await notifyUser({
      req,
      app: null,
      userId: updatedBooking.operator,
      message: "Payment initiated, awaiting verification",
      type: "payment",
      title: "Payment initiated, awaiting verification",
      bookingId: updatedBooking._id,
    });

    return sendSuccess(res, 200, "Remaining payment recorded successfully.", {
      booking: withStatusMessage(bookingAfterSettlement || updatedBooking),
      payment,
      paymentPending: true,
    });
  } catch (error) {
    logger.error("[EVENT] Payment failed", {
      ...buildPaymentLogContext({
        req,
        bookingId: req?.params?.id,
        paymentId: req?.body?.paymentId != null ? String(req.body.paymentId).trim() : "",
        stage: "remaining",
        error,
      }),
      action: "payment.failed",
      status: "FAILED",
    });
    return next(error);
  } finally {
    // Best-effort release of strict payment lock
    try {
      if (typeof paymentLockKey === "string" && paymentLockKey && paymentLock?.token) {
        await releaseLock(paymentLockKey, paymentLock.token);
      }
    } catch {
      // ignore
    }
  }
}

async function cancelBooking(req, res, next) {
  try {
    if (!["farmer", "operator"].includes(req.user.role)) {
      res.status(403);
      throw new Error("Only farmers or operators can cancel a booking.");
    }

    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid booking id is required.");
    }

    const reasonRaw = req.body?.reason;
    const reason = reasonRaw != null && typeof reasonRaw === "string" ? reasonRaw.trim() : "";

    const booking = await Booking.findById(id);
    if (!booking) {
      res.status(404);
      throw new Error("Booking not found.");
    }

    const isFarmer = booking.farmer.equals(req.user._id);
    const isOperator = booking.operator.equals(req.user._id);
    if (!isFarmer && !isOperator) {
      res.status(403);
      throw new Error("You can only cancel bookings you are part of.");
    }

    // Strict cancellation rules.
    if (["completed", "closed"].includes(booking.status)) {
      throw new AppError("Cannot cancel: completed/closed bookings cannot be cancelled.", 400, {
        code: "CANCEL_NOT_ALLOWED",
        userTip: "If you need changes, contact support with your booking id.",
        retryable: false,
      });
    }
    if (["cancelled", "rejected"].includes(booking.status)) {
      throw new AppError(`Cannot cancel: booking is already '${booking.status}'.`, 400, {
        code: "CANCEL_NOT_ALLOWED",
        userTip: "This booking is already in a terminal state.",
        retryable: false,
      });
    }

    const cancelledBy = isFarmer ? "farmer" : "operator";
    let refundStatus = "none";
    let penaltyApplied = false;
    let cancellationReason = reason;

    if (isFarmer) {
      // Farmer cancellation rules
      if (booking.status === "pending") {
        penaltyApplied = false;
        refundStatus = "none";
        cancellationReason = cancellationReason || "Cancelled by farmer (no penalty).";
      } else if (booking.status === "accepted") {
        penaltyApplied = true;
        refundStatus = "none";
        cancellationReason = cancellationReason || "Cancelled by farmer (penalty may apply).";
      } else if (booking.paymentStatus === "advance_paid") {
        // No refund for advance_paid cancellation per policy.
        penaltyApplied = false;
        refundStatus = "none";
        cancellationReason = cancellationReason || "Advance paid; no refund per policy.";
      } else {
        penaltyApplied = false;
        refundStatus = "none";
        cancellationReason = cancellationReason || "Cancelled by farmer.";
      }
    } else {
      // Operator cancellation rules: refund advance (if already paid).
      penaltyApplied = false;
      if (booking.paymentStatus === "advance_paid") {
        refundStatus = "pending";
        cancellationReason = cancellationReason || "Cancelled by operator; advance refund initiated.";
      } else {
        refundStatus = "none";
        cancellationReason = cancellationReason || "Cancelled by operator.";
      }
    }

    const { refundAmount, penalty } = resolveRefundSnapshot(booking, { actorIsFarmer: isFarmer });
    booking.refundAmount = refundAmount;
    booking.cancellationCharge = penalty;
    booking.cancelledAt = new Date();

    booking.status = "cancelled";
    booking.cancelledBy = cancelledBy;
    booking.cancellationReason = cancellationReason;
    booking.refundStatus = refundStatus;
    booking.penaltyApplied = penaltyApplied;

    await booking.save();

    logger.info(`[EVENT] Booking cancelled: ${booking._id.toString()}`);

    await notifyUser({
      req,
      app: null,
      userId: booking.farmer,
      type: "alert",
      title: "Booking cancelled",
      message: `Booking was cancelled by ${cancelledBy}.`,
      bookingId: booking._id,
    });
    await notifyUser({
      req,
      app: null,
      userId: booking.operator,
      type: "alert",
      title: "Booking cancelled",
      message: `Booking was cancelled by ${cancelledBy}.`,
      bookingId: booking._id,
    });

    return sendSuccess(res, 200, "Booking cancelled.", {
      booking: withStatusMessage(booking),
    });
  } catch (error) {
    return next(error);
  }
}

async function getBookingRefundPreview(req, res, next) {
  try {
    if (!["farmer", "operator"].includes(req.user.role)) {
      res.status(403);
      throw new Error("Only farmers or operators can view refund preview.");
    }

    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid booking id is required.");
    }

    const booking = await Booking.findById(id).lean();
    if (!booking) {
      res.status(404);
      throw new Error("Booking not found.");
    }

    const isFarmer = String(booking.farmer) === String(req.user._id);
    const isOperator = String(booking.operator) === String(req.user._id);
    if (!isFarmer && !isOperator) {
      res.status(401);
      throw new Error("You can only preview refunds for your own bookings.");
    }

    const { refundAmount, penalty } = resolveRefundSnapshot(booking, { actorIsFarmer: isFarmer });

    return sendSuccess(res, 200, "Refund preview.", {
      refundAmount,
      penalty,
    });
  } catch (error) {
    return next(error);
  }
}

async function listFarmerBookings(req, res, next) {
  try {
    if (req.user.role !== "farmer") {
      res.status(403);
      throw new Error("Only farmers can list farmer bookings.");
    }

    const { page, limit, skip } = parsePagination(req.query);
    const { status, serviceType } = req.query || {};
    const filter = { farmer: req.user._id };

    if (typeof status === "string" && status.trim()) {
      const normalized = status.trim().toLowerCase();
      const allowed = Array.isArray(Booking.BOOKING_STATUSES) ? Booking.BOOKING_STATUSES : [];
      if (!allowed.includes(normalized)) {
        res.status(400);
        throw new Error("Invalid status filter.");
      }
      filter.status = normalized;
    }

    if (typeof serviceType === "string" && serviceType.trim()) {
      filter.serviceType = serviceType.trim().toLowerCase();
    }

    const total = await Booking.countDocuments(filter);
    const totalPages = Math.ceil(total / limit);

    const bookings = await Booking.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("operator", OPERATOR_PUBLIC_SELECT)
      .populate("tractor", "tractorType brand model registrationNumber machineryTypes tractorPhoto")
      .exec();

    const active = [];
    const completed = [];
    const cancelled = [];

    const activeStatuses = new Set(["pending", "accepted", "confirmed", "en_route", "in_progress"]);
    const completedStatuses = new Set(["completed", "payment_pending", "closed"]);
    const cancelledStatuses = new Set(["cancelled", "rejected"]);

    for (const b of bookings) {
      const plain = b.toObject();
      if (plain.operator) plain.operator = cleanUserResponse(plain.operator);
      const withMsg = withStatusMessage(plain);
      if (cancelledStatuses.has(b.status)) cancelled.push(withMsg);
      else if (completedStatuses.has(b.status)) completed.push(withMsg);
      else if (activeStatuses.has(b.status)) active.push(withMsg);
      else active.push(withMsg);
    }

    const data = { active, completed, cancelled };

    // Backward compatible: keep original top-level keys, add pagination metadata + `data`.
    return sendSuccess(res, 200, "Farmer bookings fetched.", {
      ...data,
      data,
      total,
      page,
      totalPages,
    });
  } catch (error) {
    return next(error);
  }
}

async function listOperatorBookings(req, res, next) {
  try {
    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only operators can list operator bookings.");
    }

    const { page, limit, skip } = parsePagination(req.query);
    const { status, serviceType } = req.query || {};
    const filter = { operator: req.user._id };

    if (typeof status === "string" && status.trim()) {
      const normalized = status.trim().toLowerCase();
      const allowed = Array.isArray(Booking.BOOKING_STATUSES) ? Booking.BOOKING_STATUSES : [];
      if (!allowed.includes(normalized)) {
        res.status(400);
        throw new Error("Invalid status filter.");
      }
      filter.status = normalized;
    }

    if (typeof serviceType === "string" && serviceType.trim()) {
      filter.serviceType = serviceType.trim().toLowerCase();
    }

    const total = await Booking.countDocuments(filter);
    const totalPages = Math.ceil(total / limit);

    const bookings = await Booking.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("farmer", FARMER_PUBLIC_SELECT)
      .populate("tractor", "tractorType brand model registrationNumber machineryTypes tractorPhoto")
      .exec();

    const pending = [];
    const accepted = [];
    const inProgress = [];
    const completed = [];
    const cancelled = [];

    for (const b of bookings) {
      const plain = b.toObject();
      if (plain.farmer) plain.farmer = cleanUserResponse(plain.farmer);
      const withMsg = withStatusMessage(plain);
      if (b.status === "pending") pending.push(withMsg);
      else if (b.status === "accepted" || b.status === "confirmed") accepted.push(withMsg);
      else if (b.status === "en_route" || b.status === "in_progress") inProgress.push(withMsg);
      else if (["completed", "payment_pending", "closed"].includes(b.status)) completed.push(withMsg);
      else if (["cancelled", "rejected"].includes(b.status)) cancelled.push(withMsg);
    }

    const data = {
      pending,
      accepted,
      in_progress: inProgress,
      completed,
      cancelled,
    };

    // Backward compatible: keep original top-level keys, add pagination metadata + `data`.
    return sendSuccess(res, 200, "Operator bookings fetched.", {
      pending,
      accepted,
      in_progress: inProgress,
      completed,
      cancelled,
      data,
      total,
      page,
      totalPages,
    });
  } catch (error) {
    return next(error);
  }
}

async function listMyFarmerBookings(req, res, next) {
  try {
    if (req.user.role !== "farmer") {
      res.status(403);
      throw new Error("Only farmers can view their booking history.");
    }

    const { page, limit, skip } = parsePagination(req.query);
    const { status, date, serviceType } = req.query || {};

    const filter = { farmer: req.user._id };

    if (typeof status === "string" && status.trim()) {
      const normalized = status.trim().toLowerCase();
      const allowed = Array.isArray(Booking.BOOKING_STATUSES) ? Booking.BOOKING_STATUSES : [];
      if (!allowed.includes(normalized)) {
        res.status(400);
        throw new Error("Invalid status filter.");
      }
      filter.status = normalized;
    }

    if (typeof date === "string" && date.trim()) {
      const parsed = new Date(date.trim());
      if (Number.isNaN(parsed.getTime())) {
        res.status(400);
        throw new Error("Invalid date filter.");
      }
      const start = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
      const end = new Date(start);
      end.setDate(start.getDate() + 1);
      filter.date = { $gte: start, $lt: end };
    }

    if (typeof serviceType === "string" && serviceType.trim()) {
      filter.serviceType = serviceType.trim().toLowerCase();
    }

    const total = await Booking.countDocuments(filter);
    const totalPages = Math.ceil(total / limit);

    const bookings = await Booking.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("operator", OPERATOR_PUBLIC_SELECT)
      .populate("tractor", "tractorType brand model registrationNumber machineryTypes tractorPhoto")
      .exec();

    return sendSuccess(res, 200, "Farmer bookings fetched.", {
      count: bookings.length,
      bookings,
      data: bookings,
      total,
      page,
      totalPages,
    });
  } catch (error) {
    return next(error);
  }
}

async function listMyOperatorBookings(req, res, next) {
  try {
    if (req.user.role !== "operator") {
      res.status(403);
      throw new Error("Only operators can view their booking history.");
    }

    const { page, limit, skip } = parsePagination(req.query);
    const { status, date, serviceType } = req.query || {};

    const filter = { operator: req.user._id };

    if (typeof status === "string" && status.trim()) {
      const normalized = status.trim().toLowerCase();
      const allowed = Array.isArray(Booking.BOOKING_STATUSES) ? Booking.BOOKING_STATUSES : [];
      if (!allowed.includes(normalized)) {
        res.status(400);
        throw new Error("Invalid status filter.");
      }
      filter.status = normalized;
    }

    if (typeof date === "string" && date.trim()) {
      const parsed = new Date(date.trim());
      if (Number.isNaN(parsed.getTime())) {
        res.status(400);
        throw new Error("Invalid date filter.");
      }
      const start = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
      const end = new Date(start);
      end.setDate(start.getDate() + 1);
      filter.date = { $gte: start, $lt: end };
    }

    if (typeof serviceType === "string" && serviceType.trim()) {
      filter.serviceType = serviceType.trim().toLowerCase();
    }

    const total = await Booking.countDocuments(filter);
    const totalPages = Math.ceil(total / limit);

    const bookings = await Booking.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("farmer", FARMER_PUBLIC_SELECT)
      .populate("tractor", "tractorType brand model registrationNumber machineryTypes tractorPhoto")
      .exec();

    return sendSuccess(res, 200, "Operator bookings fetched.", {
      count: bookings.length,
      bookings,
      data: bookings,
      total,
      page,
      totalPages,
    });
  } catch (error) {
    return next(error);
  }
}

async function getBookingDetails(req, res, next) {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid booking id is required.");
    }

    const booking = await Booking.findById(id)
      .populate(
        "farmer",
        "name phone village role language landArea primaryCrop soilType isOnline averageRating reviewCount verificationStatus"
      )
      .populate(
        "operator",
        "name phone village role isOnline averageRating reviewCount verificationStatus aadhaarVerified"
      )
      .populate(
        "tractor",
        "tractorType brand model registrationNumber machineryTypes tractorPhoto isAvailable"
      )
      .lean();

    if (!booking) {
      res.status(404);
      throw new Error("Booking not found.");
    }

    const isFarmer = booking.farmer && String(booking.farmer._id || booking.farmer) === String(req.user._id);
    const isOperator = booking.operator && String(booking.operator._id || booking.operator) === String(req.user._id);
    if (!isFarmer && !isOperator) {
      res.status(401);
      throw new Error("You can only access details for your own bookings.");
    }

    const timestamps = {
      createdAt: booking.createdAt,
      updatedAt: booking.updatedAt,
      acceptedAt: booking.acceptedAt,
      respondedAt: booking.respondedAt,
      startTime: booking.startTime,
      endTime: booking.endTime,
    };

    const bookingForResponse = { ...booking };
    applyAdvanceFieldDedupe(bookingForResponse);

    return sendSuccess(res, 200, "Booking details fetched.", {
      booking: bookingForResponse,
      farmer: bookingForResponse.farmer ?? null,
      operator: bookingForResponse.operator ?? null,
      tractor: bookingForResponse.tractor ?? null,
      paymentStatus: bookingForResponse.paymentStatus,
      timestamps,
    });
  } catch (error) {
    return next(error);
  }
}

async function getBookingInvoice(req, res, next) {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid booking id is required.");
    }

    const wantsDownload = String(req.query?.type || "")
      .trim()
      .toLowerCase() === "download";
    const downloadFilename = `invoice-${id}.pdf`;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const selfDownloadUrl = `${baseUrl}/api/bookings/${id}/invoice?type=download`;

    const isAllowedInvoiceHost = (hostname) => {
      const h = String(hostname || "").toLowerCase();
      if (!h) return false;
      // Cloudinary
      if (h === "res.cloudinary.com") return true;
      // Common S3 patterns
      if (h.endsWith(".amazonaws.com")) return true;
      if (h.endsWith(".s3.amazonaws.com")) return true;
      if (h.includes(".s3.") && h.endsWith(".amazonaws.com")) return true;
      return false;
    };

    const streamFromUrl = async (sourceUrl) => {
      const http = require("http");
      const https = require("https");

      const u = new URL(sourceUrl);
      if (!isAllowedInvoiceHost(u.hostname)) {
        throw new Error("Invoice host is not allowed.");
      }
      const client = u.protocol === "https:" ? https : http;

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename=${downloadFilename}`);

      return new Promise((resolve, reject) => {
        const upstream = client.get(sourceUrl, (upRes) => {
          if (!upRes || upRes.statusCode >= 400) {
            const code = upRes?.statusCode || 502;
            reject(new Error(`Invoice upstream fetch failed (status=${code}).`));
            return;
          }
          upRes.on("error", reject);
          upRes.pipe(res);
          upRes.on("end", resolve);
        });

        upstream.on("error", reject);
      });
    };

    const booking = await Booking.findById(id)
      .populate(
        "farmer",
        "name phone village role language landArea isOnline averageRating reviewCount"
      )
      .populate(
        "operator",
        "name phone village role isOnline averageRating reviewCount"
      )
      .populate(
        "tractor",
        "tractorType brand model registrationNumber machineryTypes tractorPhoto isAvailable"
      );

    if (!booking) {
      res.status(404);
      throw new Error("Booking not found.");
    }

    const isFarmer = booking.farmer && String(booking.farmer._id || booking.farmer) === String(req.user._id);
    const isOperator = booking.operator && String(booking.operator._id || booking.operator) === String(req.user._id);
    if (!isFarmer && !isOperator) {
      res.status(401);
      throw new Error("You can only access invoices for your own bookings.");
    }

    const existingInvoiceUrl = booking.invoiceUrl && String(booking.invoiceUrl).trim();
    if (existingInvoiceUrl) {
      if (wantsDownload) {
        // Backward compatible direct download:
        // if invoiceUrl exists (stored in booking), stream it directly; do not regenerate.
        if (existingInvoiceUrl !== selfDownloadUrl) {
          // Validate URL reachability before deciding to regenerate.
          let reachable = false;
          try {
            const u = new URL(existingInvoiceUrl);
            if (!isAllowedInvoiceHost(u.hostname)) {
              res.status(400);
              throw new Error("Invoice host is not allowed.");
            }
            const headRes = await fetch(existingInvoiceUrl, { method: "HEAD" });
            reachable = headRes && headRes.status === 200;
          } catch {
            reachable = false;
          }

          if (reachable) {
            try {
              await streamFromUrl(existingInvoiceUrl);
              return;
            } catch (streamErr) {
              logger.error(
                `[ERROR] Invoice download stream failed, fallback to regenerate: bookingId=${id}`,
                { error: streamErr?.message || String(streamErr) }
              );
              // Fall through to regeneration below.
            }
          } else {
            logger.warn("Invoice HEAD check failed, using fallback", { bookingId: id });

            // Do not regenerate yet: attempt streaming the existing URL as fallback.
            try {
              await streamFromUrl(existingInvoiceUrl);
              return;
            } catch {
              // Only now we know we must regenerate.
              logger.warn("Invoice fallback regeneration", {
                bookingId: id,
                reason: "stream failed after HEAD failure",
              });
              // Fall through to existing regeneration logic below.
            }
          }
        }
        // If invoiceUrl points back to this endpoint (fallback URL), regenerate below.
      } else {
        // Default behavior: return JSON with stored invoiceUrl, never regenerate.
        return sendSuccess(res, 200, "Invoice fetched successfully.", {
          invoiceUrl: existingInvoiceUrl,
        });
      }
    }

    const payments = await Payment.find({ bookingId: id, status: "SUCCESS" })
      .select("type amount paymentMethod transactionId createdAt")
      .lean();

    const advance = payments.find((p) => p.type === "advance");
    const remaining = payments.find((p) => p.type === "remaining");
    const totalPaid = payments.reduce((sum, p) => sum + (p.amount || 0), 0);

    // Keep existing PDF generation logic.
    const PDFDocument = require("pdfkit");
    const doc = new PDFDocument({ size: "A4", margin: 50 });

    doc.fontSize(18).text("KH Agriconnect — Invoice", { align: "center" });
    doc.moveDown();
    doc.fontSize(12).text(`Booking ID: ${id}`);
    doc.text(`Service Type: ${booking.serviceType || "-"}`);
    doc.text(
      `Date: ${booking.date ? new Date(booking.date).toISOString().slice(0, 10) : "-"}`
    );
    doc.text(`Time: ${booking.time || "-"}`);
    if (booking.address) doc.text(`Address: ${booking.address}`);

    doc.moveDown();
    doc.fontSize(14).text("Parties");
    doc.fontSize(12);
    doc.text(`Farmer: ${booking.farmer?.name || "-"} (${booking.farmer?.phone || "-"})`);
    doc.text(
      `Operator: ${booking.operator?.name || "-"} (${booking.operator?.phone || "-"})`
    );

    doc.moveDown();
    doc.fontSize(14).text("Tractor");
    doc.fontSize(12);
    const tractorParts = [
      booking.tractor?.tractorType,
      booking.tractor?.brand,
      booking.tractor?.model,
      booking.tractor?.registrationNumber
        ? `(${booking.tractor.registrationNumber})`
        : "",
    ].filter(Boolean);
    doc.text(`${tractorParts.length ? tractorParts.join(" ") : "-"}`);

    doc.moveDown();
    doc.fontSize(14).text("Payment Summary");
    doc.fontSize(12);
    doc.text(`Advance: ${advance?.amount ?? 0}`);
    doc.text(`Remaining: ${remaining?.amount ?? 0}`);
    doc.text(`Total Paid: ${totalPaid}`);

    doc.moveDown();
    doc.fontSize(14).text("Financial breakdown");
    doc.fontSize(12);
    doc.text(`Total amount: ${Number(booking.totalAmount) || 0}`);
    doc.text(`Platform fee: ${Number(booking.platformFee) || 0}`);
    doc.text(`GST: ${Number(booking.gstAmount) || 0}`);
    doc.text(`Operator earning: ${Number(booking.operatorEarning) || 0}`);

    const createdAtStr = booking.createdAt ? new Date(booking.createdAt).toISOString() : "-";
    doc.moveDown();
    doc.fontSize(10).text(`Generated at: ${createdAtStr}`);

    const pdfBuffer = await new Promise((resolve, reject) => {
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.end();
    });

    let storedUrl = "";
    try {
      const uploaded = await uploadFile({
        buffer: pdfBuffer,
        originalname: `invoice-${id}.pdf`,
        mimetype: "application/pdf",
      });
      storedUrl = uploaded?.url || "";
      if (storedUrl) {
        booking.invoiceUrl = storedUrl;
        await booking.save();
      }
    } catch (uploadErr) {
      logger.error(`[ERROR] Invoice upload failed: bookingId=${id}`, {
        error: uploadErr?.message || String(uploadErr),
      });
    }

    if (wantsDownload) {
      // Stream generated PDF directly (works even if storage upload failed).
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename=${downloadFilename}`);
      res.end(pdfBuffer);
      return;
    }

    // Default: return JSON with invoiceUrl.
    // If storage upload failed, return a self download URL so the client can still download.
    return sendSuccess(res, 200, "Invoice generated successfully.", {
      invoiceUrl: storedUrl || existingInvoiceUrl || selfDownloadUrl,
    });
  } catch (error) {
    return next(error);
  }
}

async function estimateBooking(req, res, next) {
  try {
    const { landArea, serviceType } = req.body || {};
    if (landArea === undefined || landArea === null || landArea === "") {
      res.status(400);
      throw new Error("landArea is required.");
    }
    if (!serviceType || typeof serviceType !== "string" || !serviceType.trim()) {
      res.status(400);
      throw new Error("serviceType is required.");
    }
    const area = Number(landArea);
    if (!Number.isFinite(area) || area <= 0) {
      res.status(400);
      throw new Error("landArea must be a positive number.");
    }

    const serviceTypeTrimmed = serviceType.trim();
    const serviceTypeNormalized = serviceTypeTrimmed.toLowerCase();

    const [pricingDoc, activeCommission, seasonalPricing] = await Promise.all([
      Pricing.findOne({ serviceType: serviceTypeNormalized }).lean(),
      Commission.findOne({ active: true }).sort({ updatedAt: -1 }).lean(),
      SeasonalPricing.findOne({
        serviceType: serviceTypeNormalized,
        startDate: { $lte: new Date() },
        endDate: { $gte: new Date() },
      })
        .sort({ startDate: -1 })
        .lean(),
    ]);

    const pricingDocEffective = req.serviceConfig?.pricingDoc || pricingDoc || null;
    if (!activeCommission || !Number.isFinite(activeCommission.percentage)) {
      res.status(400);
      throw new Error("Commission is not configured or not active.");
    }

    const commissionPercentage = Number(activeCommission.percentage);

    const typePricePerAcre = Number(req.serviceConfig?.selectedTypePricing?.pricePerAcre || 0);
    const typePricePerHour = Number(req.serviceConfig?.selectedTypePricing?.pricePerHour || 0);
    const servicePricePerAcre = Number(
      req.serviceConfig?.servicePricing?.pricePerAcre || pricingDocEffective?.pricePerAcre || 0
    );
    const servicePricePerHour = Number(
      req.serviceConfig?.servicePricing?.pricePerHour || pricingDocEffective?.pricePerHour || 0
    );
    const pricePerAcre = typePricePerAcre > 0 ? typePricePerAcre : servicePricePerAcre;
    const pricePerHour = typePricePerHour > 0 ? typePricePerHour : servicePricePerHour;

    let baseAmount;
    if (pricePerAcre > 0) {
      baseAmount = round2(pricePerAcre * area);
    } else if (pricePerHour > 0) {
      const hoursRaw = req.body?.hours;
      const hours =
        hoursRaw !== undefined && hoursRaw !== null && hoursRaw !== "" ? Number(hoursRaw) : null;
      if (!Number.isFinite(hours) || hours <= 0) {
        res.status(400);
        throw new Error("Pricing for this serviceType requires `hours` in request body.");
      }
      baseAmount = round2(pricePerHour * hours);
    } else {
      res.status(400);
      throw new Error("Pricing not configured for this service");
    }

    if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
      res.status(400);
      throw new Error("baseAmount must be a positive number.");
    }

    const seasonalMultiplierRaw = Number(seasonalPricing?.multiplier || 1);
    const seasonalMultiplier =
      Number.isFinite(seasonalMultiplierRaw) && seasonalMultiplierRaw > 0
        ? seasonalMultiplierRaw
        : 1;
    baseAmount = round2(baseAmount * seasonalMultiplier);

    const gst = round2(baseAmount * GST_RATE);
    const platformFee = round2(baseAmount * (commissionPercentage / 100));
    const totalAmount = round2(baseAmount + gst + platformFee);
    return sendSuccess(res, 200, "Booking estimate generated.", {
      baseAmount,
      gst,
      platformFee,
      totalAmount,
      seasonalMultiplier,
      // Derived earnings (non-breaking; do not change DB fields)
      operatorEarning: baseAmount,
      platformEarning: platformFee,
    });
  } catch (error) {
    return next(error);
  }
}

async function trackBooking(req, res, next) {
  try {
    if (req.user.role !== "farmer") {
      res.status(403);
      throw new Error("Only farmers can track jobs.");
    }

    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Valid booking id is required.");
    }

    const booking = await Booking.findById(id)
      .select("farmer operator")
      .populate("operator", "location")
      .lean();

    if (!booking) {
      res.status(404);
      throw new Error("Booking not found.");
    }
    if (!booking.farmer || String(booking.farmer) !== String(req.user._id)) {
      res.status(403);
      throw new Error("You can only track your own bookings.");
    }

    const opCoords = booking.operator?.location?.coordinates;
    if (!Array.isArray(opCoords) || opCoords.length < 2) {
      return sendSuccess(res, 200, "Operator location not available yet.", {
        operatorLocation: null,
        distanceKm: null,
        estimatedArrivalTime: null,
        routeDistanceKm: null,
        routeDurationMinutes: null,
      });
    }

    const operatorLongitude = Number(opCoords[0]);
    const operatorLatitude = Number(opCoords[1]);

    // Treat [0,0] as "not available" to prevent fake tracking distances.
    if (!Number.isFinite(operatorLatitude) || !Number.isFinite(operatorLongitude) || (operatorLatitude === 0 && operatorLongitude === 0)) {
      return sendSuccess(res, 200, "Operator location not available yet.", {
        operatorLocation: null,
        distanceKm: null,
        estimatedArrivalTime: null,
        routeDistanceKm: null,
        routeDurationMinutes: null,
      });
    }

    const farmerCoords = req.user?.location?.coordinates;
    let distanceKm = null;
    let estimatedArrivalTime = null;
    let routeDistanceKm = null;
    let routeDurationMinutes = null;

    if (Array.isArray(farmerCoords) && farmerCoords.length >= 2) {
      const farmerLongitude = Number(farmerCoords[0]);
      const farmerLatitude = Number(farmerCoords[1]);

      // Treat [0,0] as "not available".
      const farmerCoordsValid =
        Number.isFinite(farmerLatitude) &&
        Number.isFinite(farmerLongitude) &&
        !(farmerLatitude === 0 && farmerLongitude === 0);
      if (
        farmerCoordsValid &&
        Number.isFinite(operatorLatitude) &&
        Number.isFinite(operatorLongitude)
      ) {
        distanceKm = round2(haversineKm(farmerLatitude, farmerLongitude, operatorLatitude, operatorLongitude));

        const route = await getDistanceAndETA(
          { lat: farmerLatitude, lng: farmerLongitude },
          { lat: operatorLatitude, lng: operatorLongitude }
        );
        routeDistanceKm = route.distanceKm;
        routeDurationMinutes = route.durationMinutes;
        estimatedArrivalTime = new Date(Date.now() + route.durationMinutes * 60 * 1000).toISOString();
      }
    }

    return sendSuccess(res, 200, "Tracking info fetched.", {
      operatorLocation: {
        latitude: operatorLatitude,
        longitude: operatorLongitude,
      },
      distanceKm,
      estimatedArrivalTime,
      routeDistanceKm,
      routeDurationMinutes,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  createBooking,
  respondToBooking,
  payAdvance,
  startJob,
  completeJob,
  updateBookingProgress,
  payRemaining,
  cancelBooking,
  getBookingRefundPreview,
  listFarmerBookings,
  listOperatorBookings,
  listMyFarmerBookings,
  listMyOperatorBookings,
  getBookingDetails,
  getBookingInvoice,
  estimateBooking,
  trackBooking,
};
