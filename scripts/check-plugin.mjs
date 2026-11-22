import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const errors = [];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// 1. Mobile & DOM compliance on client/ (excluding client/web.ts)
const domPattern = /\b(document\.|window\.|localStorage|navigator\.)|\b(className=|onClick=)/;
for (const file of walk(join(root, "client"))) {
  const rel = relative(root, file);
  if (rel === "client/web.ts") continue;
  const content = readFileSync(file, "utf8");
  if (domPattern.test(content)) {
    errors.push(`Mobile compliance violation (DOM/web-only API) in ${rel}`);
  }
}

// 2. Runtime import boundaries
const forbiddenInClientOrShared = /from\s+["'](\.\.\/)?(server\/|node:)/;
for (const dir of ["client", "shared"]) {
  for (const file of walk(join(root, dir))) {
    const rel = relative(root, file);
    if (forbiddenInClientOrShared.test(readFileSync(file, "utf8"))) {
      errors.push(`Runtime boundary violation (server/node import) in ${rel}`);
    }
  }
}

const forbiddenInServerOrShared = /from\s+["'](\.\.\/)?(client\/|react|react-native)/;
for (const dir of ["server", "shared"]) {
  for (const file of walk(join(root, dir))) {
    const rel = relative(root, file);
    if (forbiddenInServerOrShared.test(readFileSync(file, "utf8"))) {
      errors.push(`Runtime boundary violation (client/react import) in ${rel}`);
    }
  }
}

// 3. Marketplace OVERVIEW*.md em-dash check
for (const name of ["OVERVIEW.md", "OVERVIEW.zh-CN.md"]) {
  const content = readFileSync(join(root, name), "utf8");
  if (content.includes("—")) {
    errors.push(`Marketplace overview ${name} must not contain em dashes (—)`);
  }
}

if (errors.length > 0) {
  for (const err of errors) {
    console.error(`ERROR: ${err}`);
  }
  process.exit(1);
}

console.log("Plugin compliance checks passed (mobile, runtime boundaries, OVERVIEW*.md).");
