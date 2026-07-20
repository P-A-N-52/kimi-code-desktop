#!/usr/bin/env node
/**
 * Cross-platform lightweight pre-merge checks.
 * Mirrors the core gates from release-preflight.ps1 without PowerShell-only steps.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function runStep(name, command, args) {
  console.log(`\n==> ${name}`);
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    console.error(`\n${name} failed with exit code ${result.status ?? 1}`);
    process.exit(result.status ?? 1);
  }
}

const steps = [
  ["Version alignment check", "node", ["scripts/sync-version.js"]],
  ["Frontend unit tests", "npm", ["run", "test"]],
  ["Type check", "npx", ["tsc", "-b"]],
  ["Frontend production build", "npm", ["run", "build"]],
  ["Rust check", "npm", ["run", "rust:check"]],
  ["Rust unit tests", "npm", ["run", "rust:test"]],
];

for (const [name, command, args] of steps) {
  runStep(name, command, args);
}

console.log("\nAll quick checks passed.");
