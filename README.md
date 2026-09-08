# serve-git

Temporarily serve your current Git repository as a **read-only HTTPS remote** with one command.

```bash
npx serve-git
```

`serve-git` creates a disposable bare snapshot of your current branch, exposes it through a Cloudflare Quick Tunnel, keeps that snapshot updated when new commits land on the branch, and removes its temporary resources when you stop it.

It is useful when you need to move local commits from a remote machine without installing your personal SSH key or storing GitHub credentials on that machine.

## Quick start

Run inside any Git worktree:

```bash
npx serve-git
```

Example output:

```text
Creating temporary read-only Git tunnel...
Repository: my-project
Branch: main
Commit: abc1234

Ready:
https://random-name.trycloudflare.com/my-project.git

Clone:
git clone https://random-name.trycloudflare.com/my-project.git

Warning: the URL is publicly readable while this process is running.
Press Ctrl-C to close and clean up.
```

On another machine:

```bash
git clone https://random-name.trycloudflare.com/my-project.git
```

Or add it as a temporary remote:

```bash
git remote add temp https://random-name.trycloudflare.com/my-project.git
git fetch temp
```

When the transfer is complete, press `Ctrl-C` on the machine running `serve-git`.

While `serve-git` is running, new commits on the selected branch are detected automatically. The public URL stays the same, so clients only need to run `git fetch` again to receive the new commit. The watcher checks for branch changes every two seconds.

## Common commands

Serve the current branch:

```bash
npx serve-git
```

Serve a specific branch:

```bash
npx serve-git --branch main
```

Remove stale sessions without starting a new tunnel:

```bash
npx serve-git --cleanup
```

Show help:

```bash
npx serve-git --help
```

## How it works

`serve-git` keeps the implementation intentionally small:

1. Detects the Git worktree containing the current directory.
2. Resolves the current branch, or the branch passed with `--branch`.
3. Creates a disposable single-branch bare snapshot in the system temp directory.
4. Expands the snapshot's packed objects into loose Git objects for broad dumb-HTTP client compatibility, including Apple Git.
5. Runs `git update-server-info` so the snapshot can be fetched over static HTTP.
6. Starts a Node.js HTTP server bound only to `127.0.0.1` on a random free port.
7. Reuses `cloudflared` from `PATH`, or downloads a temporary binary when necessary.
8. Opens a Cloudflare Quick Tunnel and prints the public Git URL.
9. Cleans up the tunnel, local server, bare snapshot, and invocation-owned files when the process stops.

There are **no third-party npm runtime dependencies**.

## Read-only by design

The local HTTP server only serves static Git files. It does not run:

- `git-http-backend`
- `git-receive-pack`
- an SSH server
- any writable Git transport

Clients can clone and fetch, but they cannot push through the generated URL.

This makes `serve-git` suitable for temporary one-way transfer of Git history.

## Crash recovery

Normal shutdown is not the only cleanup mechanism.

Each invocation creates a temporary session directory and writes a small `session.json` manifest containing the owner process ID, the `cloudflared` process ID, the exact executable path, the local tunnel target, and the creation time.

If the CLI is terminated with `SIGKILL`, the terminal disappears, the machine loses power, or ordinary cleanup cannot run, a later invocation automatically scans previous `serve-git-*` sessions before opening a new tunnel.

A stale session is removed only after its owner process is confirmed dead. If an orphaned `cloudflared` process is still running, `serve-git` terminates it only when the live command line matches both the executable and local URL recorded in the manifest. PID equality by itself is never considered sufficient, which protects unrelated processes from PID reuse.

The owner PID is also encoded in the temporary directory name, so a directory can still be recovered if the process dies before its manifest is fully created. Manifest writes use an atomic rename to avoid leaving a partially written final manifest.

You can run the same scavenger manually:

```bash
npx serve-git --cleanup
```

Active sessions are left untouched.

## Security

The generated `trycloudflare.com` URL is temporary, but it is **not authenticated**. Anyone who obtains the URL while the tunnel is active can read the exposed branch history.

The snapshot is created with `--single-branch` and `--no-local`, so unrelated refs are not intentionally published through the temporary repository. However, the selected branch's complete reachable Git history is available to clients.

Use `serve-git` only when that history is safe to expose through a temporary public URL, and stop the process as soon as the transfer is complete.

## Requirements

- Node.js 20 or newer
- Git
- Internet access to Cloudflare
- Internet access to GitHub Releases when `cloudflared` is not already installed

Automatic `cloudflared` download currently supports:

- Linux x64
- Linux arm64
- macOS x64
- macOS arm64

## Using an existing cloudflared

If `cloudflared` is already available on `PATH`, `serve-git` reuses it and never deletes it.

You can also select an executable explicitly:

```bash
SERVE_GIT_CLOUDFLARED=/path/to/cloudflared npx serve-git
```

This is also useful for deterministic testing.

## Development

Clone the repository and run:

```bash
npm test
npm pack --dry-run
```

The test suite covers localhost Git cloning, signal cleanup, startup interruption, stale-session cleanup, PID safety checks, and recovery after the parent process is forcibly killed.

## License

MIT

## Automated releases

Releases are managed by [release-please](https://github.com/googleapis/release-please).

On every pull request and push to `main`, GitHub Actions runs the test suite and verifies the npm package on Node.js 20, 22, and 24.

On `main`, release-please reads Conventional Commit messages and maintains a release pull request automatically. When that release pull request is merged, it updates `package.json`, updates `CHANGELOG.md`, creates the matching GitHub tag and release, and publishes the package to npm.

Typical commit prefixes are:

```text
fix: handle an edge case       -> patch release
feat: add a new option         -> minor release
feat!: change CLI behavior     -> major release
```

A `BREAKING CHANGE:` footer also triggers a major version bump.

### npm Trusted Publishing setup

The publish job uses npm Trusted Publishing with GitHub Actions OIDC, so no long-lived npm write token is required in GitHub Secrets.

Trusted Publishing can only be configured after the npm package already exists. For the initial bootstrap:

1. Create the GitHub repository and push this project.
2. Publish the initial version once with your normal npm account credentials:

   ```bash
   npm publish
   ```

3. In npm package settings for `serve-git`, add a GitHub Actions trusted publisher for the GitHub repository and set the workflow filename to `ci-release.yml`.
4. Explicitly allow the trusted publisher to perform `npm publish`.

The release workflow derives the exact repository URL from GitHub's `GITHUB_REPOSITORY` value and injects it into the package metadata immediately before publishing. This avoids hard-coding an owner or repository name while satisfying npm's repository matching requirement.

After that bootstrap, releases are automatic. Merge normal Conventional Commit changes into `main`, then merge the release-please PR when you are ready to publish the proposed version.

The release job uses Node.js 24 and npm's OIDC authentication. npm automatically attaches provenance for eligible public packages published through Trusted Publishing.
