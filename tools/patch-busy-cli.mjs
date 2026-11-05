#!/usr/bin/env node
// Works around a busy-cli bug on Windows (seen in @busy-app/cli 0.6.0): its font-maps Vite plugin
// writes `import f0 from 'C:\Users\...\large.json'`, where the backslashes become string escapes,
// so the build fails with "Rolldown failed to resolve import". Rewrites the path with forward
// slashes. Idempotent; does nothing on other platforms or once fixed upstream.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const file = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@busy-app", "cli", "dist", "lib", "fontMapsPlugin.js");
const BROKEN = "from '${resolve(maps, `${f}.json`)}';";
const FIXED = "from '${resolve(maps, `${f}.json`).replace(/\\\\/g, '/')}';";

if (existsSync(file)) {
  const code = readFileSync(file, "utf8");
  if (code.includes(BROKEN)) {
    writeFileSync(file, code.replace(BROKEN, FIXED));
    console.log("patched @busy-app/cli fontMapsPlugin.js (Windows paths)");
  }
}
