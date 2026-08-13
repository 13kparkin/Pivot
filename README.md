# Pivot

**T3.14 — [T3 Code](https://github.com/pingdotgg/t3code), pivoted to omp (π).**

Pivot is a fork of T3 Code: an agent harness control surface (desktop, web, and remote clients) with a Node WebSocket server on your machine. Upstream talks to several provider CLIs. This fork talks to one: [omp](https://omp.sh) (oh-my-pi) over `omp --mode rpc`.

CLI package: [`pivot-cli`](https://www.npmjs.com/package/pivot-cli) (bin: `pivot`). Desktop builds publish from [this repo’s Releases](https://github.com/13kparkin/Pivot/releases).

## What changed from T3 Code

- **omp only** — no Codex / Claude / Cursor / Grok / OpenCode adapters
- Managed omp install and Settings login for omp accounts
- Published as `pivot-cli` instead of `t3`

Credit for the architecture, clients, and product taste goes to the T3 Code maintainers. Pivot is an independent fork.

## Installation

> [!WARNING]
> You need [omp](https://omp.sh) available to the server. Settings → omp → Install downloads managed omp + [rtk](https://github.com/rtk-ai/rtk) and activates omp rewrite hooks. Then authenticate for the models you use. See [omp setup](./docs/user/providers-omp.md).

### Try it out (install-free)

Requires Node.js 22.16+, 23.11+, or 24.10+:

```bash
npx pivot-cli@latest
```

That starts the Pivot server and local web UI. Tip: `npx pivot-cli@latest --help`.

### Desktop app

Install from [GitHub Releases](https://github.com/13kparkin/Pivot/releases) (stable and nightly channels when those builds succeed).

## Notes

Very early. Expect bugs.

This is a personal fork. Upstream contribution rules and Discord belong to T3 Code; use them for upstream issues. For Pivot-specific work, open issues on this repo.

## Documentation

Docs live in [docs/](./docs). There is no separate docs site yet.

- [Install and first run](./docs/user/install.md)
- [omp provider](./docs/user/providers-omp.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Customize a project icon](./docs/user/project-settings.md)
- [Remote access](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Linux: [background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## Building from source

### Install `vp`

Pivot uses Vite+ (`vp`):

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Guide: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for upstream-oriented contributor notes; treat Pivot-specific PRs as fork work unless aimed at upstream.
