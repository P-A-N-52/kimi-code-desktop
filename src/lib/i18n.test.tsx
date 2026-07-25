import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  UI_LANGUAGE_STORAGE_KEY,
  translateUiString,
  UiLanguageProvider,
  useDomTranslations,
  useI18n,
} from "./i18n";

function LanguageHarness() {
  useDomTranslations();
  const { resolvedLanguage, setUiLanguage, uiLanguage } = useI18n();

  return (
    <div>
      <output data-testid="language-state">
        {uiLanguage}:{resolvedLanguage}
      </output>
      <button type="button" onClick={() => setUiLanguage("system")}>
        to system
      </button>
      <button type="button" onClick={() => setUiLanguage("zh-CN")}>
        to zh
      </button>
      <button type="button" onClick={() => setUiLanguage("en-US")}>
        to en
      </button>
      <button type="button" aria-label="Open settings">
        Settings
      </button>
    </div>
  );
}

describe("DOM translations", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("translates both English source text and existing Chinese source text", () => {
    expect(translateUiString("Open settings", "zh-CN")).toBe("打开设置");
    expect(translateUiString("打开设置", "en-US")).toBe("Open settings");
  });

  it("restores translated text and attributes when switching back to English", async () => {
    const user = userEvent.setup();
    render(
      <UiLanguageProvider>
        <LanguageHarness />
      </UiLanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "to zh" }));

    const translatedSettings = translateUiString("Settings", "zh-CN");
    const translatedOpenSettings = translateUiString("Open settings", "zh-CN");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: translatedOpenSettings }).textContent).toBe(
        translatedSettings,
      );
    });

    await user.click(screen.getByRole("button", { name: "to en" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Open settings" }).textContent).toBe("Settings");
    });
  });

  it("persists explicit language choices and clears them for system mode", async () => {
    const user = userEvent.setup();
    render(
      <UiLanguageProvider>
        <LanguageHarness />
      </UiLanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "to zh" }));
    await waitFor(() => {
      expect(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe("zh-CN");
      expect(screen.getByTestId("language-state").textContent).toBe("zh-CN:zh-CN");
      expect(document.documentElement.lang).toBe("zh-CN");
    });

    await user.click(screen.getByRole("button", { name: "to system" }));
    await waitFor(() => {
      expect(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBeNull();
      expect(document.documentElement.lang).toBe("en-US");
    });
  });
});
