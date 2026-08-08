import { KimiRuntimeAdapter } from './kimi-runtime-adapter';
import { runStdioRuntime } from './stdio';

// Stdout is the runtime-v1 protocol channel. The engine and its dependencies
// may write stray `console.*` output; redirect it to stderr so the protocol
// stream can never be corrupted (same guard as acp-server's start.ts).
function redirectConsoleToStderr(): void {
  const sink = (...args: unknown[]): void => {
    process.stderr.write(`${args.map(String).join(' ')}\n`);
  };
  globalThis.console.log = sink;
  globalThis.console.info = sink;
  globalThis.console.warn = sink;
  globalThis.console.debug = sink;
}

redirectConsoleToStderr();

process.exitCode = await runStdioRuntime({
  input: process.stdin,
  output: process.stdout,
  diagnostics: process.stderr,
  adapter: new KimiRuntimeAdapter(),
});
