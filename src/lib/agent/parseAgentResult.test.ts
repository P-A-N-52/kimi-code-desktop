import { describe, expect, it } from "vitest";
import { parseAgentInput, parseAgentResult } from "./parseAgentResult";

describe("parseAgentResult", () => {
  it("parses CLI key:value + [summary] blocks from the screenshot format", () => {
    const output = [
      "agent_id: agent-0",
      "actual_subagent_type: explore",
      "status: completed",
      "[summary]",
      "测试完成，结果如下：",
      "- 项目根目录下共有 34 个目录",
      "- 以字母 'k' 开头的隐藏文件/目录：.kimi、.kimi-code",
    ].join("\n");

    expect(parseAgentResult(output)).toEqual({
      agentId: "agent-0",
      subagentType: "explore",
      status: "completed",
      summary:
        "测试完成，结果如下：\n- 项目根目录下共有 34 个目录\n- 以字母 'k' 开头的隐藏文件/目录：.kimi、.kimi-code",
      structured: true,
      raw: output,
    });
  });

  it("accepts string arrays and alternate key spellings", () => {
    expect(
      parseAgentResult(["agentId: a1", "subagent_type: coder", "status: failed", "[summary]", "boom"]),
    ).toMatchObject({
      agentId: "a1",
      subagentType: "coder",
      status: "failed",
      summary: "boom",
      structured: true,
    });
  });

  it("parses JSON payloads", () => {
    expect(
      parseAgentResult(
        JSON.stringify({
          agent_id: "agent-2",
          actual_subagent_type: "plan",
          status: "completed",
          summary: "Done",
        }),
      ),
    ).toMatchObject({
      agentId: "agent-2",
      subagentType: "plan",
      status: "completed",
      summary: "Done",
      structured: true,
    });
  });

  it("returns unstructured raw for plain text", () => {
    expect(parseAgentResult("just some notes")).toEqual({
      structured: false,
      raw: "just some notes",
    });
  });

  it("treats a bare [summary] block as structured", () => {
    expect(parseAgentResult("[summary]\nhello")).toMatchObject({
      structured: true,
      summary: "hello",
    });
  });

  it("handles empty output", () => {
    expect(parseAgentResult(null)).toEqual({ structured: false, raw: "" });
    expect(parseAgentResult(undefined)).toEqual({ structured: false, raw: "" });
  });
});

describe("parseAgentInput", () => {
  it("reads description, subagent_type, and prompt", () => {
    expect(
      parseAgentInput({
        description: "测试子代理功能",
        subagent_type: "explore",
        prompt: "List dirs",
      }),
    ).toEqual({
      description: "测试子代理功能",
      subagentType: "explore",
      prompt: "List dirs",
    });
  });
});
