/**
 * @questboard/server build.
 *
 * Bundles src/main.ts → dist/main.js via esbuild so the published
 * package can run without the workspace layout. The mjs stdio-helpers
 * (spawned as separate child processes) are copied to their dist/
 * locations so the bundled main.js can still locate them via
 * import.meta.url-relative lookup. See src/composer/mcp.ts and
 * src/mcp/agent-mcp.ts for the resolveHelperPath() candidates.
 *
 * Externals:
 *  - better-sqlite3: native addon
 *  - fastify, @fastify/*: dynamic require / plugin discovery breaks bundling
 *
 * Everything else (including @questboard/core via workspace import) is
 * inlined.
 */
import { build } from "esbuild";
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "dist");

mkdirSync(distDir, { recursive: true });

await build({
  entryPoints: [join(here, "src", "main.ts")],
  outfile: join(distDir, "main.js"),
  platform: "node",
  target: "node20",
  format: "esm",
  bundle: true,
  sourcemap: true,
  // ESM bundle that uses node built-ins via require() needs this so esbuild
  // emits a top-level createRequire shim.
  banner: {
    js:
      "import { createRequire as __qbCreateRequire } from 'node:module';\n" +
      "const require = __qbCreateRequire(import.meta.url);\n",
  },
  external: [
    "better-sqlite3",
    "fastify",
    "@fastify/cors",
    "@fastify/multipart",
  ],
  logLevel: "info",
});

// Copy mjs helpers to their canonical dist locations so the bundled
// main.js can spawn them as standalone Node child processes.
const helpers = [
  ["src/composer/mcp-stdio-helper.mjs", "dist/composer/mcp-stdio-helper.mjs"],
  ["src/mcp/agent-mcp-stdio-helper.mjs", "dist/mcp/agent-mcp-stdio-helper.mjs"],
];
for (const [src, dst] of helpers) {
  const srcAbs = join(here, src);
  const dstAbs = join(here, dst);
  mkdirSync(dirname(dstAbs), { recursive: true });
  copyFileSync(srcAbs, dstAbs);
}

// Copy @questboard/core's schema.sql next to the bundle. db.ts reads
// it at runtime via readFileSync; inlining via esbuild loader is also
// possible but a sibling file keeps the schema visible/auditable in
// the published tarball.
const schemaSrc = join(here, "..", "core", "src", "schema.sql");
const schemaDst = join(distDir, "schema.sql");
copyFileSync(schemaSrc, schemaDst);
