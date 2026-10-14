import type { Redis } from "ioredis";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import type { Logger } from "../logger.js";
import type { EnrichQueue } from "../queue/queue.js";

export interface AppContext {
  cfg: Config;
  db: Db;
  redis: Redis;
  queue: EnrichQueue;
  log: Logger;
}
