/**
 * @questboard/dispatcher build. Bundles src/main.ts → dist/main.js.
 *
 * Externals: better-sqlite3 (native addon).
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
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
  banner: {
    js:
      "import { createRequire as __qbCreateRequire } from 'node:module';\n" +
      "const require = __qbCreateRequire(import.meta.url);\n",
  },
  external: ["better-sqlite3"],
  logLevel: "info",
});
