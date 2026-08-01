import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn() }));

vi.mock("@/lib/tauri-api", () => ({ isTauri: isTauriMock }));

import {
  CUSTOM_SUBAGENTS_CHANGE_EVENT,
  CUSTOM_SUBAGENTS_STORAGE_KEY,
  isCustomSubagentsEnabled,
  isMultiActiveSessionsEnabled,
  setCustomSubagentsEnabled,
} from "./features";

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

describe("custom subagents experiment", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true);
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is off by default and only accepts the enabled marker", () => {
    expect(isCustomSubagentsEnabled()).toBe(false);

    window.localStorage.setItem(CUSTOM_SUBAGENTS_STORAGE_KEY, "0");
    expect(isCustomSubagentsEnabled()).toBe(false);

    window.localStorage.setItem(CUSTOM_SUBAGENTS_STORAGE_KEY, "1");
    expect(isCustomSubagentsEnabled()).toBe(true);
  });

  it("is always off outside the desktop runtime", () => {
    isTauriMock.mockReturnValue(false);
    window.localStorage.setItem(CUSTOM_SUBAGENTS_STORAGE_KEY, "1");
    expect(isCustomSubagentsEnabled()).toBe(false);
  });

  it("persists changes and broadcasts them to same-window subscribers", () => {
    const listener = vi.fn();
    window.addEventListener(CUSTOM_SUBAGENTS_CHANGE_EVENT, listener);

    setCustomSubagentsEnabled(true);
    expect(window.localStorage.getItem(CUSTOM_SUBAGENTS_STORAGE_KEY)).toBe("1");
    expect(listener).toHaveBeenCalledTimes(1);

    setCustomSubagentsEnabled(false);
    expect(window.localStorage.getItem(CUSTOM_SUBAGENTS_STORAGE_KEY)).toBe("0");
    expect(listener).toHaveBeenCalledTimes(2);

    window.removeEventListener(CUSTOM_SUBAGENTS_CHANGE_EVENT, listener);
  });

  it("fails closed when localStorage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("localStorage unavailable");
    });
    expect(isCustomSubagentsEnabled()).toBe(false);
  });
});
