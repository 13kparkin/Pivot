# Deploy a Cloud Environment on Render

This experimental setup runs one T3 Code environment as a Render web service. The environment owns
the provider processes, repositories, worktrees, terminals, and T3 Code state. The web, desktop, and
mobile clients connect to it over Render's public HTTPS and WebSocket endpoint.

This is a single-user deployment, not a multi-tenant hosted service. The attached persistent disk
also limits the service to one instance. Multiple agent threads can still run concurrently inside
that instance.

## What the Blueprint Creates

The root [`render.yaml`](../../render.yaml) creates:

- a Docker web service containing T3 Code, Codex, Claude Code, Git, and the GitHub CLI;
- a persistent disk mounted at `/data` for T3 Code state, provider credentials, and workspaces;
- a health check against T3 Code's public environment descriptor; and
- a five-minute shutdown window so active agent processes have time to stop cleanly.

## Deploy

1. In the Render Dashboard, choose **New → Blueprint**.
2. Connect this repository and select the branch you want to deploy.
3. Provide `OPENAI_API_KEY` and `GH_TOKEN` when Render prompts for secret environment variables.
   `GH_TOKEN` needs access to any private repositories the environment will clone and permission to
   push branches or open pull requests for the demo repository.
4. Deploy the Blueprint and wait for the service health check to pass.
5. Open the service logs and copy the `Pair URL` printed during startup. Treat this URL like a
   password: it contains a one-time pairing credential.
6. Open the URL in a browser. T3 Code pairs the browser with the Render-hosted environment and opens
   the repository configured by `T3CODE_PROJECT_REPO`.

The default repository is T3 Code itself. Change `T3CODE_PROJECT_REPO`, and optionally
`T3CODE_PROJECT_BRANCH`, in the service environment settings to use another repository. The clone is
stored under `/data/workspace/project` and survives deploys.

The demo Blueprint is pinned to `feat/render-cloud-environment` so it can deploy before the draft
pull request is merged. Update the `branch` field in `render.yaml` if you rename or reuse the branch.

## Provider Authentication

When `OPENAI_API_KEY` is set, the startup script initializes Codex on the persistent disk before T3
Code starts. Claude Code is installed too; set `ANTHROPIC_API_KEY` in the Render Dashboard to use it.

For subscription authentication instead of an API key, open a Render Shell and run the provider's
normal login command. `CODEX_HOME` and `CLAUDE_CONFIG_DIR` already point at the persistent disk, so
the resulting provider session survives service restarts.

## Operations

- Each deploy prints a fresh pairing URL with a 24-hour lifetime. Existing paired browser sessions
  remain authenticated until revoked with `t3 auth`.
- Render terminates the previous instance before starting a new one because the service has a disk.
  Expect a short interruption during deploys.
- Do not use this Blueprint for untrusted users or repositories. Coding agents can execute commands
  and access every secret available to the service.
