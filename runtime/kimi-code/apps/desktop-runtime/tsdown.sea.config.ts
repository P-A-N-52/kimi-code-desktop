import { resolve } from 'node:path';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

// M5 SEA build config. Produces a single self-contained CommonJS bundle of
// the TLA-free `main-sea` entry:
//
// - `format: ['cjs']` — Node's SEA loader always executes the embedded main
//   as CommonJS, so the bundle itself must be CJS (the dev `format: ['esm']`
//   build cannot be embedded).
// - `inlineDynamicImports: true` — SEA can only embed one file, so every
//   internal chunk (including the inlined `@jsquash/webp` decoder glue and
//   the wasm base64 constant) is folded into `sea-main.cjs`.
// - No `banner` — the dev banner's ESM `__filename`/`__dirname` shims are
//   unnecessary (CJS has them natively) and their `import.meta.url` would be
//   invalid in CJS.
// - `deps` mirrors tsdown.config.ts with two additions. `zod` and
//   `@jsquash/webp` are declared `dependencies`, so tsdown externalizes them
//   for the dev build — but a SEA has no node_modules, and both are pure JS
//   (zod schemas; the webp decoder glue — the wasm itself is the vendored
//   base64 chunk that is already inlined), so they are force-bundled here.
//   `node-pty` stays external: its native `.node` binding cannot be embedded
//   and the only reference is the lazy terminal-tool import, which is out of
//   scope for the M5 SEA (documented limitation, fails at trigger time).
//
// Run from the package directory (build:sea does), via
// `tsdown --config tsdown.sea.config.ts`. Anchored on this file's own
// location so the config is cwd-independent.

const here = import.meta.dirname;

export default defineConfig({
  entry: {
    'sea-main': resolve(here, 'src/main-sea.ts'),
  },
  format: ['cjs'],
  dts: false,
  outDir: resolve(here, 'dist-sea'),
  clean: true,
  hash: false,
  plugins: [rawTextPlugin()],
  deps: {
    alwaysBundle: [/^@moonshot-ai\//, /^zod/, /^@jsquash\//],
    neverBundle: [],
  },
  outputOptions: {
    entryFileNames: 'sea-main.cjs',
    inlineDynamicImports: true,
  },
});
