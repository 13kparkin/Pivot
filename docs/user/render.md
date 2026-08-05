# Deploy a Cloud Environment on Render

This experimental setup runs one T3 Code environment as a Render web service. The environment owns
the provider processes, repositories, worktrees, terminals, and T3 Code state. The web, desktop, and
mobile clients connect to it over Render's public HTTPS and WebSocket endpoint.

This is a demo environment, not a multi-tenant hosted service. The attached persistent disk limits
the service to one instance. Multiple agent threads can still run concurrently inside that instance.

## What the Blueprint Creates

The root [`render.yaml`](../../render.yaml) creates:

- a Docker web service containing T3 Code, Codex, Claude Code, Git, and the GitHub CLI;
- a persistent disk mounted at `/data` for T3 Code state, provider credentials, and workspaces;
- a health check against T3 Code's public environment descriptor.

## Deploy

1. In the Render Dashboard, choose **New → Blueprint**.
2. Connect this repository and select the branch you want to deploy.
3. Deploy the Blueprint and wait for the service health check to pass.
4. Open the service logs and copy the `Pair URL` printed during startup. Treat this URL like a
   password: it contains a one-time pairing credential.
5. Open the URL in a browser, or paste it under **Settings → Cloud environments → Pair URL**.
6. Authenticate Codex as described below.
7. Open the Command Palette and choose **Add Project → Cloud environments → Render cloud
   environment**. Paste a public GitHub URL. T3 Code clones it directly into the Render workspace;
   there is no local destination picker.

Repositories are selected after pairing rather than baked into the Blueprint. Each clone is stored
under `/data/workspace` and survives deploys. This keeps the public deployment configuration generic
and lets each user bring repositories they already have access to.

The Render service advertises cloud metadata in its normal T3 environment descriptor. That is what
lets clients present it as a cloud device and automatically route project cloning to its persistent
workspace while leaving the existing local-device folder flow unchanged.

The demo Blueprint is pinned to `feat/render-cloud-environment` so it can deploy before the draft
pull request is merged. Update the `branch` field in `render.yaml` if you rename or reuse the branch.

## Provider Authentication

The Blueprint does not ask for an OpenAI API key. To use a ChatGPT subscription, open a Render Shell
and run:

```sh
codex login --device-auth
```

Follow the printed link and enter the device code. `CODEX_HOME` points at the persistent disk, so the
provider session survives service restarts. Claude Code is installed too; use its normal subscription
login flow from a Render Shell. `CLAUDE_CONFIG_DIR` is persisted as well.

## T3 Connect

T3 Connect is not required for this deployment. Render already gives the environment a public HTTPS
and WebSocket endpoint, so the Pair URL registers it as a direct remote environment. Use its existing
Connect and Disconnect controls under **Settings → Cloud environments**. T3 Connect remains useful for
machines that need its managed tunnel or account-level environment discovery.

## Operations

- Each deploy prints a fresh pairing URL with a 24-hour lifetime. Existing paired browser sessions
  remain authenticated until revoked with `t3 auth`.
- Render terminates the previous instance before starting a new one because the service has a disk.
  Expect a short interruption during deploys.
- Do not use this Blueprint for untrusted users or repositories. Coding agents can execute commands
  and access every secret available to the service.
