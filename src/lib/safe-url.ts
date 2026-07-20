/** Schemes safe to render in webview media / anchors. */
const SAFE_URL_PROTOCOLS = new Set(["http:", "https:", "data:", "blob:"]);

/** Return true when `url` uses an allowlisted scheme (blocks javascript:/file:/vbscript:). */
export function isSafeBrowserUrl(url: string): boolean {
  try {
    return SAFE_URL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}
