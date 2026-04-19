/**
 * Unit tests for bookingReminder.cron — mocks cron tick, Redis, Booking, notifications.
 */
const mongoose = require("mongoose");

jest.mock("node-cron", () => ({
  schedule: jest.fn(),
}));

jest.mock("../../../src/services/redis.service", () => ({
  getRedisClient: jest.fn(),
}));

jest.mock("../../../src/services/notification.service", () => ({
  notifyUser: jest.fn().mockResolvedValue(undefined),
  notifyUsers: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../../src/models/booking.model", () => ({
  find: jest.fn(),
  updateOne: jest.fn().mockResolvedValue({}),
}));

const cron = require("node-cron");
const { getRedisClient } = require("../../../src/services/redis.service");
const { notifyUser, notifyUsers } = require("../../../src/services/notification.service");
const Booking = require("../../../src/models/booking.model");
const { logger } = require("../../../src/utils/logger");
const { scheduleBookingReminders } = require("../../../src/jobs/bookingReminder.cron");

function getTick() {
  expect(cron.schedule).toHaveBeenCalled();
  return cron.schedule.mock.calls[0][1];
}

describe("bookingReminder.cron", () => {
  beforeEach(() => {
    cron.schedule.mockClear();
    getRedisClient.mockReset();
    Booking.find.mockReset();
    Booking.updateOne.mockClear();
    notifyUser.mockClear();
    notifyUsers.mockClear();
  });

  test("registers cron and tick skips when leader lock not acquired", async () => {
    getRedisClient.mockReturnValue({
      set: jest.fn().mockResolvedValue(null),
    });
    scheduleBookingReminders({});
    const tick = getTick();
    Booking.find.mockReturnValue({ lean: jest.fn() });

    await tick();

    expect(Booking.find).not.toHaveBeenCalled();
  });

  test("tick logs error when Booking.find throws", async () => {
    getRedisClient.mockReturnValue(null);
    scheduleBookingReminders({});
    const tick = getTick();
    Booking.find.mockImplementation(() => {
      throw new Error("db down");
    });
    jest.spyOn(logger, "error").mockImplementation(() => {});

    await tick();

    expect(logger.error).toHaveBeenCalledWith("bookingReminder cron: db down");
  });

  test("tick auto-cancels stale pending booking and notifies farmer and operator", async () => {
    getRedisClient.mockReturnValue(null);
    scheduleBookingReminders({});
    const tick = getTick();

    const bid = new mongoose.Types.ObjectId();
    const farmer = new mongoose.Types.ObjectId();
    const operator = new mongoose.Types.ObjectId();
    const createdAt = new Date(Date.now() - 5 * 60 * 60 * 1000);

    Booking.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        {
          _id: bid,
          status: "pending",
          farmer,
          operator,
          createdAt,
        },
      ]),
    });

    await tick();

    expect(Booking.updateOne).toHaveBeenCalledWith(
      { _id: bid, status: "pending" },
      expect.objectContaining({
        $set: expect.objectContaining({ status: "cancelled", cancelledBy: "system" }),
      })
    );
    expect(notifyUser).toHaveBeenCalledTimes(2);
  });

  test("tick sends advance payment reminder in warning window", async () => {
    getRedisClient.mockReturnValue(null);
    scheduleBookingReminders({});
    const tick = getTick();

    const bid = new mongoose.Types.ObjectId();
    const farmer = new mongoose.Types.ObjectId();
    const operator = new mongoose.Types.ObjectId();
    const acceptedAt = new Date(Date.now() - (28 * 60 * 1000 + 30 * 1000));

    Booking.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        {
          _id: bid,
          status: "accepted",
          paymentStatus: "advance_due",
          farmer,
          operator,
          createdAt: new Date(),
          acceptedAt,
        },
      ]),
    });

    await tick();

    expect(notifyUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: farmer,
        title: "Payment reminder",
      })
    );
    expect(Booking.updateOne).not.toHaveBeenCalled();
  });

  test("acquireCronLeaderLock logs warning when redis.set throws", async () => {
    getRedisClient.mockReturnValue({
      set: jest.fn().mockRejectedValue(new Error("redis err")),
    });
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    scheduleBookingReminders({});
    const tick = getTick();

    await tick();

    expect(logger.warn).toHaveBeenCalledWith(
      "Cron leader lock acquire failed, skipping this tick",
      expect.any(Object)
    );
    expect(Booking.find).not.toHaveBeenCalled();
  });

  test("tick sends confirmed job reminders in 30-minute window (notifyUsers + flag)", async () => {
    getRedisClient.mockReturnValue(null);
    const fixedNow = Date.UTC(2026, 3, 18, 10, 0, 0, 0);
    jest.spyOn(Date, "now").mockReturnValue(fixedNow);
    scheduleBookingReminders({});
    const tick = getTick();

    const bid = new mongoose.Types.ObjectId();
    const farmer = new mongoose.Types.ObjectId();
    const operator = new mongoose.Types.ObjectId();

    Booking.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        {
          _id: bid,
          status: "confirmed",
          paymentStatus: "advance_paid",
          jobReminderSent: false,
          farmer,
          operator,
          createdAt: new Date(fixedNow - 3600000),
          date: new Date(Date.UTC(2026, 3, 18)),
          time: "10:30",
        },
      ]),
    });

    await tick();

    expect(notifyUsers).toHaveBeenCalled();
    expect(Booking.updateOne).toHaveBeenCalledWith({ _id: bid }, { $set: { jobReminderSent: true } });
    Date.now.mockRestore();
  });

  test("releaseCronLeaderLock calls redis.eval when token present", async () => {
    const evalMock = jest.fn().mockResolvedValue(1);
    getRedisClient.mockReturnValue({
      set: jest.fn().mockResolvedValue("OK"),
      eval: evalMock,
    });
    scheduleBookingReminders({});
    const tick = getTick();
    Booking.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });

    await tick();

    expect(evalMock).toHaveBeenCalled();
  });
});
