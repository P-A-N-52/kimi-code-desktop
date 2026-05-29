import { isTauri, openExternal } from "@/lib/tauri-api";

export const KIMI_CODE_URL = "https://www.kimi.com/code";

export function shouldInterceptKimiCodeLink(): boolean {
  return isTauri();
}

export function openKimiCodeWebsite(): void {
  const fallback = () => {
    window.open(KIMI_CODE_URL, "_blank", "noopener,noreferrer");
  };

  if (!isTauri()) {
    fallback();
    return;
  }

  openExternal(KIMI_CODE_URL).catch(fallback);
}
