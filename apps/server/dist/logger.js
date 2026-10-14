import pino from "pino";
const level = process.env.LOG_LEVEL ?? "info";
const pretty = process.env.NODE_ENV !== "production" && process.env.LOG_PRETTY !== "false";
export const logger = pino({
    level,
    base: { service: process.env.SERVICE_NAME ?? "enrichment" },
    ...(pretty
        ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname,service" } } }
        : {}),
});
//# sourceMappingURL=logger.js.map