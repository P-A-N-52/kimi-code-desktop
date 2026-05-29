import { getKimiCliVersion } from "@/lib/tauri-api";

declare const __KIMI_CLI_VERSION__: string | undefined;

export const bundledKimiCliVersion =
  typeof __KIMI_CLI_VERSION__ !== "undefined" && __KIMI_CLI_VERSION__
    ? __KIMI_CLI_VERSION__
    : "dev";

export const kimiCliVersion = bundledKimiCliVersion;

let resolvedKimiCliVersion: string | null = null;
let versionRequest: Promise<string> | null = null;

export function resolveKimiCliVersion(): Promise<string> {
  if (bundledKimiCliVersion && bundledKimiCliVersion !== "dev") {
    resolvedKimiCliVersion = bundledKimiCliVersion;
    return Promise.resolve(bundledKimiCliVersion);
  }

  if (resolvedKimiCliVersion) {
    return Promise.resolve(resolvedKimiCliVersion);
  }

  if (!versionRequest) {
    versionRequest = getKimiCliVersion()
      .then((version) => {
        const trimmed = version.trim();
        resolvedKimiCliVersion = trimmed || bundledKimiCliVersion;
        return resolvedKimiCliVersion;
      })
      .catch(() => bundledKimiCliVersion);
  }

  return versionRequest;
}
