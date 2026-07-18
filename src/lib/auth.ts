/**
 * Auth token storage for Kimi API requests.
 *
 * Security note: tokens are stored in localStorage for now (not OS keychain).
 * Any XSS in the webview could read them. `consumeAuthTokenFromUrl` handles the
 * one-time OAuth callback; do not read tokens from URL query params elsewhere.
 */
const AUTH_TOKEN_KEY = "kimi_auth_token";
const AUTH_TOKEN_TIMESTAMP_KEY = "kimi_auth_token_ts";
const AUTH_TOKEN_PARAM = "token";
const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

export function getAuthToken(): string | null {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (!token) {
    return null;
  }

  // Check if token has expired
  const timestamp = localStorage.getItem(AUTH_TOKEN_TIMESTAMP_KEY);
  if (timestamp) {
    const storedAt = parseInt(timestamp, 10);
    if (Number.isNaN(storedAt)) {
      // Treat non-parsable timestamps as expired/corrupted
      clearAuthToken();
      return null;
    }
    const age = Date.now() - storedAt;
    if (age > TOKEN_EXPIRY_MS) {
      clearAuthToken();
      return null;
    }
  }

  return token;
}

export function setAuthToken(token: string): void {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  localStorage.setItem(AUTH_TOKEN_TIMESTAMP_KEY, Date.now().toString());
}

export function clearAuthToken(): void {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_TOKEN_TIMESTAMP_KEY);
}

/** Consume a one-time token from the OAuth callback URL and remove it from the address bar. */
export function consumeAuthTokenFromUrl(): string | null {
  const url = new URL(window.location.href);
  const token = url.searchParams.get(AUTH_TOKEN_PARAM);
  if (!token) {
    return null;
  }
  url.searchParams.delete(AUTH_TOKEN_PARAM);
  window.history.replaceState({}, "", url.toString());
  return token;
}

export function getAuthHeader(): Record<string, string> {
  const token = getAuthToken();
  if (!token) {
    return {};
  }
  return { Authorization: `Bearer ${token}` };
}
