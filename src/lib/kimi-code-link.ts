import { isTauri, openExternal } from "@/lib/tauri-api";

export const KIMI_CODE_URL = "https://www.kimi.com/code";
export const LEGACY_KIMI_CLI_URL = "https://moonshotai.github.io/kimi-cli/";

export function shouldInterceptKimiCodeLink(): boolean {
  return isTauri();
}

function openExternalWebsite(url: string): void {
  const fallback = () => {
    window.open(url, "_blank", "noopener,noreferrer");
  };

  if (!isTauri()) {
    fallback();
    return;
  }

  openExternal(url).catch(fallback);
}

export function openKimiCodeWebsite(): void {
  openExternalWebsite(KIMI_CODE_URL);
}

export function openLegacyKimiCliWebsite(): void {
  openExternalWebsite(LEGACY_KIMI_CLI_URL);
}
