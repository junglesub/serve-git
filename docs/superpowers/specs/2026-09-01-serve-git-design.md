# serve-git Design

## Goal

Provide a reusable npm CLI that turns the current local Git repository into a temporary read-only HTTPS Git remote with one command, prints the clone/fetch URL, and removes all temporary resources when the process exits.

## User experience

Primary command after publication:

```bash
npx serve-git
```

Optional branch selection:

```bash
npx serve-git --branch main
```

Expected output:

```text
Creating temporary read-only Git tunnel...
Repository: example
Branch: main
Commit: abc1234

Ready:
https://example.trycloudflare.com/example.git

Clone:
git clone https://example.trycloudflare.com/example.git

Press Ctrl-C to close and clean up.
```

`Ctrl-C`, SIGTERM, normal completion after an internal failure, or an uncaught error must terminate child processes and remove the temporary bare repository and any downloaded `cloudflared` binary owned by this invocation.

## Scope

Version 1 does only the following:

- detect the Git repository containing the current working directory
- select the current branch by default, or accept `--branch <name>`
- make a disposable bare clone under the operating system temporary directory
- run `git update-server-info`
- serve that bare repository over a localhost-only Node HTTP server
- use an existing `cloudflared` on PATH when available, otherwise download a matching Linux or macOS binary into the invocation temp directory
- start a Cloudflare Quick Tunnel and parse its `trycloudflare.com` URL
- print a Git clone URL
- remain alive until interrupted
- clean up on SIGINT and SIGTERM

Version 1 does not add authentication, write/push support, permanent tunnels, a daemon mode, configuration files, telemetry, or dependencies on third-party npm packages.

## Architecture

`bin/serve-git.mjs` is the executable entry point. It parses minimal CLI arguments, calls the core orchestration function, prints user-facing status, installs signal handlers, and owns process lifetime.

`src/core.mjs` contains testable operations for repository discovery, branch validation, temporary bare clone creation, static HTTP serving, Cloudflare binary selection/download, Quick Tunnel startup, URL parsing, and cleanup. Node built-ins and the local `git` executable are the only required runtime dependencies.

## Temporary resource layout

Each invocation creates one unique directory using `fs.mkdtemp()` under `os.tmpdir()`:

```text
/tmp/serve-git-XXXXXX/
  repo.git/
  cloudflared        # only when downloaded by this invocation
```

The HTTP server serves only `repo.git`. It binds to `127.0.0.1` on an automatically assigned free port.

## Read-only model

The HTTP server is a static file server. It never invokes `git-http-backend`, `git-receive-pack`, SSH, or a writable Git protocol. `git update-server-info` enables Git dumb HTTP clone/fetch behavior only.

The public URL is unguessable but not authenticated. Anyone who obtains it while the process is running can read the repository history. The CLI must display a warning explaining this.

## Cloudflare binary behavior

Resolution order:

1. If `SERVE_GIT_CLOUDFLARED` is set, use that executable path. This supports deterministic testing and advanced users.
2. If `cloudflared` exists on PATH, use it without deleting it during cleanup.
3. Otherwise download the platform-appropriate binary from the latest Cloudflare GitHub release into the invocation temp directory and make it executable.

Supported download targets in version 1:

- Linux x64
- Linux arm64
- macOS x64
- macOS arm64

Unsupported platforms fail with a clear error and leave no temporary resources.

## Error handling

Before creating external resources, validate that `git` is available, the current directory belongs to a Git worktree, and the selected branch resolves to a commit.

Once temporary resources exist, every failure goes through one idempotent cleanup routine. Child process exit before a tunnel URL is obtained is treated as an error. A tunnel startup timeout prevents hanging forever.

## Testing

Use Node's built-in `node:test` runner with no test dependency.

Unit tests cover argument parsing, tunnel URL parsing, asset selection, safe URL-to-file mapping, and branch/repository metadata helpers where practical.

Integration tests create a temporary Git repository and verify that the generated bare repository can be cloned from the localhost HTTP server. A fake `cloudflared` executable verifies URL parsing and lifecycle without requiring external network access.

A manual smoke test may use the real Cloudflare Quick Tunnel after automated tests pass.


## Crash recovery

Each invocation writes an atomic `session.json` manifest containing the owner PID, `cloudflared` PID, executable path, localhost target URL, and creation time. The temporary directory name also contains the owner PID so a manifestless directory can be classified after a hard crash.

Before opening a new tunnel, and when invoked with `--cleanup`, the CLI scans `serve-git-*` directories. Sessions with a live owner are preserved. Sessions with a dead owner are removed. A surviving `cloudflared` child is terminated only if its current command line matches both the recorded executable and the recorded localhost `--url` target. PID equality alone is never sufficient to kill a process.
