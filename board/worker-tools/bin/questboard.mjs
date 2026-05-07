#!/usr/bin/env node
// Thin shebang wrapper. The compiled `dist/main.js` is the real entry point.
// Build with `pnpm --filter @questboard/worker-tools build` before invoking.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const distMain = resolve(here, "..", "dist", "main.js");

if (!existsSync(distMain)) {
  console.error(
    "[questboard] dist/main.js not found. Run `pnpm --filter @questboard/worker-tools build` first."
  );
  process.exit(1);
}

await import(distMain);
