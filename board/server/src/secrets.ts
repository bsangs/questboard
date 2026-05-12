import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { env } from "./env.js";

interface SecretRecord {
  iv: string;
  tag: string;
  ciphertext: string;
  created_at: string;
}

interface SecretStoreFile {
  version: 1;
  secrets: Record<string, SecretRecord>;
}

const STORE_PATH = join(env.BOARD_DATA, "secrets.json");

function key(): Buffer {
  if (!secretStoreConfigured()) {
    throw new Error("SECRET_KEY is not configured");
  }
  return createHash("sha256").update(env.SECRET_KEY, "utf8").digest();
}

function readStore(): SecretStoreFile {
  if (!existsSync(STORE_PATH)) return { version: 1, secrets: {} };
  const raw = JSON.parse(readFileSync(STORE_PATH, "utf8")) as Partial<SecretStoreFile>;
  return {
    version: 1,
    secrets: raw.secrets && typeof raw.secrets === "object" ? raw.secrets : {},
  };
}

function writeStore(store: SecretStoreFile): void {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
  renameSync(tmp, STORE_PATH);
}

export function secretStoreConfigured(): boolean {
  return env.SECRET_KEY.trim() !== "";
}

export function envSecretRef(name: string): string {
  return `env.${name}`;
}

export function hasSecret(ref: string): boolean {
  return Boolean(readStore().secrets[ref]);
}

export function createSecret(ref: string, value: string): void {
  const store = readStore();
  if (store.secrets[ref]) {
    throw new Error(`secret already exists: ${ref}`);
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  store.secrets[ref] = {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    created_at: new Date().toISOString(),
  };
  writeStore(store);
}

export function deleteSecret(ref: string): void {
  const store = readStore();
  delete store.secrets[ref];
  writeStore(store);
}

export function readSecret(ref: string): string | null {
  const record = readStore().secrets[ref];
  if (!record) return null;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(record.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
