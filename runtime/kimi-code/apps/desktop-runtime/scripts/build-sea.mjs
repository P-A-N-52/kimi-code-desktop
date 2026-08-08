#!/usr/bin/env node
// M5 SEA sidecar build.
//
// Produces the Tauri `externalBin` artifact
// `src-tauri/binaries/desktop-runtime-<target-triple>`: a Node single
// executable application that runs the Desktop Runtime with no `node` on
// PATH. Pipeline:
//
//   1. tsdown single-file CJS bundle of the TLA-free `main-sea` entry
//      (tsdown.sea.config.ts -> dist-sea/sea-main.cjs);
//   2. `node --experimental-sea-config` -> sea-prep.blob;
//   3. copy the SEA-capable node binary to the artifact path;
//   4. `codesign --remove-signature` (arm64 rejects unsigned code at exec);
//   5. `postject` injection. On macOS the injected segment MUST be named
//      `NODE_SEA` (not `NODE_SEA_BLOB`): since Node 22 the runtime looks the
//      blob up via `getsectdata("NODE_SEA", "__NODE_SEA_BLOB")` — injecting
//      under `NODE_SEA_BLOB` yields a binary that segfaults at startup
//      (null blob, `SeaDeserializer::ReadArithmetic` crash);
//   6. ad-hoc re-sign (`codesign --sign -`) — required before exec on arm64;
//   7. built-in protocol smoke: hello -> getInfo (pinned commit) -> shutdown.
//
// The SEA node: `process.execPath` is probed for SEA capability; a build that
// disabled SEA (e.g. Homebrew's node) is rejected, and the pinned official
// Node (`24.15.0`, matching the upstream `.nvmrc`) is downloaded into
// `.sea-node/` instead. `SEA_NODE` overrides the node binary explicitly.
//
// Windows/Linux variants are a later M5 follow-up; the script refuses to run
// off-macOS.

import { spawn, spawnSync } from 'node:child_process';
import { copyFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);

// --- paths -----------------------------------------------------------------

const PACKAGE_DIR = resolve(import.meta.dirname, '..');
const MONOREPO_DIR = resolve(PACKAGE_DIR, '../..');
const REPO_ROOT = resolve(MONOREPO_DIR, '../..');

const SEA_TSDOWN_CONFIG = resolve(PACKAGE_DIR, 'tsdown.sea.config.ts');
const BUILD_DIR = resolve(PACKAGE_DIR, 'dist-sea');
const BUNDLE_FILE = resolve(BUILD_DIR, 'sea-main.cjs');
const BLOB_FILE = resolve(BUILD_DIR, 'sea-prep.blob');

const SIDECAR_BASENAME = 'desktop-runtime';
const BINARIES_DIR = resolve(REPO_ROOT, 'src-tauri', 'binaries');

const SEA_CONFIG_FIELDS = {
  main: BUNDLE_FILE,
  output: BLOB_FILE,
  disableExperimentalSEAWarning: true,
};

const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
// See the header comment: Node >= 22 looks for the blob in segment `NODE_SEA`.
const MACHO_SEGMENT_NAME = 'NODE_SEA';

const PINNED_SEA_NODE = {
  version: '24.15.0',
  // Official builds have SEA enabled; Homebrew's node builds it disabled.
  tarball(arch) {
    return `https://nodejs.org/dist/v${this.version}/node-v${this.version}-darwin-${arch}.tar.gz`;
  },
};
const SEA_NODE_CACHE_DIR = resolve(PACKAGE_DIR, '.sea-node');

// --- helpers ---------------------------------------------------------------

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  if (result.error) {
    throw new Error(`failed to run \`${cmd} ${args.join(' ')}\`: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    throw new Error(
      `\`${cmd} ${args.join(' ')}\` exited with ${result.status}${stderr ? `:\n${stderr}` : ''}`,
    );
  }
  return result;
}

function tryRun(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  return result.status === 0 && result.error === undefined;
}

async function probeSeaCapable(nodeBin) {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sea-probe-'));
  try {
    await writeFile(join(dir, 'probe.cjs'), '');
    await writeFile(
      join(dir, 'sea-config.json'),
      JSON.stringify({ main: 'probe.cjs', output: 'probe.blob' }),
    );
    const result = spawnSync(
      nodeBin,
      ['--experimental-sea-config', 'sea-config.json'],
      { cwd: dir, encoding: 'utf8' },
    );
    if (result.status !== 0) return false;
    await readFile(join(dir, 'probe.blob'));
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function ensurePinnedSeaNode() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const nodeBin = resolve(
    SEA_NODE_CACHE_DIR,
    `node-v${PINNED_SEA_NODE.version}-darwin-${arch}`,
    'bin',
    'node',
  );
  try {
    await readFile(nodeBin);
  } catch {
    const tarballPath = resolve(SEA_NODE_CACHE_DIR, `node-v${PINNED_SEA_NODE.version}-darwin-${arch}.tar.gz`);
    console.log(`[sea] downloading pinned Node ${PINNED_SEA_NODE.version} (darwin-${arch})…`);
    await mkdir(SEA_NODE_CACHE_DIR, { recursive: true });
    const response = await fetch(PINNED_SEA_NODE.tarball(arch));
    if (!response.ok || !response.body) {
      throw new Error(`download failed: ${response.status} ${response.statusText}`);
    }
    await pipeline(Readable.fromWeb(response.body), (await import('node:fs')).createWriteStream(tarballPath));
    console.log(`[sea] extracting ${tarballPath}…`);
    run('tar', ['-xzf', tarballPath, '-C', SEA_NODE_CACHE_DIR]);
  }
  if (!(await probeSeaCapable(nodeBin))) {
    throw new Error(
      `pinned Node ${PINNED_SEA_NODE.version} at ${nodeBin} cannot build SEA blobs; ` +
        're-download by deleting .sea-node/',
    );
  }
  return nodeBin;
}

async function pickSeaNode() {
  if (process.env.SEA_NODE) {
    const nodeBin = resolve(process.env.SEA_NODE);
    if (!(await probeSeaCapable(nodeBin))) {
      throw new Error(`SEA_NODE=${nodeBin} cannot build SEA blobs (Single executable application disabled)`);
    }
    return nodeBin;
  }
  if (await probeSeaCapable(process.execPath)) {
    return process.execPath;
  }
  console.log(
    `[sea] ${process.execPath} cannot build SEA blobs (build disabled), falling back to the pinned official Node…`,
  );
  return ensurePinnedSeaNode();
}

// --- protocol smoke --------------------------------------------------------

async function smokeArtifact(artifactPath) {
  // Boot the real engine on hello; keep the smoke away from the user's home.
  const home = await mkdtemp(join(tmpdir(), 'kimi-sea-smoke-'));
  const child = spawn(artifactPath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, KIMI_CODE_HOME: home },
  });
  child.stderr.on('data', () => {});
  const pending = new Map();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line.length === 0) continue;
      const frame = JSON.parse(line);
      if (frame.type === 'response' && pending.has(frame.id)) {
        pending.get(frame.id)(frame);
        pending.delete(frame.id);
      }
    }
  });
  const request = (id, method, params) =>
    new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(
        `${JSON.stringify({ protocol: 'runtime-v1', type: 'request', id, method, params })}\n`,
      );
    });
  const exited = new Promise((resolve) => child.once('exit', resolve));

  try {
    const hello = await withTimeout(
      request('hello-1', 'runtime.hello', {
        desktopVersion: '1.0.0-sea',
        supportedProtocols: ['runtime-v1'],
        dataRoot: home,
        platform: 'darwin',
        arch: process.arch,
        locale: 'en-US',
      }),
      30_000,
      'hello',
    );
    if (hello?.ok !== true) {
      throw new Error(`SEA artifact smoke: hello failed: ${JSON.stringify(hello?.error ?? hello)}`);
    }
    const info = await withTimeout(request('info-1', 'runtime.getInfo', {}), 30_000, 'getInfo');
    if (info?.ok !== true) {
      throw new Error(`SEA artifact smoke: getInfo failed: ${JSON.stringify(info?.error ?? info)}`);
    }
    await withTimeout(request('shutdown-1', 'runtime.shutdown', {}), 30_000, 'shutdown');
    child.stdin.end();
    await withTimeout(exited, 30_000, 'exit');
    return info.result.kimiSource?.commit;
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`SEA artifact smoke timed out waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// --- main ------------------------------------------------------------------

async function main() {
  const targetArg = process.argv.find((arg) => arg.startsWith('--target='));
  const target = targetArg
    ? targetArg.slice('--target='.length)
    : process.platform === 'darwin'
      ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
      : undefined;
  if (process.platform !== 'darwin' || !target) {
    throw new Error(
      `build:sea currently supports macOS only (this host: ${process.platform}/${process.arch}); ` +
        'the Windows variant is a separate M5 follow-up. Pass --target= for supported macOS triples.',
    );
  }

  const artifactPath = resolve(BINARIES_DIR, `${SIDECAR_BASENAME}-${target}`);
  const seaNode = await pickSeaNode();
  const seaNodeVersion = spawnSync(seaNode, ['--version'], { encoding: 'utf8' }).stdout.trim();

  console.log(`[sea] bundle:  ${BUNDLE_FILE}`);
  console.log(`[sea] sea node: ${seaNode} (${seaNodeVersion})`);
  console.log(`[sea] target:   ${target}`);

  // 1. single-file CJS bundle (entry format fixed by tsdown.sea.config.ts).
  const tsdownPkg = require.resolve('tsdown/package.json');
  const tsdownRun = join(dirname(tsdownPkg), require(tsdownPkg).bin.tsdown);
  console.log('[sea] bundling with tsdown…');
  run(process.execPath, [tsdownRun, '--config', SEA_TSDOWN_CONFIG], { cwd: PACKAGE_DIR, stdio: 'inherit' });

  // 2. SEA preparation blob.
  const seaConfigPath = join(BUILD_DIR, 'sea-config.json');
  await writeFile(seaConfigPath, JSON.stringify(SEA_CONFIG_FIELDS, null, 2));
  console.log('[sea] generating SEA blob…');
  run(seaNode, ['--experimental-sea-config', seaConfigPath], { cwd: BUILD_DIR });

  // 3. copy the node binary.
  console.log(`[sea] copying ${seaNode} -> ${artifactPath}`);
  await mkdir(BINARIES_DIR, { recursive: true });
  await copyFile(seaNode, artifactPath);
  await chmod(artifactPath, 0o755);

  // 4. strip the signature before injection (arm64 execs only signed code).
  if (!tryRun('codesign', ['--remove-signature', artifactPath])) {
    console.log('[sea] artifact had no code signature to remove (proceeding)');
  }

  // 5. postject injection (macho segment must be `NODE_SEA`, see header).
  const postjectPkg = require.resolve('postject/package.json');
  const postjectRun = join(dirname(postjectPkg), require(postjectPkg).bin.postject);
  console.log('[sea] injecting blob via postject…');
  run(postjectRun, [
    artifactPath,
    'NODE_SEA_BLOB',
    BLOB_FILE,
    '--sentinel-fuse',
    SENTINEL_FUSE,
    '--macho-segment-name',
    MACHO_SEGMENT_NAME,
  ]);

  // 6. ad-hoc re-sign (required before exec on arm64).
  console.log('[sea] ad-hoc re-signing…');
  run('codesign', ['--sign', '-', artifactPath]);

  // 7. boot smoke: hello -> getInfo (pinned commit) -> shutdown.
  const protocolSource = await readFile(resolve(PACKAGE_DIR, 'src', 'protocol.ts'), 'utf8');
  const expectedCommit = protocolSource.match(/KIMI_SOURCE_COMMIT = '([0-9a-f]{40})'/)?.[1];
  if (!expectedCommit) throw new Error('cannot read KIMI_SOURCE_COMMIT from src/protocol.ts');
  console.log('[sea] boot smoke…');
  const reportedCommit = await smokeArtifact(artifactPath);
  if (reportedCommit !== expectedCommit) {
    throw new Error(
      `artifact reported kimiSource.commit ${reportedCommit ?? '<missing>'}, expected ${expectedCommit}`,
    );
  }

  const size = (await readFile(artifactPath)).length;
  console.log(`[sea] done: ${artifactPath} (${(size / 1024 / 1024).toFixed(1)} MB, commit ${expectedCommit})`);
}

main().catch((error) => {
  console.error(`[sea] ${error.message}`);
  process.exitCode = 1;
});
