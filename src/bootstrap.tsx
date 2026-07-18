import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./app/app.tsx";
import { ErrorBoundary } from "./ui/error-boundary";
import { UiLanguageProvider } from "./lib/i18n";

const DYNAMIC_IMPORT_ERROR_PATTERNS: string[] = [
  "Failed to fetch dynamically imported module",
  "Importing a module script failed",
  "Failed to load module script",
  "ChunkLoadError",
];

const isDynamicImportFailure = (error: Error): boolean =>
  DYNAMIC_IMPORT_ERROR_PATTERNS.some((pattern) =>
    error.message.includes(pattern),
  );

const DYNAMIC_IMPORT_RELOAD_KEY = "kimi:dynamic-import-reload";

const shouldReloadAfterDynamicImportFailure = (): boolean =>
  sessionStorage.getItem(DYNAMIC_IMPORT_RELOAD_KEY) !== "1";

const markDynamicImportReloaded = (): void => {
  sessionStorage.setItem(DYNAMIC_IMPORT_RELOAD_KEY, "1");
};

const setupDynamicImportRecovery = (): void => {
  window.addEventListener("vite:preloadError", () => {
    if (shouldReloadAfterDynamicImportFailure()) {
      markDynamicImportReloaded();
      window.location.reload();
    }
  });

  window.addEventListener(
    "unhandledrejection",
    (event: PromiseRejectionEvent) => {
      const { reason } = event;
      if (reason instanceof Error && isDynamicImportFailure(reason)) {
        event.preventDefault();
        if (shouldReloadAfterDynamicImportFailure()) {
          markDynamicImportReloaded();
          window.location.reload();
        }
      }
    },
  );
};

setupDynamicImportRecovery();

const rootElement = document.getElementById("root")!;

const renderApp = () => {
  createRoot(rootElement).render(
    <StrictMode>
      <ErrorBoundary>
        <UiLanguageProvider>
          <App />
        </UiLanguageProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
};

(window as unknown as Record<string, unknown>).__KIMI_BACKEND_URL__ = "";
renderApp();
