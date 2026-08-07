import { createKimiHarnessV2, type KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { DESKTOP_RUNTIME_VERSION } from './protocol';

export interface KimiRuntimeStartOptions {
  readonly homeDir: string;
}

export interface RuntimeLifecycleAdapter {
  readonly isStarted: boolean;
  start(options: KimiRuntimeStartOptions): Promise<void>;
  close(): Promise<void>;
}

/**
 * The only source-runtime module allowed to import the Kimi SDK. M0 constructs
 * this adapter but deliberately does not start its harness during handshake.
 */
export class KimiRuntimeAdapter implements RuntimeLifecycleAdapter {
  private harness: KimiHarness | undefined;

  get isStarted(): boolean {
    return this.harness !== undefined;
  }

  async start(options: KimiRuntimeStartOptions): Promise<void> {
    if (this.harness !== undefined) return;
    this.harness = createKimiHarnessV2({
      homeDir: options.homeDir,
      identity: {
        productName: 'kimi-code-desktop-runtime',
        version: DESKTOP_RUNTIME_VERSION,
        platform: 'kimi_code_desktop',
      },
      uiMode: 'desktop',
    });
  }

  async close(): Promise<void> {
    const harness = this.harness;
    this.harness = undefined;
    await harness?.close();
  }
}
