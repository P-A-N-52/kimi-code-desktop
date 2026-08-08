import { describe, expect, it } from "vitest";
import {
  classifySlashDispatch,
  filterDesktopSlashCommands,
  formatDesktopHelpReport,
  mergeSlashCommands,
  shouldExecuteSlashCommandImmediately,
} from "./slash-command-catalog";

describe("slash-command-catalog", () => {
  it("filters desktop UI and TUI-only commands including swarm", () => {
    const filtered = filterDesktopSlashCommands([
      { name: "help", description: "Show help", aliases: ["h"] },
      { name: "swarm", description: "Toggle swarm", aliases: [] },
      { name: "plan", description: "Toggle plan", aliases: [] },
      { name: "model", description: "Switch model", aliases: [] },
      { name: "provider", description: "Manage providers", aliases: [] },
      { name: "compact", description: "Compact", aliases: [], inputHint: "hint" },
      { name: "goal", description: "Create a goal", aliases: [] },
      { name: "plugins", description: "Plugins", aliases: [] },
      { name: "exit", description: "Exit", aliases: ["q"] },
      { name: "yolo", description: "YOLO", aliases: [] },
      {
        name: "skill:demo",
        description: "Demo skill",
        aliases: [],
      },
    ]);

    expect(filtered.map((command) => command.name)).toEqual([
      "help",
      "compact",
      "goal",
      "skill:demo",
    ]);
    expect(filtered.find((c) => c.name === "help")?.description).toContain("desktop");
    expect(filtered.find((c) => c.name === "goal")?.description).toContain("goal");
  });

  it("overrides usage/status descriptions for quota clarity", () => {
    const filtered = filterDesktopSlashCommands([
      { name: "usage", description: "Show session token usage", aliases: [] },
      { name: "status", description: "Show current session status", aliases: [] },
    ]);
    expect(filtered[0]?.description).toContain("5h");
    expect(filtered[1]?.description).toContain("quotas");
  });

  it("sends info/toggle commands immediately and keeps arg-friendly ones editable", () => {
    expect(
      shouldExecuteSlashCommandImmediately({
        name: "help",
        description: "",
        aliases: [],
      }),
    ).toBe(true);
    expect(
      shouldExecuteSlashCommandImmediately({
        name: "compact",
        description: "",
        aliases: [],
      }),
    ).toBe(false);
    expect(
      shouldExecuteSlashCommandImmediately({
        name: "compact",
        description: "",
        aliases: [],
        inputHint: "keep APIs",
      }),
    ).toBe(false);
    expect(
      shouldExecuteSlashCommandImmediately({
        name: "skill:demo",
        description: "",
        aliases: [],
      }),
    ).toBe(false);
    expect(
      shouldExecuteSlashCommandImmediately({
        name: "goal",
        description: "",
        aliases: [],
      }),
    ).toBe(false);
  });

  it("classifies local usage/status/help and blocks unknown or denied commands", () => {
    const advertised = [
      { name: "compact", description: "", aliases: [] },
      { name: "mcp", description: "", aliases: [] },
    ];
    expect(classifySlashDispatch("/usage", advertised)).toEqual({
      kind: "local",
      name: "usage",
      args: "",
    });
    expect(classifySlashDispatch("/status", advertised)).toEqual({
      kind: "local",
      name: "status",
      args: "",
    });
    expect(classifySlashDispatch("/h", advertised)).toEqual({
      kind: "local",
      name: "help",
      args: "",
    });
    expect(classifySlashDispatch("/swarm on", advertised)).toEqual({
      kind: "local",
      name: "swarm",
      args: "on",
    });
    expect(classifySlashDispatch("/compact keep APIs", advertised)).toEqual({
      kind: "passthrough",
    });
    expect(classifySlashDispatch("/mcp", [])).toEqual({
      kind: "passthrough",
    });
    expect(classifySlashDispatch("/tasks", []).kind).toBe("blocked");
    expect(
      classifySlashDispatch("/tasks", [{ name: "tasks", description: "", aliases: [] }]),
    ).toEqual({ kind: "passthrough" });
    expect(classifySlashDispatch("/goal soak the GUI", [])).toEqual({
      kind: "local",
      name: "goal",
      args: "soak the GUI",
    });
    expect(classifySlashDispatch("/yolo", advertised).kind).toBe("blocked");
    expect(classifySlashDispatch("/version", advertised).kind).toBe("blocked");
    expect(classifySlashDispatch("/provider", advertised)).toEqual({
      kind: "blocked",
      message: expect.stringContaining("model configuration UI"),
    });
    expect(classifySlashDispatch("/copy", advertised)).toEqual({
      kind: "blocked",
      message: expect.stringContaining("title menu"),
    });
    expect(classifySlashDispatch("/export-md", advertised)).toEqual({
      kind: "blocked",
      message: expect.stringContaining("Export Markdown"),
    });
    expect(classifySlashDispatch("/undo", advertised)).toEqual({
      kind: "blocked",
      message: expect.stringContaining("CLI TUI"),
    });
    expect(classifySlashDispatch("/fork", advertised)).toEqual({
      kind: "blocked",
      message: expect.stringMatching(/desktop runtime.*session\/fork|session\/fork.*desktop runtime/i),
    });
    const forkBlocked = classifySlashDispatch("/fork", advertised);
    expect(forkBlocked.kind).toBe("blocked");
    if (forkBlocked.kind === "blocked") {
      expect(forkBlocked.message).not.toMatch(/sidebar/i);
      expect(forkBlocked.message).toMatch(/CLI TUI/i);
    }
    expect(classifySlashDispatch("hello", advertised)).toEqual({
      kind: "passthrough",
    });
  });

  it("formats desktop help including runtime extras", () => {
    const help = formatDesktopHelpReport([
      { name: "compact", description: "Compact context", aliases: [], inputHint: "hint" },
    ]);
    expect(help).toContain("/usage");
    expect(help).toContain("/compact hint");
  });

  it("forwards runtime-advertised skill commands like custom-theme", () => {
    const advertised = [{ name: "custom-theme", description: "Create a theme", aliases: [] }];
    expect(classifySlashDispatch("/custom-theme", advertised)).toEqual({
      kind: "passthrough",
    });
  });

  it("merges command sources with earlier entries winning", () => {
    const acp = [
      { name: "skill:demo", description: "ACP description", aliases: [] },
      { name: "compact", description: "Compact", aliases: [] },
    ];
    const disk = [
      { name: "skill:demo", description: "Disk description", aliases: [] },
      { name: "skill:extra", description: "Only on disk", aliases: [] },
      { name: "swarm", description: "Denied locally", aliases: [] },
    ];
    const merged = mergeSlashCommands(acp, disk);
    expect(merged.map((command) => command.name)).toEqual(["skill:demo", "compact", "skill:extra"]);
    expect(merged[0]?.description).toBe("ACP description");
  });
});
