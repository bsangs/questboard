/**
 * Structured JSONL logger for the dispatcher.
 *
 * One line per event in .questboard/data/logs/dispatcher.jsonl. Always also
 * mirrors to stdout so PM2's `pm2 logs` view stays useful. Logging is best
 * effort — failures never throw to the caller.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface LogFields {
  event: string;
  card_id?: string;
  pid?: number;
  exit_code?: number | null;
  signal?: NodeJS.Signals | null;
  attempt?: number;
  reason?: string;
  message?: string;
  [key: string]: unknown;
}

export class Logger {
  private stream: fs.WriteStream | null = null;

  constructor(private readonly file: string) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.stream = fs.createWriteStream(file, { flags: "a" });
      this.stream.on("error", () => {
        this.stream = null;
      });
    } catch {
      this.stream = null;
    }
  }

  log(fields: LogFields): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...fields });
    // Always stdout (PM2).
    process.stdout.write(line + "\n");
    // Best-effort file mirror.
    if (this.stream) {
      try {
        this.stream.write(line + "\n");
      } catch {
        // ignore
      }
    }
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}
