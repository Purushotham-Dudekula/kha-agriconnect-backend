/**
 * Integration coverage: auth (refresh/logout/verify 404), user (me, nearby), complaint, operator.
 */
const request = require("supertest");
const jwt = require("jsonwebtoken");

jest.mock("../../src/services/user.service", () => ({
  findNearbyOperators: jest.fn(async () => ({
    onlineOperators: [],
    offlineOperators: [],
  })),
}));

const { createApp } = require("../../src/app");
const {
  connectMongoMemory,
  disconnectMongoMemory,
  resetDatabase,
  seedBookingFixtures,
} = require("../helpers/mongoMemoryHarness");

describe("auth + user + complaint + operator coverage (integration)", () => {
  let app;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    await connectMongoMemory();
    app = createApp();
  }, 120000);

  afterAll(async () => {
    await disconnectMongoMemory();
  });

  beforeEach(async () => {
    await resetDatabase();
    process.env.NODE_ENV = "development";
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  describe("auth.controller", () => {
    test("POST /api/auth/refresh without cookie -> 401", async () => {
      const res = await request(app).post("/api/auth/refresh").send({ userId: "507f1f77bcf86cd7994390111" });
      expect(res.status).toBe(401);
    });

    test("POST /api/auth/refresh invalid token format -> 401", async () => {
      const res = await request(app)
        .post("/api/auth/refresh")
        .set("Cookie", ["refreshToken=fake"])
        .send({ userId: "not-an-id" });
      expect(res.status).toBe(401);
    });

    test("POST /api/auth/verify-otp user not found (no prior record) -> 404", async () => {
      const res = await request(app).post("/api/auth/verify-otp").send({
        phone: "8888888888",
        otp: "123456",
      });
      expect(res.status).toBe(404);
    });

    test("POST /api/auth/logout without token -> 401", async () => {
      const res = await request(app).post("/api/auth/logout").send({});
      expect(res.status).toBe(401);
    });
  });

  describe("user.controller", () => {
    test("GET /api/user/me without token -> 401", async () => {
      const res = await request(app).get("/api/user/me");
      expect(res.status).toBe(401);
    });

    test("GET /api/user/me with token -> 200", async () => {
      const { farmerToken } = await seedBookingFixtures();
      const res = await request(app).get("/api/user/me").set("Authorization", `Bearer ${farmerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test("GET /api/user/nearby-operators missing lat -> 400", async () => {
      const { farmerToken } = await seedBookingFixtures();
      const res = await request(app)
        .get("/api/user/nearby-operators?lng=78&radius=10")
        .set("Authorization", `Bearer ${farmerToken}`);
      expect(res.status).toBe(400);
    });

    test("GET /api/user/nearby-operators success -> 200", async () => {
      const { farmerToken } = await seedBookingFixtures();
      const res = await request(app)
        .get("/api/user/nearby-operators?lat=17.4&lng=78.5&radius=5")
        .set("Authorization", `Bearer ${farmerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe("complaint.controller", () => {
    test("POST /api/complaints missing message -> 400", async () => {
      const { farmerToken } = await seedBookingFixtures();
      const res = await request(app)
        .post("/api/complaints")
        .set("Authorization", `Bearer ${farmerToken}`)
        .send({ category: "General" });
      expect(res.status).toBe(400);
    });

    test("POST /api/complaints invalid category -> 400", async () => {
      const { farmerToken } = await seedBookingFixtures();
      const res = await request(app)
        .post("/api/complaints")
        .set("Authorization", `Bearer ${farmerToken}`)
        .send({ message: "test", category: "NotARealCategory" });
      expect(res.status).toBe(400);
    });

    test("POST /api/complaints General without bookingId -> 201", async () => {
      const { farmerToken } = await seedBookingFixtures();
      const res = await request(app)
        .post("/api/complaints")
        .set("Authorization", `Bearer ${farmerToken}`)
        .send({ message: "hello support", category: "General" });
      expect(res.status).toBe(201);
      expect(res.body.data.complaint).toBeDefined();
    });

    test("GET /api/complaints list -> 200", async () => {
      const { farmerToken } = await seedBookingFixtures();
      const res = await request(app).get("/api/complaints").set("Authorization", `Bearer ${farmerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.complaints)).toBe(true);
    });

    test("POST /api/complaints bookingId not found -> 404", async () => {
      const { farmerToken } = await seedBookingFixtures();
      const res = await request(app)
        .post("/api/complaints")
        .set("Authorization", `Bearer ${farmerToken}`)
        .send({
          message: "issue",
          category: "Payment",
          bookingId: "507f1f77bcf86cd799439011",
        });
      expect(res.status).toBe(404);
    });
  });

  describe("operator.controller", () => {
    test("GET /api/operator/earnings as farmer -> 403", async () => {
      const { farmerToken } = await seedBookingFixtures();
      const res = await request(app).get("/api/operator/earnings").set("Authorization", `Bearer ${farmerToken}`);
      expect(res.status).toBe(403);
    });

    test("GET /api/operator/earnings as operator -> 200", async () => {
      const { operatorToken } = await seedBookingFixtures();
      const res = await request(app).get("/api/operator/earnings").set("Authorization", `Bearer ${operatorToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test("PATCH /api/operator/bank-details invalid IFSC length -> 400 (validation)", async () => {
      const { operatorToken } = await seedBookingFixtures();
      const res = await request(app)
        .patch("/api/operator/bank-details")
        .set("Authorization", `Bearer ${operatorToken}`)
        .send({
          accountHolderName: "Test",
          accountNumber: "1234567890",
          ifsc: "BAD",
          upiId: "",
        });
      expect(res.status).toBe(400);
    });
  });
});
