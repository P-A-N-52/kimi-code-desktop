import { getKimiCliVersion } from "@/lib/tauri-api";

declare const __KIMI_CLI_VERSION__: string | undefined;
declare const __APP_VERSION__: string | undefined;

export const desktopVersion =
  typeof __APP_VERSION__ !== "undefined" && __APP_VERSION__ ? __APP_VERSION__ : "dev";

/** Build-time fallback when live `kimi --version` probing is unavailable. */
export const kimiCodeCliFallbackVersion =
  typeof __KIMI_CLI_VERSION__ !== "undefined" && __KIMI_CLI_VERSION__
    ? __KIMI_CLI_VERSION__
    : "dev";

/** @deprecated Use `kimiCodeCliFallbackVersion` — kept for existing imports. */
export const bundledKimiCliVersion = kimiCodeCliFallbackVersion;

export const kimiCodeCliVersion = kimiCodeCliFallbackVersion;

/** @deprecated Use `kimiCodeCliVersion` — kept for existing imports. */
export const kimiCliVersion = kimiCodeCliVersion;

let resolvedKimiCodeCliVersion: string | null = null;
let versionRequest: Promise<string> | null = null;

export function resolveKimiCliVersion(): Promise<string> {
  if (resolvedKimiCodeCliVersion) {
    return Promise.resolve(resolvedKimiCodeCliVersion);
  }

  if (!versionRequest) {
    versionRequest = getKimiCliVersion()
      .then((version) => {
        const trimmed = version.trim();
        resolvedKimiCodeCliVersion = trimmed || kimiCodeCliFallbackVersion;
        return resolvedKimiCodeCliVersion;
      })
      .catch(() => {
        resolvedKimiCodeCliVersion = kimiCodeCliFallbackVersion;
        return resolvedKimiCodeCliVersion;
      });
  }

  return versionRequest;
}
