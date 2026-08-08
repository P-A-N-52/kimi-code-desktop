import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  entry: {
    index: './src/index.ts',
    main: './src/main.ts',
  },
  format: ['esm'],
  // d.ts bundling is off: this is a private process bundle with no TypeScript
  // consumers, and rolldown-dts cannot inline the type-only barrel re-exports
  // (`export type { X }`) of force-bundled @moonshot-ai deps — it fails with
  // MISSING_EXPORT / emits broken alias artifacts.
  dts: false,
  outDir: 'dist',
  clean: true,
  hash: false,
  plugins: [rawTextPlugin()],
  banner: {
    js: [
      "import { fileURLToPath as __cjsShimFileURLToPath } from 'node:url';",
      "import { dirname as __cjsShimDirname } from 'node:path';",
      'const __filename = __cjsShimFileURLToPath(import.meta.url);',
      'const __dirname = __cjsShimDirname(__filename);',
    ].join('\n'),
  },
  deps: {
    // Workspace sources are always bundled. Third-party packages in the
    // dependency closure must instead stay declared in package.json so
    // tsdown externalizes them: node-pty ships a native .node binding and
    // @jsquash/webp ships .wasm — inlining either crashes at runtime.
    alwaysBundle: [/^@moonshot-ai\//],
    neverBundle: [],
  },
  outputOptions: {
    entryFileNames: '[name].mjs',
  },
});
