import { useCallback, useEffect, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

export type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "kimi-theme";
const THEME_SWITCHING_ATTR = "data-theme-switching";
const THEME_SWITCH_DURATION_MS = 450;
/** Hold the in-flight lock after a view transition so Chromium can tear down layers. */
const THEME_TRANSITION_COOLDOWN_MS = 160;
const THEME_CX_VAR = "--kimi-theme-cx";
const THEME_CY_VAR = "--kimi-theme-cy";
const THEME_RADIUS_VAR = "--kimi-theme-radius";
const THEME_DURATION_VAR = "--kimi-theme-duration";

/** Ignore rapid theme toggles while a view transition / apply is in flight. */
let themeTransitionInFlight = false;
/** If the user toggles again during a lock, apply this once the lock clears. */
let pendingThemeApply: (() => void) | null = null;
let pendingThemeEvent: ThemeTransitionEvent | undefined;
/** Skip Tauri window.setTheme during VT; sync after finished. */
let deferNativeWindowTheme = false;

type ThemeState = {
  theme: Theme;
  hasUserPreference: boolean;
};

export type ThemeTransitionEvent = Pick<MouseEvent, "clientX" | "clientY">;

type ThemeTransitionPoint = {
  x: number;
  y: number;
};

type UseThemeResult = {
  theme: Theme;
  setTheme: (next: Theme) => void;
  setThemeWithTransition: (
    next: Theme,
    event?: ThemeTransitionEvent,
  ) => Promise<void>;
  toggleTheme: () => void;
  toggleThemeWithTransition: (event?: ThemeTransitionEvent) => Promise<void>;
};

type ThemeListener = () => void;

const themeListeners = new Set<ThemeListener>();
let currentThemeState: ThemeState | null = null;

/** @internal test-only — clear transition locks between cases. */
export function __resetThemeTransitionForTests(): void {
  themeTransitionInFlight = false;
  pendingThemeApply = null;
  pendingThemeEvent = undefined;
  deferNativeWindowTheme = false;
  currentThemeState = null;
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.removeAttribute(THEME_SWITCHING_ATTR);
    root.style.removeProperty(THEME_CX_VAR);
    root.style.removeProperty(THEME_CY_VAR);
    root.style.removeProperty(THEME_RADIUS_VAR);
    root.style.removeProperty(THEME_DURATION_VAR);
  }
}

function resolveSystemTheme(): Theme {
  if (typeof window === "undefined") {
    return "light";
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function getInitialTheme(): ThemeState {
  if (typeof window === "undefined") {
    return { theme: "light", hasUserPreference: false };
  }

  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") {
    return { theme: stored, hasUserPreference: true };
  }

  return { theme: resolveSystemTheme(), hasUserPreference: false };
}

function getThemeState(): ThemeState {
  currentThemeState ??= getInitialTheme();
  return currentThemeState;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function syncNativeWindowTheme(theme: Theme): void {
  if (!isTauriRuntime()) return;
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(theme))
    .catch(() => {});
}

function applyThemeState(
  state: ThemeState,
  options: { syncNativeWindow?: boolean } = {},
): void {
  const syncNativeWindow =
    options.syncNativeWindow ?? !deferNativeWindowTheme;

  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.classList.toggle("dark", state.theme === "dark");
    root.style.colorScheme = state.theme;
  }

  if (typeof window === "undefined") {
    return;
  }

  if (syncNativeWindow) {
    syncNativeWindowTheme(state.theme);
  }

  if (state.hasUserPreference) {
    window.localStorage.setItem(THEME_STORAGE_KEY, state.theme);
  } else {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
  }
}

function setThemeState(
  next: ThemeState,
  options: { syncNativeWindow?: boolean } = {},
): void {
  const previous = getThemeState();
  if (
    previous.theme === next.theme &&
    previous.hasUserPreference === next.hasUserPreference
  ) {
    applyThemeState(next, options);
    return;
  }

  currentThemeState = next;
  applyThemeState(next, options);
  themeListeners.forEach((listener) => listener());
}

function subscribeTheme(listener: ThemeListener): () => void {
  themeListeners.add(listener);
  return () => {
    themeListeners.delete(listener);
  };
}

function getThemeSnapshot(): ThemeState {
  return getThemeState();
}

function getTransitionPoint(
  event?: ThemeTransitionEvent,
): ThemeTransitionPoint {
  return {
    x: event?.clientX ?? window.innerWidth / 2,
    y: event?.clientY ?? window.innerHeight / 2,
  };
}

function getMaxRadius(point: ThemeTransitionPoint): number {
  const maxX = Math.max(point.x, window.innerWidth - point.x);
  const maxY = Math.max(point.y, window.innerHeight - point.y);
  return Math.hypot(maxX, maxY);
}

function startThemeSwitching(root: HTMLElement): void {
  root.setAttribute(THEME_SWITCHING_ATTR, "true");
}

function stopThemeSwitching(root: HTMLElement): void {
  root.removeAttribute(THEME_SWITCHING_ATTR);
}

function stopThemeSwitchingNextFrame(root: HTMLElement): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      stopThemeSwitching(root);
    });
  });
}

function setThemeRevealVars(root: HTMLElement, event?: ThemeTransitionEvent): void {
  const point = getTransitionPoint(event);
  const radius = getMaxRadius(point);
  root.style.setProperty(THEME_CX_VAR, `${point.x}px`);
  root.style.setProperty(THEME_CY_VAR, `${point.y}px`);
  root.style.setProperty(THEME_RADIUS_VAR, `${radius}px`);
  root.style.setProperty(THEME_DURATION_VAR, `${THEME_SWITCH_DURATION_MS}ms`);
}

function clearThemeRevealVars(root: HTMLElement): void {
  root.style.removeProperty(THEME_CX_VAR);
  root.style.removeProperty(THEME_CY_VAR);
  root.style.removeProperty(THEME_RADIUS_VAR);
  root.style.removeProperty(THEME_DURATION_VAR);
}

function canUseViewTransition(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof window !== "undefined" &&
    typeof document.startViewTransition === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function runThemeTransition(
  apply: () => void,
  event?: ThemeTransitionEvent,
): Promise<void> {
  if (themeTransitionInFlight) {
    pendingThemeApply = apply;
    pendingThemeEvent = event;
    return;
  }
  themeTransitionInFlight = true;
  pendingThemeApply = null;
  pendingThemeEvent = undefined;

  try {
    if (!canUseViewTransition()) {
      if (typeof document !== "undefined") {
        const root = document.documentElement;
        startThemeSwitching(root);
        flushSync(apply);
        stopThemeSwitchingNextFrame(root);
      } else {
        apply();
      }
      return;
    }

    const root = document.documentElement;
    startThemeSwitching(root);
    setThemeRevealVars(root, event);
    deferNativeWindowTheme = true;

    const transition = document.startViewTransition(() => {
      flushSync(apply);
    });

    try {
      await transition.ready;
      // Circle reveal is CSS-driven via --kimi-theme-* vars.
      // Avoid Element.animate(..., { pseudoElement }) — that STATUS_BREAKPOINTs
      // on WebView2 when theme is toggled quickly.
      await transition.finished;
    } catch {
      // AbortError during teardown — theme DOM state is already applied.
    } finally {
      deferNativeWindowTheme = false;
      clearThemeRevealVars(root);
      stopThemeSwitching(root);
      syncNativeWindowTheme(getThemeState().theme);
      await delay(THEME_TRANSITION_COOLDOWN_MS);
    }
  } finally {
    deferNativeWindowTheme = false;
    themeTransitionInFlight = false;
    const queued = pendingThemeApply;
    const queuedEvent = pendingThemeEvent;
    pendingThemeApply = null;
    pendingThemeEvent = undefined;
    if (queued) {
      await runThemeTransition(queued, queuedEvent);
    }
  }
}

export function useTheme(): UseThemeResult {
  const { theme, hasUserPreference } = useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getThemeSnapshot,
  );

  useEffect(() => {
    applyThemeState({ theme, hasUserPreference });
  }, [hasUserPreference, theme]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent) => {
      const previous = getThemeState();
      if (previous.hasUserPreference) return;
      setThemeState({
        theme: event.matches ? "dark" : "light",
        hasUserPreference: false,
      });
    };

    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) {
        return;
      }

      if (event.newValue === "light" || event.newValue === "dark") {
        setThemeState({ theme: event.newValue, hasUserPreference: true });
      } else {
        setThemeState({ theme: resolveSystemTheme(), hasUserPreference: false });
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState({ theme: next, hasUserPreference: true });
  }, []);

  const setThemeWithTransition = useCallback(
    async (next: Theme, event?: ThemeTransitionEvent) => {
      if (getThemeState().theme === next) {
        setThemeState({ theme: next, hasUserPreference: true });
        return;
      }

      await runThemeTransition(() => {
        setThemeState({ theme: next, hasUserPreference: true });
      }, event);
    },
    [],
  );

  const toggleTheme = useCallback(() => {
    const previous = getThemeState();
    setThemeState({
      theme: previous.theme === "dark" ? "light" : "dark",
      hasUserPreference: true,
    });
  }, []);

  const toggleThemeWithTransition = useCallback(
    async (event?: ThemeTransitionEvent) => {
      await runThemeTransition(() => {
        const previous = getThemeState();
        setThemeState({
          theme: previous.theme === "dark" ? "light" : "dark",
          hasUserPreference: true,
        });
      }, event);
    },
    [],
  );

  return {
    theme,
    setTheme,
    setThemeWithTransition,
    toggleTheme,
    toggleThemeWithTransition,
  };
}
