import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderCatalogEntry } from "@/lib/tauri-api";
import { ProviderAddDialog } from "./provider-add-dialog";

const mocks = vi.hoisted(() => ({
  getProviderCatalogEntry: vi.fn(),
  importProviderFromCatalog: vi.fn(),
  importProviderRegistry: vi.fn(),
  listProviderCatalog: vi.fn(),
  notifyTextConfigSaved: vi.fn(),
}));

vi.mock("@/lib/settings-api", () => ({
  getProviderCatalogEntry: mocks.getProviderCatalogEntry,
  importProviderFromCatalog: mocks.importProviderFromCatalog,
  importProviderRegistry: mocks.importProviderRegistry,
  listProviderCatalog: mocks.listProviderCatalog,
}));

vi.mock("@/lib/config-update-toast", () => ({
  notifyTextConfigSaved: mocks.notifyTextConfigSaved,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const alphaEntry: ProviderCatalogEntry = {
  providerId: "alpha",
  name: "Alpha Cloud",
  models: [{ id: "alpha-model", name: "Alpha Model", maxContextTokens: 32_000 }],
};

const betaEntry: ProviderCatalogEntry = {
  providerId: "beta",
  name: "Beta Cloud",
  models: [{ id: "beta-model", name: "Beta Model", maxContextTokens: 64_000 }],
};

async function renderCatalog() {
  render(<ProviderAddDialog open onOpenChange={vi.fn()} onImported={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /已知平台/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: /Alpha Cloud/ })).toBeTruthy());
}

describe("ProviderAddDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listProviderCatalog.mockResolvedValue([
      { id: "alpha", name: "Alpha Cloud", modelCount: 1 },
      { id: "beta", name: "Beta Cloud", modelCount: 1 },
    ]);
    mocks.importProviderFromCatalog.mockResolvedValue({ success: true });
    mocks.importProviderRegistry.mockResolvedValue({ success: true });
  });

  it("ignores an older provider response that resolves after the latest selection", async () => {
    const alpha = deferred<ProviderCatalogEntry>();
    const beta = deferred<ProviderCatalogEntry>();
    mocks.getProviderCatalogEntry.mockImplementation((providerId: string) =>
      providerId === "alpha" ? alpha.promise : beta.promise,
    );
    await renderCatalog();

    fireEvent.click(screen.getByRole("button", { name: /Alpha Cloud/ }));
    fireEvent.click(screen.getByRole("button", { name: /Beta Cloud/ }));
    await act(async () => beta.resolve(betaEntry));
    expect(screen.getByText("Beta Model（64000）")).toBeTruthy();

    await act(async () => alpha.resolve(alphaEntry));
    expect(screen.queryByText("Alpha Model（32000）")).toBeNull();
    expect(screen.getByText("Beta Model（64000）")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("平台 API Key"), { target: { value: "beta-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "导入平台" }));
    await waitFor(() => {
      expect(mocks.importProviderFromCatalog).toHaveBeenCalledWith({
        providerId: "beta",
        apiKey: "beta-secret",
        defaultModel: "beta-model",
        baseUrl: undefined,
      });
    });
  });

  it("clears provider-specific credentials when the selection changes", async () => {
    mocks.getProviderCatalogEntry.mockImplementation((providerId: string) =>
      Promise.resolve(providerId === "alpha" ? alphaEntry : betaEntry),
    );
    await renderCatalog();

    fireEvent.click(screen.getByRole("button", { name: /Alpha Cloud/ }));
    await screen.findByText("Alpha Model（32000）");
    fireEvent.change(screen.getByLabelText("平台 API Key"), { target: { value: "alpha-secret" } });
    fireEvent.change(screen.getByLabelText("目录 Base URL"), {
      target: { value: "https://alpha.example/v1" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Beta Cloud/ }));
    await screen.findByText("Beta Model（64000）");
    expect((screen.getByLabelText("平台 API Key") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("目录 Base URL") as HTMLInputElement).value).toBe("");
  });
});
