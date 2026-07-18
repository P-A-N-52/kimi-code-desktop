import { isTauri, openExternal } from "@/lib/tauri-api";

export const KIMI_CODE_URL = "https://www.kimi.com/code";

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
