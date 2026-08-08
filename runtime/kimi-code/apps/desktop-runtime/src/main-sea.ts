import { KimiRuntimeAdapter } from './kimi-runtime-adapter';
import { runStdioRuntime } from './stdio';

// SEA entry for the M5 single-executable build (`build:sea`). Node's SEA
// loader always executes the embedded main as CommonJS, where top-level await
// is unavailable, so the stdio runtime is started as a promise chain instead
// of the `await` form used by the dev entry (`main.ts`). Behaviour is
// otherwise identical: the exit code is assigned when the runtime settles and
// failures surface on stderr.
//
// The console redirect is duplicated from `main.ts` on purpose — importing it
// would drag that module's top-level await into this bundle.

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

runStdioRuntime({
  input: process.stdin,
  output: process.stdout,
  diagnostics: process.stderr,
  adapter: new KimiRuntimeAdapter(),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`desktop runtime failed: ${String(error)}\n`);
    process.exitCode = 1;
  },
);
