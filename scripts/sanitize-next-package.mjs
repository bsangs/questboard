import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = resolve(root, "ui");

const files = [
  resolve(uiDir, ".next", "required-server-files.json"),
  resolve(uiDir, ".next", "required-server-files.js"),
];

const replacements = [
  [uiDir, "__QUESTBOARD_UI_DIR__"],
  [root, "__QUESTBOARD_APP_ROOT__"],
];

for (const file of files) {
  if (!existsSync(file)) continue;
  let text = readFileSync(file, "utf8");
  const next = replacements.reduce(
    (acc, [from, to]) => acc.split(from).join(to),
    text,
  );
  if (next !== text) {
    writeFileSync(file, next, "utf8");
  }
}
