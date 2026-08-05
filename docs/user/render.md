# Deploy a Cloud Environment on Render

This experimental setup runs one T3 Code environment as a Render web service. The environment owns
the provider processes, repositories, worktrees, terminals, and T3 Code state. The web, desktop, and
mobile clients connect to it over Render's public HTTPS and WebSocket endpoint.

This is an ephemeral, one-session demo environment, not a multi-tenant hosted service. The Free
instance can run multiple agent threads, but loses its files and authentication when it restarts or
spins down.

## What the Blueprint Creates

The root [`render.yaml`](../../render.yaml) creates:

- a Docker web service containing T3 Code, Codex, Claude Code, Git, and the GitHub CLI;
- an ephemeral `/data` workspace for T3 Code state, provider credentials, and repositories;
- a health check against T3 Code's public environment descriptor.

## Deploy

1. In the Render Dashboard, choose **New → Blueprint**.
2. Connect this repository and select the branch you want to deploy.
3. Deploy the Blueprint and wait for the service health check to pass.
4. Open the service logs and copy the `Pair URL` printed during startup. Treat this URL like a
   password: it contains a one-time pairing credential.
5. Open the URL in a browser, or paste it under **Settings → Cloud environments → Pair URL**.
6. Open the Command Palette and choose **Add Project → Cloud environments → Render cloud
   environment**. Paste a public GitHub URL. T3 Code clones it directly into the Render workspace;
   there is no local destination picker.
7. Open the project terminal, run `codex login --device-auth`, complete the device login, and start
   an agent.

Repositories are selected after pairing rather than baked into the Blueprint. Each clone is stored
under `/data/workspace` for the current Free-instance session.

The Render service advertises cloud metadata in its normal T3 environment descriptor. That is what
lets clients present it as a cloud device and automatically route project cloning to its cloud
workspace while leaving the existing local-device folder flow unchanged.

The demo Blueprint is pinned to `feat/render-cloud-environment` so it can deploy before the draft
pull request is merged. Update the `branch` field in `render.yaml` if you rename or reuse the branch.

## Provider Authentication

The Blueprint does not ask for an OpenAI API key. Free instances do not include Render Shell access,
so clone a public project, open its T3 Code terminal, and run:

```sh
codex login --device-auth
```

Follow the printed link and enter the device code. The login lasts for the current Free-instance
session and is lost if Render restarts or spins down the service.

## T3 Connect

T3 Connect is not required for this deployment. Render already gives the environment a public HTTPS
and WebSocket endpoint, so the Pair URL registers it as a direct remote environment. Use its existing
Connect and Disconnect controls under **Settings → Cloud environments**. T3 Connect remains useful for
machines that need its managed tunnel or account-level environment discovery.

## Operations

- Each deploy prints a fresh pairing URL with a 24-hour lifetime. Existing paired browser sessions
  remain authenticated until revoked with `t3 auth`.
- Render spins a Free web service down after 15 minutes without inbound HTTP or WebSocket traffic.
  A later request starts a fresh instance, so pair, clone, and authenticate again.
- Do not use this Blueprint for untrusted users or repositories. Coding agents can execute commands
  and access every secret available to the service.
