import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { isTauri } from "@/lib/tauri-api";

const LATEST_RELEASE_URL =
  "https://api.github.com/repos/P-A-N-52/kimi-code-desktop/releases/latest";

type ReleasePayload = {
  html_url?: unknown;
  tag_name?: unknown;
};

export type DesktopUpdate = {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
};

function versionParts(version: string): number[] | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i);
  if (!match) return null;
  return match.slice(1).map(Number);
}

export function isNewerDesktopVersion(latest: string, current: string): boolean {
  const latestParts = versionParts(latest);
  const currentParts = versionParts(current);
  if (!latestParts || !currentParts) return false;

  for (const [index, part] of latestParts.entries()) {
    const currentPart = currentParts[index] ?? 0;
    if (part === currentPart) continue;
    return part > currentPart;
  }

  return false;
}

export async function checkDesktopUpdate(
  fetcher: typeof fetch = fetch,
): Promise<DesktopUpdate | null> {
  const [currentVersion, response] = await Promise.all([
    getVersion(),
    fetcher(LATEST_RELEASE_URL, {
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store",
    }),
  ]);

  if (!response.ok) {
    throw new Error(`Desktop update check failed with HTTP ${response.status}`);
  }

  const release = (await response.json()) as ReleasePayload;
  if (typeof release.tag_name !== "string" || typeof release.html_url !== "string") {
    throw new Error("Desktop update check returned an invalid release payload");
  }

  const latestVersion = release.tag_name.replace(/^v/i, "");
  if (!isNewerDesktopVersion(latestVersion, currentVersion)) return null;

  return {
    currentVersion,
    latestVersion,
    releaseUrl: release.html_url,
  };
}

export function useDesktopUpdate(): DesktopUpdate | null {
  const [update, setUpdate] = useState<DesktopUpdate | null>(null);

  useEffect(() => {
    if (!isTauri()) return;

    let active = true;
    void checkDesktopUpdate()
      .then((availableUpdate) => {
        if (active) setUpdate(availableUpdate);
      })
      .catch(() => {
        // Update checks must never block startup or show an error-only state.
      });

    return () => {
      active = false;
    };
  }, []);

  return update;
}
