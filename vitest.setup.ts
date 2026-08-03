import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Some environments (e.g. newer Node + jsdom combos) expose `window` without
// `localStorage`; the stream suites read/write it in beforeEach. Polyfill an
// in-memory store only when missing so tests stay runnable there.
if (typeof window !== "undefined" && !window.localStorage) {
  const backing = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    writable: true,
    value: {
      getItem: (key: string) => (backing.has(key) ? backing.get(key) : null),
      setItem: (key: string, value: string) => {
        backing.set(key, String(value));
      },
      removeItem: (key: string) => {
        backing.delete(key);
      },
      clear: () => {
        backing.clear();
      },
      key: (index: number) => [...backing.keys()][index] ?? null,
      get length() {
        return backing.size;
      },
    },
  });
}

// Clean up after each test to avoid state leaking between tests.
afterEach(() => {
  cleanup();
});

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

Object.defineProperty(window, "ResizeObserver", {
  writable: true,
  value: ResizeObserverMock,
});

Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn(() => false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

// Mock Tauri APIs globally for unit tests.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
