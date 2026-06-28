// node:sqlite is built into Node.js >=22.5. No native compilation needed.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DB_PATH = resolve(process.env.DATABASE_URL ?? "./data/agent.db");

function createDb(): DatabaseSync {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS conversations (
      phone         TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'collecting',
      data          TEXT NOT NULL DEFAULT '{}',
      history       TEXT NOT NULL DEFAULT '[]',
      updated_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id TEXT NOT NULL,
      phone         TEXT NOT NULL,
      nombre        TEXT NOT NULL,
      fecha         TEXT NOT NULL,
      hora          TEXT NOT NULL,
      personas      INTEGER NOT NULL,
      peticiones    TEXT,
      status        TEXT NOT NULL DEFAULT 'confirmed',
      external_id   TEXT,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id TEXT NOT NULL,
      phone         TEXT NOT NULL,
      items         TEXT NOT NULL,
      total         INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    INTEGER NOT NULL
    );
  `);

  return db;
}

export const db = createDb();
export type { DatabaseSync };
