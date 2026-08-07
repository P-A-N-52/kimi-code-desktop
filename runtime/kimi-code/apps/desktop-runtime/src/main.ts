import { KimiRuntimeAdapter } from './kimi-runtime-adapter';
import { runStdioRuntime } from './stdio';

process.exitCode = await runStdioRuntime({
  input: process.stdin,
  output: process.stdout,
  diagnostics: process.stderr,
  adapter: new KimiRuntimeAdapter(),
});
