const fs = require("fs");
const path = require("path");
const winston = require("winston");

const nodeEnv = String(process.env.NODE_ENV || "development").trim().toLowerCase();
const isProduction = nodeEnv === "production";
const isTest = nodeEnv === "test";
const logsDir = path.join(__dirname, "..", "..", "logs");

if (isProduction) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

const transports = [];

if (isProduction) {
  // error.log: errors only; combined.log: info + warn + error (HTTP request middleware uses these levels).
  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, "error.log"),
      level: "error",
      format: jsonFormat,
    }),
    new winston.transports.File({
      filename: path.join(logsDir, "combined.log"),
      level: "info",
      format: jsonFormat,
    })
  );
} else {
  transports.push(
    new winston.transports.Console({
      level: isTest ? "error" : "debug",
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        winston.format.printf((info) => {
          const { level, message, timestamp, stack, ...rest } = info;
          const meta = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
          const line = stack ? `${message}\n${stack}` : message;
          return `${timestamp} [${level}]: ${line}${meta}`;
        })
      ),
    })
  );
}

const logger = winston.createLogger({
  level: isTest ? "error" : "info",
  transports,
});

module.exports = { logger };
