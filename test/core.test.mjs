import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  parseArgs,
  parseTunnelUrl,
  cloudflaredAsset,
  safeRepoPath,
} from '../src/core.mjs';

test('parseArgs defaults to current branch selection', () => {
  assert.deepEqual(parseArgs([]), { branch: null, help: false });
});

test('parseArgs accepts --branch', () => {
  assert.deepEqual(parseArgs(['--branch', 'main']), { branch: 'main', help: false });
});

test('parseArgs accepts --help', () => {
  assert.deepEqual(parseArgs(['--help']), { branch: null, help: true });
});

test('parseArgs rejects unknown arguments', () => {
  assert.throws(() => parseArgs(['--wat']), /Unknown argument/);
});

test('parseTunnelUrl extracts trycloudflare URL', () => {
  const text = 'INF created https://purple-example.trycloudflare.com ready';
  assert.equal(parseTunnelUrl(text), 'https://purple-example.trycloudflare.com');
});

test('parseTunnelUrl returns null when URL is absent', () => {
  assert.equal(parseTunnelUrl('starting tunnel'), null);
});

test('cloudflaredAsset maps supported platforms', () => {
  assert.equal(cloudflaredAsset('linux', 'x64'), 'cloudflared-linux-amd64');
  assert.equal(cloudflaredAsset('linux', 'arm64'), 'cloudflared-linux-arm64');
  assert.equal(cloudflaredAsset('darwin', 'x64'), 'cloudflared-darwin-amd64.tgz');
  assert.equal(cloudflaredAsset('darwin', 'arm64'), 'cloudflared-darwin-arm64.tgz');
});

test('cloudflaredAsset rejects unsupported platforms', () => {
  assert.throws(() => cloudflaredAsset('win32', 'x64'), /Unsupported platform/);
});

test('safeRepoPath maps URL paths inside root', () => {
  const root = path.resolve('/tmp/repo.git');
  assert.equal(safeRepoPath(root, '/info/refs'), path.join(root, 'info', 'refs'));
});

test('safeRepoPath rejects traversal outside root', () => {
  const root = path.resolve('/tmp/repo.git');
  assert.equal(safeRepoPath(root, '/../secret'), null);
  assert.equal(safeRepoPath(root, '/%2e%2e/secret'), null);
});

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import {
  discoverRepository,
  createBareSnapshot,
  startStaticServer,
  startSnapshotWatcher,
} from '../src/core.mjs';

const execFile = promisify(execFileCb);

async function git(cwd, args) {
  return execFile('git', args, { cwd });
}

test('bare snapshot is cloneable over localhost dumb HTTP', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'serve-git-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const clone = path.join(root, 'clone');
  await execFile('mkdir', ['-p', source]);
  await git(source, ['init', '-b', 'main']);
  await git(source, ['config', 'user.email', 'test@example.com']);
  await git(source, ['config', 'user.name', 'Test User']);
  await writeFile(path.join(source, 'hello.txt'), 'hello\n');
  await git(source, ['add', 'hello.txt']);
  await git(source, ['commit', '-m', 'initial']);

  const metadata = await discoverRepository(source, 'main');
  assert.equal(metadata.branch, 'main');
  assert.equal(metadata.repository, 'source');

  const bare = await createBareSnapshot(metadata.root, metadata.branch, root);
  const server = await startStaticServer(bare);
  t.after(() => server.close());

  await git(root, ['clone', `${server.url}/repo.git`, clone]);
  const { stdout } = await git(clone, ['rev-parse', 'HEAD']);
  assert.equal(stdout.trim(), metadata.commit);
});

import { chmod, access } from 'node:fs/promises';
import {
  startQuickTunnel,
  createTemporaryGitTunnel,
} from '../src/core.mjs';

test('startQuickTunnel parses URL from a long-running fake cloudflared process', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'serve-git-fake-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = path.join(root, 'cloudflared');
  await writeFile(fake, `#!/bin/sh\necho "INF https://fake-name.trycloudflare.com" >&2\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n`);
  await chmod(fake, 0o700);

  const tunnel = await startQuickTunnel(fake, 'http://127.0.0.1:12345', { timeoutMs: 1000 });
  assert.equal(tunnel.url, 'https://fake-name.trycloudflare.com');
  await tunnel.close();
});

test('createTemporaryGitTunnel cleans invocation-owned temp resources', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'serve-git-orchestrate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const tempParent = path.join(root, 'temp');
  await execFile('mkdir', ['-p', source, tempParent]);
  await git(source, ['init', '-b', 'main']);
  await git(source, ['config', 'user.email', 'test@example.com']);
  await git(source, ['config', 'user.name', 'Test User']);
  await writeFile(path.join(source, 'hello.txt'), 'hello\n');
  await git(source, ['add', 'hello.txt']);
  await git(source, ['commit', '-m', 'initial']);

  const fake = path.join(root, 'cloudflared');
  await writeFile(fake, `#!/bin/sh\necho "https://fake-name.trycloudflare.com" >&2\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n`);
  await chmod(fake, 0o700);

  const tunnel = await createTemporaryGitTunnel({
    cwd: source,
    branch: 'main',
    tempParent,
    env: { ...process.env, SERVE_GIT_CLOUDFLARED: fake },
    startupTimeoutMs: 1000,
  });

  assert.equal(tunnel.repository, 'source');
  assert.equal(tunnel.gitUrl, 'https://fake-name.trycloudflare.com/source.git');
  await access(tunnel.tempDirectory);
  await tunnel.close();
  await assert.rejects(access(tunnel.tempDirectory));
});

import { readFile, mkdir } from 'node:fs/promises';
import {
  writeSessionManifest,
  cleanupStaleSessions,
} from '../src/core.mjs';

test('parseArgs accepts --cleanup as a standalone maintenance command', () => {
  assert.deepEqual(parseArgs(['--cleanup']), { branch: null, help: false, cleanup: true });
});

test('session manifest records owner and tunnel child identity', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'serve-git-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeSessionManifest(root, {
    ownerPid: 101,
    cloudflaredPid: 202,
    cloudflaredExecutable: '/tmp/session/cloudflared',
    localUrl: 'http://127.0.0.1:4321',
    createdAt: 123456,
  });
  const data = JSON.parse(await readFile(path.join(root, 'session.json'), 'utf8'));
  assert.deepEqual(data, {
    version: 1,
    ownerPid: 101,
    cloudflaredPid: 202,
    cloudflaredExecutable: '/tmp/session/cloudflared',
    localUrl: 'http://127.0.0.1:4321',
    createdAt: 123456,
  });
});

test('cleanupStaleSessions removes dead-owner directory and kills matching orphan child', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'serve-git-scavenge-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const session = path.join(parent, 'serve-git-stale');
  await mkdir(session);
  await writeSessionManifest(session, {
    ownerPid: 111,
    cloudflaredPid: 222,
    cloudflaredExecutable: '/tmp/serve-git-stale/cloudflared',
    localUrl: 'http://127.0.0.1:4567',
    createdAt: 1,
  });
  const killed = [];
  const result = await cleanupStaleSessions({
    tempParent: parent,
    isProcessAlive: async (pid) => pid === 222,
    readProcessCommand: async (pid) => pid === 222
      ? '/tmp/serve-git-stale/cloudflared tunnel --url http://127.0.0.1:4567 --no-autoupdate'
      : null,
    terminateProcess: async (pid) => { killed.push(pid); },
  });
  assert.deepEqual(killed, [222]);
  assert.equal(result.cleaned, 1);
  await assert.rejects(access(session));
});

test('cleanupStaleSessions never kills a PID whose command does not match the manifest', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'serve-git-scavenge-safe-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const session = path.join(parent, 'serve-git-stale');
  await mkdir(session);
  await writeSessionManifest(session, {
    ownerPid: 111,
    cloudflaredPid: 222,
    cloudflaredExecutable: '/tmp/serve-git-stale/cloudflared',
    localUrl: 'http://127.0.0.1:4567',
    createdAt: 1,
  });
  const killed = [];
  const result = await cleanupStaleSessions({
    tempParent: parent,
    isProcessAlive: async (pid) => pid === 222,
    readProcessCommand: async () => '/usr/bin/sleep 9999',
    terminateProcess: async (pid) => { killed.push(pid); },
  });
  assert.deepEqual(killed, []);
  assert.equal(result.cleaned, 1);
  assert.equal(result.skippedUnsafeProcess, 1);
  await assert.rejects(access(session));
});

test('cleanupStaleSessions leaves active owner sessions untouched', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'serve-git-scavenge-active-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const session = path.join(parent, 'serve-git-active');
  await mkdir(session);
  await writeSessionManifest(session, {
    ownerPid: 111,
    cloudflaredPid: 222,
    cloudflaredExecutable: '/tmp/serve-git-active/cloudflared',
    localUrl: 'http://127.0.0.1:4567',
    createdAt: 1,
  });
  const result = await cleanupStaleSessions({
    tempParent: parent,
    isProcessAlive: async (pid) => pid === 111 || pid === 222,
    readProcessCommand: async () => null,
    terminateProcess: async () => { throw new Error('must not terminate'); },
  });
  assert.equal(result.active, 1);
  await access(session);
});

test('cleanupStaleSessions removes manifestless directory when encoded owner PID is dead', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'serve-git-orphan-dir-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const session = path.join(parent, 'serve-git-777-deadbeef');
  await mkdir(session);
  const result = await cleanupStaleSessions({
    tempParent: parent,
    isProcessAlive: async () => false,
    readProcessCommand: async () => null,
    terminateProcess: async () => {},
  });
  assert.equal(result.cleaned, 1);
  await assert.rejects(access(session));
});

test('cleanupStaleSessions preserves manifestless directory when encoded owner PID is alive', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'serve-git-live-dir-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const session = path.join(parent, 'serve-git-888-livebeef');
  await mkdir(session);
  const result = await cleanupStaleSessions({
    tempParent: parent,
    isProcessAlive: async (pid) => pid === 888,
    readProcessCommand: async () => null,
    terminateProcess: async () => {},
  });
  assert.equal(result.active, 1);
  await access(session);
});

test('bare snapshot exposes the selected branch commit as a loose object for dumb HTTP clients', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'serve-git-loose-object-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const tempRoot = path.join(root, 'temp');
  await mkdir(source, { recursive: true });
  await mkdir(tempRoot, { recursive: true });
  await git(source, ['init', '-b', 'main']);
  await git(source, ['config', 'user.email', 'test@example.com']);
  await git(source, ['config', 'user.name', 'Test User']);
  await writeFile(path.join(source, 'hello.txt'), 'hello\n');
  await git(source, ['add', 'hello.txt']);
  await git(source, ['commit', '-m', 'initial']);
  const { stdout } = await git(source, ['rev-parse', 'HEAD']);
  const commit = stdout.trim();

  const bare = await createBareSnapshot(source, 'main', tempRoot);
  const loosePath = path.join(bare, 'objects', commit.slice(0, 2), commit.slice(2));
  await access(loosePath);
});


test('snapshot watcher updates the same HTTP endpoint after a new source commit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'serve-git-watch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const tempRoot = path.join(root, 'temp');
  await mkdir(source, { recursive: true });
  await mkdir(tempRoot, { recursive: true });
  await git(source, ['init', '-b', 'main']);
  await git(source, ['config', 'user.email', 'test@example.com']);
  await git(source, ['config', 'user.name', 'Test User']);
  await writeFile(path.join(source, 'hello.txt'), 'one\n');
  await git(source, ['add', 'hello.txt']);
  await git(source, ['commit', '-m', 'initial']);
  const { stdout: firstOut } = await git(source, ['rev-parse', 'HEAD']);
  const firstCommit = firstOut.trim();

  const bare = await createBareSnapshot(source, 'main', tempRoot);
  const server = await startStaticServer(bare);
  t.after(() => server.close());
  const watcher = startSnapshotWatcher({
    repoRoot: source,
    branch: 'main',
    tempRoot,
    server,
    currentCommit: firstCommit,
    intervalMs: 25,
  });
  t.after(() => watcher.close());

  const before = await fetch(`${server.url}${server.gitPath}/info/refs`).then((r) => r.text());
  assert.match(before, new RegExp(firstCommit));

  await writeFile(path.join(source, 'hello.txt'), 'two\n');
  await git(source, ['add', 'hello.txt']);
  await git(source, ['commit', '-m', 'second']);
  const { stdout: secondOut } = await git(source, ['rev-parse', 'HEAD']);
  const secondCommit = secondOut.trim();

  let refs = '';
  for (let i = 0; i < 80; i += 1) {
    refs = await fetch(`${server.url}${server.gitPath}/info/refs`).then((r) => r.text());
    if (refs.includes(secondCommit)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(refs, new RegExp(secondCommit));

  const objectResponse = await fetch(
    `${server.url}${server.gitPath}/objects/${secondCommit.slice(0, 2)}/${secondCommit.slice(2)}`,
  );
  assert.equal(objectResponse.status, 200);
});
