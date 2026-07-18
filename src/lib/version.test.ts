import { beforeEach, describe, expect, it, vi } from "vitest";

const getKimiCliVersionMock = vi.hoisted(() => vi.fn<() => Promise<string>>());

vi.mock("@/lib/tauri-api", () => ({
  getKimiCliVersion: getKimiCliVersionMock,
}));

async function loadVersionModule() {
  return import("./version");
}

describe("version", () => {
  beforeEach(() => {
    vi.resetModules();
    getKimiCliVersionMock.mockReset();
    getKimiCliVersionMock.mockResolvedValue("1.2.3");
  });

  describe("desktopVersion", () => {
    it("should be defined", async () => {
      const { desktopVersion } = await loadVersionModule();
      expect(desktopVersion).toBeDefined();
    });
  });

  describe("kimiCodeCliFallbackVersion", () => {
    it("should be defined", async () => {
      const { kimiCodeCliFallbackVersion } = await loadVersionModule();
      expect(kimiCodeCliFallbackVersion).toBeDefined();
    });
  });

  describe("resolveKimiCliVersion", () => {
    it("returns the runtime CLI version", async () => {
      const { resolveKimiCliVersion } = await loadVersionModule();
      const result = await resolveKimiCliVersion();
      expect(result).toBe("1.2.3");
      expect(getKimiCliVersionMock).toHaveBeenCalledTimes(1);
    });

    it("caches result across multiple calls", async () => {
      const { resolveKimiCliVersion } = await loadVersionModule();
      const first = await resolveKimiCliVersion();
      const second = await resolveKimiCliVersion();
      expect(first).toBe(second);
      expect(getKimiCliVersionMock).toHaveBeenCalledTimes(1);
    });

    it("falls back to build-time version when runtime probing fails", async () => {
      getKimiCliVersionMock.mockRejectedValue(new Error("Not in Tauri"));
      const { kimiCodeCliFallbackVersion, resolveKimiCliVersion } = await loadVersionModule();
      await expect(resolveKimiCliVersion()).resolves.toBe(kimiCodeCliFallbackVersion);
    });
  });
});
