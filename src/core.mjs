import path from 'node:path';
import http from 'node:http';
import { createReadStream, constants as fsConstants } from 'node:fs';
import { stat, access, chmod, mkdtemp, rm, writeFile, readFile, readdir, rename, mkdir } from 'node:fs/promises';
import { execFile as execFileCb, spawn } from 'node:child_process';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export function parseArgs(argv) {
  const result = { branch: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    if (arg === '--cleanup') {
      result.cleanup = true;
      continue;
    }
    if (arg === '--branch' || arg === '-b') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) {
        throw new Error('Missing value for --branch');
      }
      result.branch = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

export function parseTunnelUrl(text) {
  return text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)?.[0] ?? null;
}

export function cloudflaredAsset(platform, arch) {
  const key = `${platform}/${arch}`;
  const assets = {
    'linux/x64': 'cloudflared-linux-amd64',
    'linux/arm64': 'cloudflared-linux-arm64',
    'darwin/x64': 'cloudflared-darwin-amd64.tgz',
    'darwin/arm64': 'cloudflared-darwin-arm64.tgz',
  };
  const asset = assets[key];
  if (!asset) throw new Error(`Unsupported platform: ${key}`);
  return asset;
}

export function safeRepoPath(root, requestUrl) {
  const pathname = requestUrl.split('?', 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const parts = decoded.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) return null;
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...parts);
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`)) return null;
  return candidate;
}


export async function writeSessionManifest(tempDirectory, session) {
  const manifest = {
    version: 1,
    ownerPid: session.ownerPid,
    cloudflaredPid: session.cloudflaredPid ?? null,
    cloudflaredExecutable: session.cloudflaredExecutable ?? null,
    localUrl: session.localUrl ?? null,
    createdAt: session.createdAt,
  };
  const manifestPath = path.join(tempDirectory, 'session.json');
  const tempPath = `${manifestPath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, manifestPath);
  return manifest;
}

async function defaultIsProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function defaultReadProcessCommand(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const raw = await readFile(`/proc/${pid}/cmdline`);
      return raw.toString('utf8').split('\0').filter(Boolean).join(' ');
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFile('ps', ['-p', String(pid), '-o', 'command=']);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}

async function defaultTerminateProcess(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (await defaultIsProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
}

function commandMatchesManifest(command, manifest) {
  if (!command || !manifest.cloudflaredExecutable || !manifest.localUrl) return false;
  return command.includes(manifest.cloudflaredExecutable)
    && command.includes(' tunnel ')
    && command.includes(`--url ${manifest.localUrl}`)
    && command.includes('--no-autoupdate');
}

export async function cleanupStaleSessions({
  tempParent = os.tmpdir(),
  isProcessAlive = defaultIsProcessAlive,
  readProcessCommand = defaultReadProcessCommand,
  terminateProcess = defaultTerminateProcess,
} = {}) {
  const result = { cleaned: 0, active: 0, skippedUnsafeProcess: 0 };
  let entries = [];
  try {
    entries = await readdir(tempParent, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return result;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('serve-git-')) continue;
    const sessionDir = path.join(tempParent, entry.name);
    const manifestPath = path.join(sessionDir, 'session.json');
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch {
      const match = entry.name.match(/^serve-git-(\d+)-/);
      if (!match) continue;
      const encodedOwnerPid = Number.parseInt(match[1], 10);
      if (await isProcessAlive(encodedOwnerPid)) {
        result.active += 1;
        continue;
      }
      await rm(sessionDir, { recursive: true, force: true });
      result.cleaned += 1;
      continue;
    }
    if (manifest?.version !== 1 || !Number.isInteger(manifest.ownerPid)) continue;
    if (await isProcessAlive(manifest.ownerPid)) {
      result.active += 1;
      continue;
    }

    if (Number.isInteger(manifest.cloudflaredPid) && await isProcessAlive(manifest.cloudflaredPid)) {
      const command = await readProcessCommand(manifest.cloudflaredPid);
      if (commandMatchesManifest(command, manifest)) {
        await terminateProcess(manifest.cloudflaredPid);
      } else {
        result.skippedUnsafeProcess += 1;
      }
    }
    await rm(sessionDir, { recursive: true, force: true });
    result.cleaned += 1;
  }
  return result;
}


async function runGit(args, options = {}) {
  try {
    return await execFile('git', args, options);
  } catch (error) {
    const detail = error?.stderr?.trim() || error?.message || String(error);
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}

export async function discoverRepository(cwd, requestedBranch = null, signal = undefined) {
  const { stdout: rootOut } = await runGit(['rev-parse', '--show-toplevel'], { cwd, signal });
  const root = rootOut.trim();
  let branch = requestedBranch;
  if (!branch) {
    const { stdout: branchOut } = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root, signal });
    branch = branchOut.trim();
  }
  const { stdout: commitOut } = await runGit(['rev-parse', '--verify', `${branch}^{commit}`], { cwd: root, signal });
  return {
    root,
    repository: path.basename(root),
    branch,
    commit: commitOut.trim(),
  };
}

async function unpackSnapshotObjects(bareDir, tempRoot, signal = undefined) {
  const packDir = path.join(bareDir, 'objects', 'pack');
  const entries = await readdir(packDir).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const packNames = entries.filter((name) => name.endsWith('.pack'));
  if (packNames.length === 0) return;

  const savedDir = path.join(tempRoot, 'packed-objects');
  await mkdir(savedDir, { recursive: true });
  const savedPacks = [];
  for (const packName of packNames) {
    const base = packName.slice(0, -5);
    const savedPack = path.join(savedDir, packName);
    await rename(path.join(packDir, packName), savedPack);
    savedPacks.push(savedPack);
    await rm(path.join(packDir, `${base}.idx`), { force: true });
    await rm(path.join(packDir, `${base}.rev`), { force: true });
    await rm(path.join(packDir, `${base}.bitmap`), { force: true });
  }

  for (const savedPack of savedPacks) {
    await new Promise((resolve, reject) => {
      const child = spawn('git', ['--git-dir', bareDir, 'unpack-objects', '-r'], {
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('exit', (code, exitSignal) => {
        if (code === 0) resolve();
        else reject(new Error(`git unpack-objects failed (code=${code}, signal=${exitSignal}): ${stderr.trim()}`));
      });
      if (signal?.aborted) child.kill('SIGTERM');
      signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
      createReadStream(savedPack).pipe(child.stdin);
    });
  }
  await rm(savedDir, { recursive: true, force: true });
}

export async function createBareSnapshot(repoRoot, branch, tempRoot, signal = undefined) {
  const bareDir = path.join(tempRoot, 'repo.git');
  await runGit([
    'clone', '--bare', '--no-local', '--single-branch', '--branch', branch, repoRoot, bareDir,
  ], { signal });
  await unpackSnapshotObjects(bareDir, tempRoot, signal);
  await runGit(['--git-dir', bareDir, 'update-server-info'], { signal });
  return bareDir;
}

export async function startStaticServer(repoDir, publicName = 'repo') {
  const safeName = publicName.replace(/[^A-Za-z0-9._-]/g, '-') || 'repo';
  const gitPath = `/${safeName}.git`;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end();
        return;
      }
      const rawPath = req.url ?? '/';
      const pathname = rawPath.split('?', 1)[0];
      if (pathname !== gitPath && !pathname.startsWith(`${gitPath}/`)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const relativeUrl = pathname.slice(gitPath.length) || '/';
      const filePath = safeRepoPath(repoDir, relativeUrl);
      if (!filePath) {
        res.writeHead(400);
        res.end();
        return;
      }
      const info = await stat(filePath).catch(() => null);
      if (!info?.isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      const headers = {
        'Content-Length': String(info.size),
        'Cache-Control': 'no-store',
      };
      if (filePath.endsWith('/info/refs') || filePath.endsWith(`${path.sep}HEAD`)) {
        headers['Content-Type'] = 'text/plain; charset=utf-8';
      } else {
        headers['Content-Type'] = 'application/octet-stream';
      }
      res.writeHead(200, headers);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = createReadStream(filePath);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to determine HTTP server address');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    gitPath,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}


async function isExecutable(filePath) {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(name, env = process.env) {
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

function extractCloudflaredFromTgz(buffer) {
  const tar = gunzipSync(buffer);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (path.basename(name) === 'cloudflared') return tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new Error('Downloaded cloudflared archive did not contain the cloudflared binary');
}

export async function resolveCloudflared(tempRoot, env = process.env, signal = undefined) {
  const override = env.SERVE_GIT_CLOUDFLARED;
  if (override) {
    if (!await isExecutable(override)) {
      throw new Error(`SERVE_GIT_CLOUDFLARED is not executable: ${override}`);
    }
    return { executable: override, owned: false };
  }

  const existing = await findOnPath('cloudflared', env);
  if (existing) return { executable: existing, owned: false };

  const asset = cloudflaredAsset(process.platform, process.arch);
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  const response = await fetch(url, { redirect: 'follow', signal });
  if (!response.ok) throw new Error(`Failed to download cloudflared: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const executable = path.join(tempRoot, 'cloudflared');
  const binary = asset.endsWith('.tgz') ? extractCloudflaredFromTgz(bytes) : bytes;
  await writeFile(executable, binary, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { executable, owned: true };
}

export async function startQuickTunnel(executable, localUrl, { timeoutMs = 20_000, signal = undefined, onSpawn = null } = {}) {
  if (signal?.aborted) {
    const error = new Error('Operation aborted');
    error.name = 'AbortError';
    throw error;
  }
  const child = spawn(executable, ['tunnel', '--url', localUrl, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (onSpawn) await onSpawn(child);

  let settled = false;
  let output = '';
  let closePromise = null;

  const startup = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for Cloudflare Quick Tunnel URL after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const onData = (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-65_536);
      const url = parseTunnelUrl(output);
      if (url) finish(resolve, url);
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (error) => finish(reject, error));
    child.once('exit', (code, exitSignal) => {
      if (!settled) {
        finish(reject, new Error(`cloudflared exited before creating a tunnel (code=${code}, signal=${exitSignal})`));
      }
    });
    signal?.addEventListener('abort', () => {
      const error = new Error('Operation aborted');
      error.name = 'AbortError';
      finish(reject, error);
    }, { once: true });
  });

  const close = () => {
    if (closePromise) return closePromise;
    closePromise = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(forceTimer);
        resolve();
      });
      child.kill('SIGTERM');
    });
    return closePromise;
  };

  try {
    const url = await startup;
    return { url, process: child, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function createTemporaryGitTunnel({
  cwd = process.cwd(),
  branch = null,
  env = process.env,
  tempParent = os.tmpdir(),
  startupTimeoutMs = 20_000,
  signal = undefined,
} = {}) {
  await cleanupStaleSessions({ tempParent });
  const metadata = await discoverRepository(cwd, branch, signal);
  const tempDirectory = await mkdtemp(path.join(tempParent, `serve-git-${process.pid}-`));
  const session = {
    ownerPid: process.pid,
    cloudflaredPid: null,
    cloudflaredExecutable: null,
    localUrl: null,
    createdAt: Date.now(),
  };
  await writeSessionManifest(tempDirectory, session);
  let server = null;
  let tunnel = null;
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    await tunnel?.close().catch(() => {});
    await server?.close().catch(() => {});
    await rm(tempDirectory, { recursive: true, force: true });
  };

  try {
    if (signal?.aborted) { const error = new Error('Operation aborted'); error.name = 'AbortError'; throw error; }
    const bare = await createBareSnapshot(metadata.root, metadata.branch, tempDirectory, signal);
    server = await startStaticServer(bare, metadata.repository);
    const cloudflared = await resolveCloudflared(tempDirectory, env, signal);
    session.cloudflaredExecutable = cloudflared.executable;
    session.localUrl = server.url;
    await writeSessionManifest(tempDirectory, session);
    tunnel = await startQuickTunnel(cloudflared.executable, server.url, {
      timeoutMs: startupTimeoutMs,
      signal,
      onSpawn: async (child) => {
        session.cloudflaredPid = child.pid ?? null;
        await writeSessionManifest(tempDirectory, session);
      },
    });
    return {
      ...metadata,
      tempDirectory,
      gitUrl: `${tunnel.url}${server.gitPath}`,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
