import { describe, expect, it } from "vitest";
import { getToolPresentation, isTodoTool, isWriteTool } from "./tool-registry";

describe("tool registry", () => {
  it.each([
    ["Read", "ReadFile", "Read"],
    ["Write", "WriteFile", "Write"],
    ["Edit", "StrReplaceFile", "Edit"],
    ["Bash", "Shell", "Shell"],
    ["WebSearch", "SearchWeb", "Web Search"],
    ["TodoList", "SetTodoList", "Todo List"],
  ])("normalizes %s", (rawName, canonicalName, displayName) => {
    expect(getToolPresentation(rawName)).toMatchObject({
      canonicalName,
      displayName,
    });
  });

  it("keeps unknown MCP tools usable through the generic fallback", () => {
    expect(getToolPresentation("mcp__custom__action")).toEqual({
      canonicalName: "mcp__custom__action",
      displayName: "mcp__custom__action",
      category: "generic",
    });
  });

  it("recognizes current write and todo names", () => {
    expect(isWriteTool("Write")).toBe(true);
    expect(isTodoTool("TodoList")).toBe(true);
  });
});
