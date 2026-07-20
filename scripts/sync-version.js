#!/usr/bin/env node
/**
 * Sync the desktop shell version across package.json, package-lock.json,
 * Cargo.toml, and tauri.conf.json.
 *
 * Usage:
 *   node scripts/sync-version.js          # Check versions are aligned
 *   node scripts/sync-version.js 0.1.0    # Set all desktop shell versions
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const files = {
  packageJson: path.join(rootDir, "package.json"),
  packageLock: path.join(rootDir, "package-lock.json"),
  cargoToml: path.join(rootDir, "src-tauri", "Cargo.toml"),
  tauriConf: path.join(rootDir, "src-tauri", "tauri.conf.json"),
};

const cliPyprojectPath = path.resolve(rootDir, "..", "kimi-cli", "pyproject.toml");

function readCliVersion() {
  if (!fs.existsSync(cliPyprojectPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(cliPyprojectPath, "utf8");
    const match = content.match(/^\s*version\s*=\s*"([^"]+)"/m);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function readVersion(filePath, parser) {
  const content = fs.readFileSync(filePath, "utf8");
  return parser(content);
}

function parsePackageJson(content) {
  const data = JSON.parse(content);
  return data.version ?? null;
}

function parsePackageLock(content) {
  const data = JSON.parse(content);
  return data.packages?.[""]?.version ?? data.version ?? null;
}

function parseCargoToml(content) {
  const data = parseToml(content);
  return data.package?.version ?? null;
}

function parseTauriConf(content) {
  const data = JSON.parse(content);
  return data.version ?? null;
}

function replaceJsonVersion(content, newVersion) {
  const data = JSON.parse(content);
  data.version = newVersion;
  return `${JSON.stringify(data, null, 2)}\n`;
}

function replacePackageLockVersion(content, newVersion) {
  const data = JSON.parse(content);
  data.version = newVersion;
  if (data.packages?.[""]) {
    data.packages[""].version = newVersion;
  }
  return `${JSON.stringify(data, null, 2)}\n`;
}

function replaceCargoTomlVersion(content, newVersion) {
  const data = parseToml(content);
  if (!data.package) {
    throw new Error("Cargo.toml is missing a [package] section");
  }
  data.package.version = newVersion;
  return `${stringifyToml(data)}\n`;
}

const parsers = {
  packageJson: parsePackageJson,
  packageLock: parsePackageLock,
  cargoToml: parseCargoToml,
  tauriConf: parseTauriConf,
};

const replacers = {
  packageJson: replaceJsonVersion,
  packageLock: replacePackageLockVersion,
  cargoToml: replaceCargoTomlVersion,
  tauriConf: replaceJsonVersion,
};

function getVersions() {
  return Object.fromEntries(
    Object.entries(files).map(([name, filePath]) => [name, readVersion(filePath, parsers[name])]),
  );
}

function validateVersion(newVersion) {
  const semverRegex = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;
  if (!semverRegex.test(newVersion)) {
    console.error(`Invalid version format: ${newVersion}`);
    process.exit(1);
  }
}

const newVersion = process.argv[2];

if (newVersion) {
  validateVersion(newVersion);

  for (const [name, filePath] of Object.entries(files)) {
    const content = fs.readFileSync(filePath, "utf8");
    const updated = replacers[name](content, newVersion);
    fs.writeFileSync(filePath, updated, "utf8");
    console.log(`Updated ${path.relative(rootDir, filePath)} -> ${newVersion}`);
  }

  console.log("\nVersion sync complete.");
  process.exit(0);
}

const versions = getVersions();
const unique = new Set(Object.values(versions));
const cliVersion = readCliVersion();

console.log("Desktop shell versions:");
for (const [name, version] of Object.entries(versions)) {
  const status = version ? "OK" : "MISSING";
  console.log(`  ${status} ${name}: ${version ?? "NOT FOUND"}`);
}

if (unique.size === 1 && !unique.has(null)) {
  console.log(`\nShell versions aligned: ${unique.values().next().value}`);
} else {
  console.error("\nShell version mismatch detected.");
  process.exit(1);
}

if (cliVersion) {
  console.log(`\nDetected kimi-cli source version: ${cliVersion}`);
  console.log(`  source: ${path.relative(rootDir, cliPyprojectPath)}`);
} else {
  console.log("\nkimi-cli source version: not detected (../kimi-cli/pyproject.toml not found)");
}

process.exit(0);
