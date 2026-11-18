import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["src", "test", "public/js", "scripts"];
const files = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // directory not present yet (e.g. public/js before Area C)
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(full);
    }
  }
}

for (const root of ROOTS) {
  walk(root);
}

let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failed = true;
    console.error(`lint: syntax error in ${relative(process.cwd(), file)}`);
    if (result.stderr) console.error(result.stderr.trim());
  }
}

if (failed) {
  console.error(`lint: ${files.length} file(s) checked, failures above.`);
  process.exit(1);
}

console.log(`lint: ${files.length} file(s) OK.`);
