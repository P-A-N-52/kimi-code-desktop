import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const home = process.env.USERPROFILE || process.env.HOME;
if (!home) {
  throw new Error("Unable to resolve USERPROFILE/HOME for ~/.kimi-code/mcp.json");
}

const kimiDir = join(home, ".kimi-code");
const mcpPath = join(kimiDir, "mcp.json");
const originalMcp = existsSync(mcpPath) ? readFileSync(mcpPath, "utf8") : null;
const tempDir = mkdtempSync(join(tmpdir(), "kimi-mcp-smoke-"));
const serverPath = join(tempDir, "server.mjs");

const serverSource = String.raw`
import { createInterface } from "node:readline";

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function handle(message) {
  if (!message || typeof message !== "object" || !message.method) {
    return;
  }
  if (message.method.startsWith("notifications/")) {
    return;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "codex-mcp-smoke", version: "0.1.0" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "codex_mcp_smoke_echo",
            description: "Echoes a smoke-test token.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    const text = String(message.params?.arguments?.text ?? "missing");
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: "mcp-smoke-ok:" + text }] },
    });
    return;
  }
  if (message.method === "ping") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: "Method not found" },
  });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  handle(JSON.parse(line));
});
`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
    timeout: options.timeout ?? 120_000,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.error.message}\n${output}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}\n${output}`);
  }
  return output;
}

try {
  mkdirSync(dirname(mcpPath), { recursive: true });
  writeFileSync(serverPath, serverSource, "utf8");
  writeFileSync(
    mcpPath,
    `${JSON.stringify(
      {
        mcpServers: {
          codex_mcp_smoke: {
            command: process.execPath,
            args: [serverPath],
            transport: "stdio",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const listOutput = run("kimi", ["mcp", "test", "codex_mcp_smoke"], {
    timeout: 60_000,
  });
  if (!listOutput.includes("codex_mcp_smoke_echo")) {
    throw new Error(`MCP tool was not discovered.\n${listOutput}`);
  }

  const callOutput = run(
    "kimi",
    [
      "--quiet",
      "--mcp-config-file",
      mcpPath,
      "--max-steps-per-turn",
      "6",
      "-p",
      "Use the codex_mcp_smoke_echo MCP tool with text release-check. Reply only with the exact tool result.",
    ],
    { timeout: 180_000 },
  );
  if (!callOutput.includes("mcp-smoke-ok:release-check")) {
    throw new Error(`MCP tool call did not return the smoke token.\n${callOutput}`);
  }

  console.log("MCP smoke passed: discovered and called codex_mcp_smoke_echo.");
} finally {
  if (originalMcp === null) {
    rmSync(mcpPath, { force: true });
  } else {
    writeFileSync(mcpPath, originalMcp, "utf8");
  }
  rmSync(tempDir, { recursive: true, force: true });
}
