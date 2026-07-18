import { useCallback, useEffect, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

export type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "kimi-theme";
const THEME_SWITCHING_ATTR = "data-theme-switching";
const THEME_SWITCH_DURATION_MS = 260;

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
  toggleTheme: () => void;
  toggleThemeWithTransition: (event?: ThemeTransitionEvent) => Promise<void>;
};

type ThemeListener = () => void;

const themeListeners = new Set<ThemeListener>();
let currentThemeState: ThemeState | null = null;

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

function applyThemeState(state: ThemeState): void {
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.classList.toggle("dark", state.theme === "dark");
    root.style.colorScheme = state.theme;
  }

  if (typeof window === "undefined") {
    return;
  }

  if ("__TAURI_INTERNALS__" in window) {
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(state.theme))
      .catch(() => {});
  }

  if (state.hasUserPreference) {
    window.localStorage.setItem(THEME_STORAGE_KEY, state.theme);
  } else {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
  }
}

function setThemeState(next: ThemeState): void {
  const previous = getThemeState();
  if (
    previous.theme === next.theme &&
    previous.hasUserPreference === next.hasUserPreference
  ) {
    applyThemeState(next);
    return;
  }

  currentThemeState = next;
  applyThemeState(next);
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

  const toggleTheme = useCallback(() => {
    const previous = getThemeState();
    setThemeState({
      theme: previous.theme === "dark" ? "light" : "dark",
      hasUserPreference: true,
    });
  }, []);

  const toggleThemeWithTransition = useCallback(
    async (event?: ThemeTransitionEvent) => {
      const canUseViewTransition =
        typeof document !== "undefined" &&
        typeof window !== "undefined" &&
        typeof document.startViewTransition === "function" &&
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      if (!canUseViewTransition) {
        if (typeof document !== "undefined") {
          const root = document.documentElement;
          startThemeSwitching(root);
          flushSync(() => {
            toggleTheme();
          });
          stopThemeSwitchingNextFrame(root);
        } else {
          toggleTheme();
        }
        return;
      }

      const root = document.documentElement;
      startThemeSwitching(root);

      const point = getTransitionPoint(
        event ? { clientX: event.clientX, clientY: event.clientY } : undefined,
      );
      const isDark = root.classList.contains("dark");
      const radius = getMaxRadius(point);
      const start = `circle(0px at ${point.x}px ${point.y}px)`;
      const end = `circle(${radius}px at ${point.x}px ${point.y}px)`;

      const transition = document.startViewTransition(() => {
        flushSync(() => {
          toggleTheme();
        });
      });

      await transition.ready;

      const pseudoElement = isDark
        ? "::view-transition-new(root)"
        : "::view-transition-old(root)";

      const keyframes = isDark
        ? { clipPath: [start, end] }
        : { clipPath: [end, start] };

      root.animate(keyframes, {
        duration: THEME_SWITCH_DURATION_MS,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "both",
        pseudoElement,
      });

      transition.finished.finally(() => {
        stopThemeSwitching(root);
      });
    },
    [toggleTheme],
  );

  return { theme, setTheme, toggleTheme, toggleThemeWithTransition };
}
