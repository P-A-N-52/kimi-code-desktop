# Kimi Code upstream

`runtime/kimi-code` is a source-owned subtree of the official Kimi Code repository. It is not a submodule and is not a downloaded release archive.

## Frozen baseline

| Field | Value |
| --- | --- |
| Repository | `https://github.com/MoonshotAI/kimi-code.git` |
| Tag | `@moonshot-ai/kimi-code@0.33.0` |
| Commit | `53c832dfdf9566afd59a8b3d54ebd36d3cb03d72` |
| Imported by | Git subtree, full history, no squash |
| Node | `24.15.0` |
| pnpm | `10.33.0` |

The import commit records:

```text
git-subtree-dir: runtime/kimi-code
git-subtree-split: 53c832dfdf9566afd59a8b3d54ebd36d3cb03d72
```

Verify the current import with:

```sh
git log -1 --format=fuller -- runtime/kimi-code
git rev-parse <subtree-merge-commit>^2
```

The second parent of the initial subtree merge must be the frozen commit above.

## Local ownership

Desktop-specific runtime code lives inside the upstream workspace at:

```text
runtime/kimi-code/apps/desktop-runtime
```

Keep all direct Kimi SDK/internal calls behind that app's adapter. The outer React/Tauri project must depend on the versioned `runtime-v1` protocol, not on Kimi TypeScript types.

The outer Desktop repository remains npm-based. The nested Kimi workspace keeps its own `pnpm-lock.yaml`; do not merge or regenerate it with npm.

## SEA sidecar build (M5)

The release runtime is a Node **Single Executable Application** sidecar, built by:

```sh
pnpm --dir runtime/kimi-code --filter @moonshot-ai/desktop-runtime run build:sea
```

The artifact lands at `src-tauri/binaries/desktop-runtime-<target-triple>` (gitignored, Tauri `externalBin`). Pipeline: `tsdown` single-file CJS bundle (`tsdown.sea.config.ts`, TLA-free `src/main-sea.ts` entry) → `node --experimental-sea-config` blob → copy the SEA-capable Node binary → `codesign --remove-signature` → `postject` injection → ad-hoc `codesign --sign -`.

Notes:

- **SEA Node**: Node's SEA build is disabled in some distributions (Homebrew's node rejects both `--experimental-sea-config` and `--build-sea`). `build:sea` probes the running `node`, then falls back to the pinned official Node `24.15.0` (matching `.nvmrc`), downloaded into `apps/desktop-runtime/.sea-node/`. `SEA_NODE` overrides explicitly.
- **macOS segment name**: postject must inject with `--macho-segment-name NODE_SEA` — Node ≥ 22 looks the blob up in segment `NODE_SEA` (section `__NODE_SEA_BLOB`); the older `NODE_SEA_BLOB` segment name makes the binary segfault at startup (null blob).
- **Self-report**: `runtime.getInfo` must report `kimiSource.commit` `53c832dfdf9566afd59a8b3d54ebd36d3cb03d72`; `build:sea` and the package smoke both gate it.
- **Native boundaries**: `node-pty` (native `.node`) and the `text-build-worker`/emscripten file-URL patterns stay external — the SEA runs without them and fails only when those lazy tools are actually triggered (M5 scope excludes the terminal tool). `@jsquash/webp`'s decoder glue and `zod` are force-bundled (pure JS; the wasm is the inlined base64 chunk).
- The Windows SEA variant and production signing/notarization are separate M5 items.

## Updating upstream

Upstream updates are deliberate migrations, not automatic dependency bumps:

1. Create a dedicated update branch from `codex/source-runtime`.
2. Fetch and inspect the desired signed/annotated upstream tag and resolved commit.
3. Review license, Node/pnpm, data schema, SDK exports and native dependency changes.
4. Pull without `--squash` so ancestry remains auditable:

   ```sh
   git subtree pull --prefix=runtime/kimi-code https://github.com/MoonshotAI/kimi-code.git <verified-tag>
   ```

5. Resolve conflicts without deleting `apps/desktop-runtime` or bypassing its adapter.
6. Run upstream package gates, Desktop Runtime protocol tests/smoke, outer Desktop gates and real Tauri acceptance.
7. Update this file, `THIRD_PARTY_NOTICES.md`, the migration plan and the release manifest source commit together.

Never update the subtree directly from an unreviewed branch head. Never use a ZIP copy, submodule, squashed subtree pull or production network download as a replacement for a reviewed source update.
