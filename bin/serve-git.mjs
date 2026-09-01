#!/usr/bin/env node

import os from 'node:os';
import { parseArgs, createTemporaryGitTunnel, cleanupStaleSessions } from '../src/core.mjs';

const HELP = `serve-git

Expose the current Git repository as a temporary read-only HTTPS remote.

Usage:
  serve-git [--branch <name>]
  serve-git --cleanup

Options:
  -b, --branch <name>  Branch to expose. Defaults to the current branch.
      --cleanup        Remove stale serve-git sessions and exit.
  -h, --help           Show this help.
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.cleanup) {
    const result = await cleanupStaleSessions({ tempParent: os.tmpdir() });
    const noun = result.cleaned === 1 ? 'session' : 'sessions';
    console.log(`Cleaned ${result.cleaned} stale ${noun}.`);
    if (result.skippedUnsafeProcess > 0) {
      console.log(`Skipped killing ${result.skippedUnsafeProcess} process because its identity could not be verified.`);
    }
    return;
  }

  const controller = new AbortController();
  let tunnel = null;
  let shuttingDown = false;
  let resolveShutdown;
  const shutdownPromise = new Promise((resolve) => { resolveShutdown = resolve; });

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    controller.abort();
    if (tunnel) {
      await tunnel.close();
      console.log('Closed and cleaned up.');
      resolveShutdown();
    }
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  console.log('Creating temporary read-only Git tunnel...');
  try {
    tunnel = await createTemporaryGitTunnel({ branch: args.branch, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      console.log('Closed and cleaned up.');
      resolveShutdown();
      await shutdownPromise;
      return;
    }
    throw error;
  }

  if (controller.signal.aborted) {
    await tunnel.close();
    console.log('Closed and cleaned up.');
    resolveShutdown();
    await shutdownPromise;
    return;
  }

  const shortCommit = tunnel.commit.slice(0, 7);
  console.log(`Repository: ${tunnel.repository}`);
  console.log(`Branch: ${tunnel.branch}`);
  console.log(`Commit: ${shortCommit}`);
  console.log('');
  console.log('Ready:');
  console.log(tunnel.gitUrl);
  console.log('');
  console.log('Clone:');
  console.log(`git clone ${tunnel.gitUrl}`);
  console.log('');
  console.log('Warning: the URL is publicly readable while this process is running.');
  console.log('Press Ctrl-C to close and clean up.');

  await shutdownPromise;
}

main().catch((error) => {
  console.error(`serve-git: ${error.message}`);
  process.exitCode = 1;
});
