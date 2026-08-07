/**
 * Engine composition root for the desktop runtime process.
 *
 * Mirrors the acp-server composition root (`packages/acp-server/src/start.ts`):
 * `bootstrap()` builds the App `Scope` (seeding file-backed storage rooted at
 * `homeDir`), and a `@moonshot-ai/klient` facade over the in-memory transport
 * is created on top of it. The klient does NOT own the scope — lifecycle
 * stays here. Close order: `klient.close()` (detach event subscriptions)
 * → best-effort append-log flush → `app.dispose()`. Live sessions are closed
 * before this runs — that step is owned by the adapter, which tracks them.
 */

import {
  IAppendLogStore,
  bootstrap,
  ensureKimiHome,
  logSeed,
  resolveConfigPath,
  resolveKimiHome,
  resolveLoggingConfig,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { createKimiDefaultHeaders, type KimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';
import type { Klient } from '@moonshot-ai/klient';
import { createKlient } from '@moonshot-ai/klient/memory';

import { DESKTOP_RUNTIME_VERSION } from './protocol';

/**
 * `packages/oauth` applies no literal allow-list to `KimiHostIdentity.platform`
 * — it validates only a non-empty ASCII header value, and its docs state every
 * host must name its own platform explicitly (`KIMI_CODE_PLATFORM` is the
 * CLI's value, `kimi_code_desktop` is the docs' own example of a distinct
 * host). The desktop runtime therefore reports its own platform instead of
 * inheriting the CLI's `kimi_code_cli` the way acp-server does; this value
 * reaches managed endpoints as `X-Msh-Platform`.
 */
export const DESKTOP_RUNTIME_PLATFORM = 'kimi_code_desktop';

export interface EngineContextOptions {
  readonly homeDir?: string;
  readonly configPath?: string;
}

export interface EngineContext {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity: KimiHostIdentity;
  readonly app: Scope;
  readonly klient: Klient;
  close(): Promise<void>;
}

export function createEngineContext(options: EngineContextOptions = {}): EngineContext {
  const homeDir = resolveKimiHome(options.homeDir);
  const configPath = resolveConfigPath({ homeDir, configPath: options.configPath });
  ensureKimiHome(homeDir);
  const identity: KimiHostIdentity = {
    productName: 'kimi-code-desktop-runtime',
    version: DESKTOP_RUNTIME_VERSION,
    platform: DESKTOP_RUNTIME_PLATFORM,
  };
  const { app } = bootstrap(
    {
      homeDir,
      configPath,
      clientIdentity: identity,
      args: {
        // Host identity headers for the engine's outbound requests (model,
        // WebSearch, registry refresh) — the same factory the node-sdk
        // harness passes through (`sdk-rpc-client-v2.ts`).
        requestHeaders: createKimiDefaultHeaders({ homeDir, ...identity }),
      },
    },
    // `logSeed` is a hard prerequisite: the Session-scoped log writer reads
    // `ILogOptions`, so session materialization fails without it.
    [...logSeed(resolveLoggingConfig({ homeDir, env: process.env }))],
  );
  const klient = createKlient({ scope: app });

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      // Detach the klient's event subscriptions first so disposal below
      // cannot deliver into a torn-down scope.
      await klient.close();
      // Flush the append-log write-behind before disposing, so a clean
      // shutdown never races a pending drain against teardown. Best-effort:
      // a flush failure must not block disposal.
      try {
        await app.accessor.get(IAppendLogStore).flush();
      } catch {
        // ignore — disposal proceeds regardless
      }
      app.dispose();
    })();
    return closePromise;
  };

  return { homeDir, configPath, identity, app, klient, close };
}
