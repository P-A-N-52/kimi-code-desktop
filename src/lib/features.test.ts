import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn() }));

vi.mock("@/lib/tauri-api", () => ({ isTauri: isTauriMock }));

import { isMultiActiveSessionsEnabled } from "./features";

const DEV_LOCAL_STORAGE_KEY = "kimi-code-desktop.experimental.multi-active-sessions.v1";

describe("isMultiActiveSessionsEnabled", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true);
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is off by default", () => {
    expect(isMultiActiveSessionsEnabled()).toBe(false);
  });

  it("is off in web / non-Tauri builds even with the build-time env set", () => {
    isTauriMock.mockReturnValue(false);
    vi.stubEnv("VITE_G5_MULTI_ACTIVE_SESSIONS", "true");
    expect(isMultiActiveSessionsEnabled()).toBe(false);
  });

  it("enables via the build-time env variable", () => {
    vi.stubEnv("VITE_G5_MULTI_ACTIVE_SESSIONS", "true");
    expect(isMultiActiveSessionsEnabled()).toBe(true);
  });

  it("enables via the dev localStorage override", () => {
    vi.stubEnv("DEV", true);
    window.localStorage.setItem(DEV_LOCAL_STORAGE_KEY, "1");
    expect(isMultiActiveSessionsEnabled()).toBe(true);
  });

  it("ignores the localStorage override outside dev builds", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_G5_MULTI_ACTIVE_SESSIONS", "false");
    window.localStorage.setItem(DEV_LOCAL_STORAGE_KEY, "1");
    expect(isMultiActiveSessionsEnabled()).toBe(false);
  });
});
