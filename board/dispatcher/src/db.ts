/**
 * Read-only SQLite handle.
 *
 * The server is the sole writer. Dispatcher opens the same file in read-only
 * mode for queue peeks and heartbeat scans. We open with
 * `fileMustExist: true` so the dispatcher fails loudly on boot if the
 * server has not initialized the DB yet (PM2 will restart and the next
 * attempt should succeed once server is up).
 */
import Database, { type Database as DBType } from "better-sqlite3";

export function openReadOnlyDb(dbPath: string): DBType {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  // SQLite-WAL readers are fine alongside the server's writer.
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  return db;
}
