import { describe, expect, it } from "vitest";
import {
  classifySlashDispatch,
  filterDesktopSlashCommands,
  formatDesktopHelpReport,
  shouldExecuteSlashCommandImmediately,
} from "./slash-command-catalog";

describe("slash-command-catalog", () => {
  it("filters desktop UI and TUI-only commands including swarm", () => {
    const filtered = filterDesktopSlashCommands([
      { name: "help", description: "Show help", aliases: ["h"] },
      { name: "swarm", description: "Toggle swarm", aliases: [] },
      { name: "plan", description: "Toggle plan", aliases: [] },
      { name: "model", description: "Switch model", aliases: [] },
      { name: "compact", description: "Compact", aliases: [], inputHint: "hint" },
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
      "skill:demo",
    ]);
    expect(filtered.find((c) => c.name === "help")?.description).toContain(
      "desktop",
    );
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
    expect(classifySlashDispatch("/tasks", [])).toEqual({
      kind: "passthrough",
    });
    expect(classifySlashDispatch("/yolo", advertised).kind).toBe("blocked");
    expect(classifySlashDispatch("/version", advertised).kind).toBe("blocked");
    expect(classifySlashDispatch("hello", advertised)).toEqual({
      kind: "passthrough",
    });
  });

  it("formats desktop help including ACP extras", () => {
    const help = formatDesktopHelpReport([
      { name: "compact", description: "Compact context", aliases: [], inputHint: "hint" },
    ]);
    expect(help).toContain("/usage");
    expect(help).toContain("/compact hint");
  });
});
