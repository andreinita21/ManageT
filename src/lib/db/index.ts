/**
 * Database connection singleton for ManageT.
 * Uses better-sqlite3 with Drizzle ORM.
 */
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema";

const sqlite = new Database(
  process.env.DATABASE_URL?.replace("file:", "") || "./data/managet.db"
);

// Connection pragmas. These must run on every fresh connection:
//  - foreign_keys=ON makes the schema's onDelete cascades/set-null actually
//    fire (SQLite defaults to OFF, which silently leaves orphan rows).
//  - WAL + busy_timeout lets the many concurrent writers (per-host heartbeats,
//    status sweeper, hourly pruner, API writes) coexist without intermittent
//    SQLITE_BUSY / "database is locked" errors.
//  - synchronous=NORMAL is the safe/fast pairing with WAL.
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 5000");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("synchronous = NORMAL");

export const db = drizzle(sqlite, { schema });
