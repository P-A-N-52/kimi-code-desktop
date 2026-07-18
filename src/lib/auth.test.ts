import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAuthToken,
  consumeAuthTokenFromUrl,
  getAuthHeader,
  getAuthToken,
  setAuthToken,
} from "./auth";

const AUTH_TOKEN_KEY = "kimi_auth_token";
const AUTH_TOKEN_TIMESTAMP_KEY = "kimi_auth_token_ts";

describe("auth", () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset URL
    window.history.replaceState({}, "", "/");
  });

  describe("getAuthToken", () => {
    it("returns null when no token is stored", () => {
      expect(getAuthToken()).toBeNull();
    });

    it("returns token when valid and not expired", () => {
      localStorage.setItem(AUTH_TOKEN_KEY, "my-token");
      localStorage.setItem(AUTH_TOKEN_TIMESTAMP_KEY, Date.now().toString());
      expect(getAuthToken()).toBe("my-token");
    });

    it("clears and returns null for expired token", () => {
      localStorage.setItem(AUTH_TOKEN_KEY, "expired-token");
      localStorage.setItem(AUTH_TOKEN_TIMESTAMP_KEY, "0");
      expect(getAuthToken()).toBeNull();
      expect(localStorage.getItem(AUTH_TOKEN_KEY)).toBeNull();
    });

    it("clears and returns null for corrupted timestamp", () => {
      localStorage.setItem(AUTH_TOKEN_KEY, "token");
      localStorage.setItem(AUTH_TOKEN_TIMESTAMP_KEY, "not-a-number");
      expect(getAuthToken()).toBeNull();
      expect(localStorage.getItem(AUTH_TOKEN_KEY)).toBeNull();
    });
  });

  describe("setAuthToken", () => {
    it("stores token with current timestamp", () => {
      const now = Date.now();
      vi.setSystemTime(now);
      setAuthToken("new-token");
      expect(localStorage.getItem(AUTH_TOKEN_KEY)).toBe("new-token");
      expect(localStorage.getItem(AUTH_TOKEN_TIMESTAMP_KEY)).toBe(now.toString());
      vi.useRealTimers();
    });
  });

  describe("clearAuthToken", () => {
    it("removes token and timestamp", () => {
      localStorage.setItem(AUTH_TOKEN_KEY, "token");
      localStorage.setItem(AUTH_TOKEN_TIMESTAMP_KEY, "123");
      clearAuthToken();
      expect(localStorage.getItem(AUTH_TOKEN_KEY)).toBeNull();
      expect(localStorage.getItem(AUTH_TOKEN_TIMESTAMP_KEY)).toBeNull();
    });
  });

  describe("consumeAuthTokenFromUrl", () => {
    it("returns null when no token param", () => {
      expect(consumeAuthTokenFromUrl()).toBeNull();
    });

    it("extracts token from URL and removes it", () => {
      window.history.replaceState({}, "", "/?token=url-token&other=1");
      expect(consumeAuthTokenFromUrl()).toBe("url-token");
      expect(window.location.search).toBe("?other=1");
    });
  });

  describe("getAuthHeader", () => {
    it("returns empty object when no token", () => {
      expect(getAuthHeader()).toEqual({});
    });

    it("returns Bearer header when token exists in localStorage", () => {
      localStorage.setItem(AUTH_TOKEN_KEY, "stored-token");
      localStorage.setItem(AUTH_TOKEN_TIMESTAMP_KEY, Date.now().toString());
      expect(getAuthHeader()).toEqual({ Authorization: "Bearer stored-token" });
    });

    it("does not fall back to URL token when localStorage is empty", () => {
      window.history.replaceState({}, "", "/?token=url-fallback");
      expect(getAuthHeader()).toEqual({});
    });
  });
});
