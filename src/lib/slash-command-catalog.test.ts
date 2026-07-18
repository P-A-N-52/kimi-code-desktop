import { describe, expect, it } from "vitest";
import {
  filterDesktopSlashCommands,
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
        name: "yolo",
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
});
