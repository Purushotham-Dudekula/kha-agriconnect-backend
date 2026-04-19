const mongoose = require("mongoose");
const { logger } = require("../utils/logger");
const { initDbWriteGuard } = require("./dbWriteGuard");
const { migrateTransactionStatuses } = require("./transactionStatusMigration");
let testMongoServer = null;

const MONGO_CONNECT_OPTIONS = {
  retryWrites: true,
  w: "majority",
};

async function connectDB(mongoUri) {
  let uri = String(mongoUri || process.env.MONGO_URI || "").trim();
  const isTest = String(process.env.NODE_ENV || "").trim().toLowerCase() === "test";
  if (isTest) {
    const { MongoMemoryServer } = require("mongodb-memory-server");
    if (!testMongoServer) {
      testMongoServer = await MongoMemoryServer.create();
    }
    uri = testMongoServer.getUri();
    process.env.MONGO_URI = uri;
  }
  if (!uri) {
    throw new Error("Missing required environment variable: MONGO_URI");
  }

  mongoose.set("strictQuery", true);
  mongoose.connection.on("disconnected", () => {
    logger.error("MongoDB disconnected");
  });
  mongoose.connection.on("reconnected", () => {
    logger.info("MongoDB reconnected");
  });
  mongoose.connection.on("error", (error) => {
    logger.error("MongoDB runtime error", { message: error?.message || String(error) });
  });
  initDbWriteGuard();

  try {
    logger.info("Connecting to MongoDB…");
    await mongoose.connect(uri, MONGO_CONNECT_OPTIONS);
    await migrateTransactionStatuses();

    // Index safety audit (does not mutate in production).
    try {
      const Booking = require("../models/booking.model");
      const indexes = await Booking.collection.indexes();
      const hasOperatorUnique = indexes.some((i) => i?.key?.operator === 1 && i?.key?.date === 1 && i?.key?.time === 1 && i?.unique);
      if (hasOperatorUnique) {
        logger.warn("Conflicting operator slot unique index detected. Drop it manually.", {
          indexHint: "{ operator: 1, date: 1, time: 1 }",
        });
      }
    } catch {
      // ignore index introspection errors
    }

    const { host, name, readyState } = mongoose.connection;
    logger.info("MongoDB connected successfully", {
      readyState,
      host: host || "unknown",
      dbName: name || "unknown",
    });
    return mongoose.connection;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logger.error("MongoDB connection failed", { message: msg });
    throw new Error(`MongoDB connection failed: ${msg}`);
  }
}

module.exports = { connectDB, MONGO_CONNECT_OPTIONS };
