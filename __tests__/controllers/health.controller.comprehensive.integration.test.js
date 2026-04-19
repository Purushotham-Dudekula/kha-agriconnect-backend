/**
 * health.controller.js — dbStatus branches (mongoose.readyState).
 * Note: getRedisHealth is bound at module load; redis fields reflect real redis.service state.
 */
const request = require("supertest");
const mongoose = require("mongoose");
const { createApp } = require("../../src/app");

describe("health.controller (integration)", () => {
  const originalEnv = { ...process.env };
  const originalReadyState = mongoose.connection.readyState;
  let app;

  beforeAll(() => {
    app = createApp();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    Object.defineProperty(mongoose.connection, "readyState", {
      value: originalReadyState,
      configurable: true,
    });
  });

  test("GET /api/health → 200 with dbStatus connected", async () => {
    Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true });
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.dbStatus).toBe("connected");
    expect(res.body).toHaveProperty("redisStatus");
    expect(res.body).toHaveProperty("redis");
    expect(typeof res.body.redisStatus).toBe("string");
  });

  test("GET /api/health dbStatus connecting when readyState is 2", async () => {
    Object.defineProperty(mongoose.connection, "readyState", { value: 2, configurable: true });
    const res = await request(app).get("/api/health");
    expect(res.body.dbStatus).toBe("connecting");
  });

  test("GET /api/health dbStatus disconnected when readyState is 0", async () => {
    Object.defineProperty(mongoose.connection, "readyState", { value: 0, configurable: true });
    const res = await request(app).get("/api/health");
    expect(res.body.dbStatus).toBe("disconnected");
  });

  test("GET /api/v1/health mirrors /api/health shape", async () => {
    Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true });
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body).toHaveProperty("uptime");
    expect(res.body).toHaveProperty("timestamp");
  });

  test("GET /api/version returns 404 in production", async () => {
    process.env.NODE_ENV = "production";
    const res = await request(app).get("/api/version");
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/not found/i);
  });
});
