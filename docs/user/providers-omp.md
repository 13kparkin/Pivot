# omp

Pivot drives [omp](https://omp.sh) over `omp --mode rpc`. omp is the only built-in agent backend.

## Install

1. Open **Settings → omp** and click **Install**. Pivot downloads a managed omp binary into the T3 home (`tools/omp/`), then downloads managed [rtk](https://github.com/rtk-ai/rtk) into `tools/rtk/` and runs `rtk init -g --agent pi` so bash rewrite hooks are active for omp.
2. Authenticate omp for the models you use (Settings → omp accounts, or `omp login` on the server host).

When Pivot detects that managed omp **or** managed rtk is behind the latest GitHub release, Settings shows the same Update action. Updating refreshes both binaries and re-runs the omp hook init.

You can still point **Binary path** at your own `omp`. In that case Pivot does not manage rtk for you.

Unsupported hosts (for example linux musl on arm64 for rtk) fail Install with a clear error.

## Settings

| Field                                         | Purpose                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| Binary path                                   | Path to `omp` when it is not on PATH                                      |
| omp accounts                                  | List omp login providers and start OAuth/API login                        |
| Role models (`default`, `plan`, `advisor`, …) | Writes `modelRoles` in omp’s `~/.omp/agent/config.yml` on the server host |
| Auto compaction / auto retry                  | Persists omp compaction and retry preferences                             |
| Advisor / memory / tool gates                 | Persists advisor enablement, memory backend, and tool gates in omp config |

Model lists come from omp (`get_available_models`), not from a hardcoded catalog in Pivot. omp models expose **Thinking** and **Fast mode** controls in the composer when the model supports them.

Login runs on the machine hosting the T3 server (browser opens there; OAuth callbacks stay there). You can also sign in from a terminal on that host with `omp login`.

When omp asks for a confirmation, a paste code, a proposed host-URI edit, or a choice (including login paste prompts), Pivot shows the existing approval / user-input panels in the composer. Your answer is sent back to omp over RPC (`extension_ui_response` or `host_uri_result`).

Type `/` in the composer to see omp slash commands (from `get_available_commands`), such as `/model`, `/review`, or `/jobs`. Choosing one inserts the command into the prompt. Local commands that omp handles without starting an agent turn (for example `/jobs`) show their result in the chat.

When **Plan mode** is enabled in Settings, omp threads show the plan/default toggle. Turning plan on switches the session model to the `plan` role from omp’s `~/.omp/agent/config.yml` (`modelRoles.plan`). Turning it off restores the previous model. Add a `plan` role there if the toggle should change models (without it, the toggle still tracks mode but leaves the model unchanged).

When omp spawns subagents, open the **Agents** panel and click an agent to view its nested transcript (read-only). From that pane you can **Steer** the parent session or **Stop** (abort) the active turn. This does not create a separate Pivot thread.

While a turn is running, **Send** becomes **Queue**: your follow-up is held until the turn finishes successfully, then sent automatically. **Stop** aborts the active turn and waits until omp confirms the stop (Stopping… → Stopped). Stopping does not auto-send queued follow-ups; they stay until you send again or a later turn completes normally.

Thread rollback uses omp session branching (`get_branch_messages` + `branch`). The context meter updates live from omp `get_state` / `get_session_stats` (including throughput and session duration when omp reports them). The **Usage** page shows live plan limits from `omp usage` (used/remaining per upstream provider such as Codex) and aggregates on-disk omp session history (`~/.omp/agent/sessions`) for token cost.

## Capabilities (omp config surface)

The **Capabilities** page (sidebar entry below the current project) is a
read-only-at-a-glance + editable view of omp's own configuration — the same
files and CLI that omp itself manages, surfaced in the app. It is omp-only by
design: Pivot renders and edits omp's config, never a parallel copy.

Every project row in the sidebar has a gear that opens the same page scoped
to that project (web, desktop, and mobile). The overview, settings, skills,
and rules then show that project's `.omp` items alongside the global ones,
and project-scoped edits write to that project's `.omp` folder. The global
entry without a project still behaves as before.

- **Overview** lists the discovered capability resources (config, models,
  skills, commands, rules, prompts, instructions, hooks, tools, extensions,
  MCP servers, env) with their scope (global vs project) and provenance
  (global / project / profile). The active agent directory is resolved from
  the server host via `omp config path`, so profiles, `PI_CODING_AGENT_DIR`,
  `PI_CONFIG_DIR`, and XDG relocation are honored automatically.
- **Settings** shows the effective omp settings (`omp config list --json`):
  key, type, description, current value. Search filters the list by key,
  type, or description. Secret-typed keys (tokens, keys, passwords) are
  masked and write-only — their values are managed through omp's own
  auth/config commands, never edited here.
- **Skills** and **Rules** list every skill and rule — global (omp agent
  directory) and project (`.omp` folder) — in one place, with search. You
  can create, edit, and delete them directly: skills are `<name>/SKILL.md`
  files invoked on demand; rules are `<name>.md` files loaded into every
  session. A project rule with the same name as a global rule shadows it
  (marked "Overrides global" in the list). New files start from a
  frontmatter template.
- Edits are scope-aware: **Global** writes run `omp config set` on the server
  host; **Project** writes merge into the project's `.omp/config.yml`
  (comments and unknown keys are preserved) after a timestamped `.bak`
  backup. Skill and rule files are written atomically; project-scoped
  overwrites and deletes take a timestamped `.bak` first. A precedence
  ladder (defaults ← global ← project ← overlays ← runtime) is shown so you
  can see which layer wins.
- Destructive actions (resetting a setting to its default, deleting a skill
  or rule) ask for confirmation before they run.

Later phases add models & providers, roles, MCP servers, packages/plugins,
auth, and themes to the same page.
