import { describe, expect, it } from "vitest";
import { parseSwarmResult } from "./parseSwarmResult";

const SAMPLE = `
<agent_swarm_result>
<summary>completed: 2, failed: 1, aborted: 1</summary>
<subagent outcome="completed" item="Auth review" agent_id="a1" mode="coder">Looks good</subagent>
<subagent outcome="failed" item="Payments" agent_id="a2">Timeout</subagent>
<subagent outcome="aborted" item="Docs" state="not_started">Never started</subagent>
<subagent outcome="completed" item="Nested">Outer
<subagent outcome="completed" item="inner">should stay nested</subagent>
still outer</subagent>
<resume_hint>retry aborted items</resume_hint>
</agent_swarm_result>
`.trim();

describe("parseSwarmResult", () => {
  it("returns null for missing or unstructured output", () => {
    expect(parseSwarmResult(undefined)).toBeNull();
    expect(parseSwarmResult("plain text")).toBeNull();
    expect(parseSwarmResult([])).toBeNull();
  });

  it("parses summary counts, subagents, and resume hint", () => {
    const result = parseSwarmResult(SAMPLE);
    expect(result).toMatchObject({
      completed: 2,
      failed: 1,
      aborted: 1,
      total: 4,
      resumeHint: "retry aborted items",
    });
    expect(result?.subagents).toHaveLength(4);
    expect(result?.subagents[0]).toMatchObject({
      outcome: "completed",
      item: "Auth review",
      agentId: "a1",
      mode: "coder",
      body: "Looks good",
    });
    expect(result?.subagents[2]).toMatchObject({
      outcome: "aborted",
      item: "Docs",
      state: "not_started",
      body: "Never started",
    });
  });

  it("keeps nested subagent tags inside a body as one top-level row", () => {
    const nested = parseSwarmResult(SAMPLE)?.subagents[3];
    expect(nested?.item).toBe("Nested");
    expect(nested?.body).toContain('<subagent outcome="completed" item="inner">');
    expect(nested?.body).toContain("still outer");
  });

  it("unescapes attribute entities and accepts string[] output", () => {
    const result = parseSwarmResult([
      "<agent_swarm_result>",
      '<summary>completed: 1</summary>',
      '<subagent outcome="completed" item="A &amp; B" agent_id="x">ok</subagent>',
      "</agent_swarm_result>",
    ]);
    expect(result?.subagents[0]?.item).toBe("A & B");
    expect(result?.total).toBe(1);
  });
});
