import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
import { defineConfig } from "vite";

const PYPROJECT_VERSION_REGEX = /^\s*version\s*=\s*"([^"]+)"/m;
const PACKAGE_VERSION_REGEX = /^\s*"version"\s*:\s*"([^"]+)"/m;
const KIMI_VERSION_PROBE_TIMEOUT_MS = 1500;

function parseVersionFromOutput(output: string): string | null {
  const match = output.match(/\b(\d+(?:\.\d+)+(?:[-+][A-Za-z0-9.-]+)?)\b/);
  return match?.[1] ?? null;
}

function readPackageVersion(): string {
  const packageJsonPath = path.resolve(__dirname, "package.json");
  try {
    const packageJson = fs.readFileSync(packageJsonPath, "utf8");
    const match = packageJson.match(PACKAGE_VERSION_REGEX);
    if (match?.[1]) {
      return match[1];
    }
  } catch (error) {
    console.warn("[vite] Unable to read package version", packageJsonPath, error);
  }
  return "dev";
}

function readInstalledKimiCliVersion(): string | null {
  const candidates = ["kimi"];
  if (process.platform === "win32") {
    candidates.push(path.join(os.homedir(), ".local", "bin", "kimi.exe"));
  }

  for (const candidate of candidates) {
    try {
      const output = execFileSync(candidate, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: KIMI_VERSION_PROBE_TIMEOUT_MS,
      });
      const version = parseVersionFromOutput(output);
      if (version) {
        return version;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function readKimiCliVersion(): string {
  if (process.env.KIMI_CLI_VERSION) {
    return process.env.KIMI_CLI_VERSION;
  }

  const pyprojectPath = path.resolve(__dirname, "../kimi-cli/pyproject.toml");
  if (!fs.existsSync(pyprojectPath)) {
    if (process.env.KIMI_PROBE_CLI_VERSION === "1") {
      return readInstalledKimiCliVersion() ?? readPackageVersion();
    }
    return readPackageVersion();
  }

  try {
    const pyproject = fs.readFileSync(pyprojectPath, "utf8");
    const match = pyproject.match(PYPROJECT_VERSION_REGEX);
    if (match?.[1]) {
      return match[1];
    }
  } catch (error) {
    console.warn("[vite] Unable to read version", pyprojectPath, error);
  }

  if (process.env.KIMI_PROBE_CLI_VERSION === "1") {
    return readInstalledKimiCliVersion() ?? readPackageVersion();
  }

  return readPackageVersion();
}

const kimiCliVersion = readKimiCliVersion();
const shouldAnalyze = process.env.ANALYZE === "true";

function manualChunks(id: string): string | undefined {
  const normalizedId = id.replaceAll("\\", "/");

  if (!normalizedId.includes("node_modules")) {
    return undefined;
  }

  if (normalizedId.includes("@tauri-apps")) {
    return "vendor-tauri";
  }
  if (normalizedId.includes("@radix-ui") || normalizedId.includes("/radix-ui/")) {
    return "vendor-radix";
  }
  if (normalizedId.includes("@codemirror") || normalizedId.includes("@uiw/react-codemirror")) {
    return "vendor-codemirror";
  }
  if (normalizedId.includes("@xyflow")) {
    return "vendor-diagrams";
  }
  if (normalizedId.includes("@tanstack")) {
    return "vendor-table";
  }
  if (normalizedId.includes("lucide-react")) {
    return "vendor-icons";
  }
  if (
    normalizedId.includes("zustand") ||
    normalizedId.includes("/swr/") ||
    normalizedId.includes("nanoid") ||
    normalizedId.includes("uuid")
  ) {
    return "vendor-state";
  }
  if (normalizedId.includes("react") || normalizedId.includes("scheduler")) {
    return "vendor-react";
  }

  return undefined;
}

// https://vitejs.dev/config/
export default defineConfig({
  base: "./",
  clearScreen: false,
  plugins: [
    react(),
    tailwindcss(),
    ...(shouldAnalyze
      ? [
          visualizer({
            brotliSize: true,
            filename: "dist/bundle-report.html",
            gzipSize: true,
            open: false,
            template: "treemap",
          }),
        ]
      : []),
  ],
  define: {
    __KIMI_CLI_VERSION__: JSON.stringify(kimiCliVersion),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@ai-elements": path.resolve(__dirname, "./src/components/ai-elements"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET ?? "http://127.0.0.1:5494",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 800,
    outDir: "dist",
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
});
