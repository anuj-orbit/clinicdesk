import { getPg, getMongoDb as getMongoDbDefault } from "./db.js";
import { memoryUsersRepo } from "./data/memory/users.js";
import { memorySessionsRepo } from "./data/memory/sessions.js";
import { memoryAvailabilityRepo } from "./data/memory/availability.js";
import { memoryBookingsRepo } from "./data/memory/bookings.js";
import { memoryAuditRepo } from "./data/memory/audit.js";
import { pgUsersRepo } from "./data/pg/users.js";
import { pgSessionsRepo } from "./data/pg/sessions.js";
import { pgAvailabilityRepo } from "./data/pg/availability.js";
import { pgBookingsRepo } from "./data/pg/bookings.js";
import { mongoAuditRepo } from "./data/mongo/audit.js";

/**
 * Builds the repo set. Postgres-backed implementations are used when a pool is
 * available, memory ones otherwise. The Mongo audit is used when a Mongo
 * getter is available, memory otherwise.
 */
export function buildRepos({ pool, getMongoDb } = {}) {
  const pgPool = pool === undefined ? getPg() : pool;
  const mongoGetter =
    getMongoDb !== undefined
      ? getMongoDb
      : process.env.MONGODB_URI
        ? getMongoDbDefault
        : undefined;

  return {
    users: pgPool ? pgUsersRepo(pgPool) : memoryUsersRepo(),
    sessions: pgPool ? pgSessionsRepo(pgPool) : memorySessionsRepo(),
    availability: pgPool ? pgAvailabilityRepo(pgPool) : memoryAvailabilityRepo(),
    bookings: pgPool ? pgBookingsRepo(pgPool) : memoryBookingsRepo(),
    audit: mongoGetter ? mongoAuditRepo(mongoGetter) : memoryAuditRepo(),
  };
}
