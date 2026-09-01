import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, chmod, readdir, rm, access } from 'node:fs/promises';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
const projectRoot = path.resolve(import.meta.dirname, '..');

async function git(cwd, args) {
  return execFile('git', args, { cwd });
}

test('CLI prints clone URL and removes temporary resources on SIGINT', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'serve-git-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const tempParent = path.join(root, 'tmp');
  await mkdir(source, { recursive: true });
  await mkdir(tempParent, { recursive: true });
  await git(source, ['init', '-b', 'main']);
  await git(source, ['config', 'user.email', 'test@example.com']);
  await git(source, ['config', 'user.name', 'Test User']);
  await writeFile(path.join(source, 'hello.txt'), 'hello\n');
  await git(source, ['add', 'hello.txt']);
  await git(source, ['commit', '-m', 'initial']);

  const fake = path.join(root, 'cloudflared');
  await writeFile(fake, `#!/bin/sh\necho "https://cli-fake.trycloudflare.com" >&2\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n`);
  await chmod(fake, 0o700);

  const child = spawn(process.execPath, [path.join(projectRoot, 'bin', 'serve-git.mjs')], {
    cwd: source,
    env: {
      ...process.env,
      TMPDIR: tempParent,
      SERVE_GIT_CLOUDFLARED: fake,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI did not become ready. stdout=${stdout} stderr=${stderr}`)), 4000);
    const inspect = () => {
      if (stdout.includes('https://cli-fake.trycloudflare.com/source.git')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', inspect);
    child.once('exit', (code) => {
      if (!stdout.includes('https://cli-fake.trycloudflare.com/source.git')) {
        clearTimeout(timer);
        reject(new Error(`CLI exited early with ${code}. stdout=${stdout} stderr=${stderr}`));
      }
    });
  });

  child.kill('SIGINT');
  const exit = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  assert.equal(exit.code, 0, `stdout=${stdout}\nstderr=${stderr}`);
  assert.match(stdout, /Repository: source/);
  assert.match(stdout, /Branch: main/);
  assert.match(stdout, /Press Ctrl-C to close and clean up/);
  assert.match(stdout, /Closed and cleaned up/);
  const leftovers = (await readdir(tempParent)).filter((name) => name.startsWith('serve-git-'));
  assert.deepEqual(leftovers, []);
});

test('CLI cleans temporary resources when SIGINT arrives before tunnel URL', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'serve-git-early-sigint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const tempParent = path.join(root, 'tmp');
  await mkdir(source, { recursive: true });
  await mkdir(tempParent, { recursive: true });
  await git(source, ['init', '-b', 'main']);
  await git(source, ['config', 'user.email', 'test@example.com']);
  await git(source, ['config', 'user.name', 'Test User']);
  await writeFile(path.join(source, 'hello.txt'), 'hello\n');
  await git(source, ['add', 'hello.txt']);
  await git(source, ['commit', '-m', 'initial']);

  const fake = path.join(root, 'cloudflared');
  await writeFile(fake, `#!/bin/sh\ntrap 'exit 0' TERM INT\nsleep 3\necho "https://too-late.trycloudflare.com" >&2\nwhile :; do sleep 1; done\n`);
  await chmod(fake, 0o700);

  const child = spawn(process.execPath, [path.join(projectRoot, 'bin', 'serve-git.mjs')], {
    cwd: source,
    env: {
      ...process.env,
      TMPDIR: tempParent,
      SERVE_GIT_CLOUDFLARED: fake,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI did not start. stdout=${stdout}`)), 2000);
    child.stdout.on('data', () => {
      if (stdout.includes('Creating temporary read-only Git tunnel...')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  child.kill('SIGINT');
  const exit = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  assert.equal(exit.code, 0, `signal=${exit.signal} stdout=${stdout}`);
  const leftovers = (await readdir(tempParent)).filter((name) => name.startsWith('serve-git-'));
  assert.deepEqual(leftovers, []);
});

test('CLI --cleanup removes stale sessions without opening a tunnel', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'serve-git-cleanup-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tempParent = path.join(root, 'tmp');
  await mkdir(tempParent, { recursive: true });
  const stale = path.join(tempParent, 'serve-git-999999-stale');
  await mkdir(stale);

  const { stdout, stderr } = await execFile(process.execPath, [
    path.join(projectRoot, 'bin', 'serve-git.mjs'),
    '--cleanup',
  ], {
    cwd: root,
    env: { ...process.env, TMPDIR: tempParent },
  });

  assert.equal(stderr, '');
  assert.match(stdout, /Cleaned 1 stale session/);
  await assert.rejects(access(stale));
});

test('CLI --cleanup recovers orphan child and temp directory after parent SIGKILL', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'serve-git-hardkill-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const tempParent = path.join(root, 'tmp');
  await mkdir(source, { recursive: true });
  await mkdir(tempParent, { recursive: true });
  await git(source, ['init', '-b', 'main']);
  await git(source, ['config', 'user.email', 'test@example.com']);
  await git(source, ['config', 'user.name', 'Test User']);
  await writeFile(path.join(source, 'hello.txt'), 'hello\n');
  await git(source, ['add', 'hello.txt']);
  await git(source, ['commit', '-m', 'initial']);

  const fake = path.join(root, 'cloudflared');
  await writeFile(fake, `#!/bin/sh\necho "https://hardkill-fake.trycloudflare.com" >&2\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n`);
  await chmod(fake, 0o700);

  const child = spawn(process.execPath, [path.join(projectRoot, 'bin', 'serve-git.mjs')], {
    cwd: source,
    env: { ...process.env, TMPDIR: tempParent, SERVE_GIT_CLOUDFLARED: fake },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI did not become ready: ${stdout}`)), 4000);
    child.stdout.on('data', () => {
      if (stdout.includes('hardkill-fake.trycloudflare.com/source.git')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  const before = (await readdir(tempParent)).filter((name) => name.startsWith('serve-git-'));
  assert.equal(before.length, 1);

  const { stdout: cleanupOut } = await execFile(process.execPath, [
    path.join(projectRoot, 'bin', 'serve-git.mjs'), '--cleanup',
  ], { cwd: root, env: { ...process.env, TMPDIR: tempParent } });
  assert.match(cleanupOut, /Cleaned 1 stale session/);
  const after = (await readdir(tempParent)).filter((name) => name.startsWith('serve-git-'));
  assert.deepEqual(after, []);
});
