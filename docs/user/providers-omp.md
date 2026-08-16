# omp

Pivot drives [omp](https://omp.sh) over `omp --mode rpc-ui`. omp is the only built-in agent backend.

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

Login runs on the machine hosting the Pivot server (browser opens there; OAuth callbacks stay there). You can also sign in from a terminal on that host with `omp login`.

When omp asks for a confirmation, a paste code, a proposed host-URI edit, or a choice (including login paste prompts), Pivot shows the existing approval / user-input panels in the composer. Your answer is sent back to omp over RPC (`extension_ui_response` or `host_uri_result`).

omp's built-in `ask` tool renders its questions in those same user-input panels (selects and inputs); your answer returns over `extension_ui_response` and the turn continues. Cancelling the question (or stopping the turn) settles it cleanly — omp resolves the ask and the turn is not left hanging. Pivot spawns omp in `rpc-ui` mode so the `ask` tool is available; a user-supplied omp binary too old for `rpc-ui` fails thread startup with an upgrade error instead of silently losing the capability.

Type `/` in the composer to see omp slash commands (from `get_available_commands`), such as `/model`, `/review`, or `/jobs`. Choosing one inserts the command into the prompt. Local commands that omp handles without starting an agent turn (for example `/jobs`) show their result in the chat.

When **Plan mode** is enabled in Settings, omp threads show the plan/default toggle. Turning plan on switches the session model to the `plan` role from omp’s `~/.omp/agent/config.yml` (`modelRoles.plan`). Turning it off restores the previous model. Add a `plan` role there if the toggle should change models (without it, the toggle still tracks mode but leaves the model unchanged).

When omp spawns subagents, open **Agents** to browse runs and their agent conversations. Web and desktop show a virtualized tree beside the chat; mobile opens **Main → Agent runs → Agent** as full-screen native views. Selecting an agent replaces the main transcript with that agent's messages and tool activity, with a breadcrumb back through any parent agents. Agent conversations are read-only because current omp RPC releases do not expose agent-targeted message, revive, cancel, or kill commands. Use the main conversation to send guidance to the active turn. **Stop** always aborts the active turn and every agent running under it; Pivot confirms that session-wide scope before stopping. Agent conversations remain part of the same Pivot thread.

While a turn is running, **Send** becomes **Queue**: your follow-up is held until the turn finishes successfully, then sent automatically. **Stop** aborts the active turn and waits until omp confirms the stop (Stopping… → Stopped). Stopping does not auto-send queued follow-ups; they stay until you send again or a later turn completes normally.

Thread rollback uses omp session branching (`get_branch_messages` + `branch`). The context meter updates live from omp `get_state` / `get_session_stats` (including throughput and session duration when omp reports them). The **Usage** page shows live plan limits from `omp usage` (used/remaining per upstream provider such as Codex) and aggregates on-disk omp session history (`~/.omp/agent/sessions`) for token cost.

## Capabilities (omp config surface)

The **Capabilities** page (sidebar entry below the current project) is a
read-only-at-a-glance + editable view of omp's own configuration — the same
files and CLI that omp itself manages, surfaced in the app. It is omp-only by
design: Pivot renders and edits omp's config, never a parallel copy.

Every project row in the sidebar has a gear that opens the same page scoped
to that project (web, desktop, and mobile). The project's settings view
shows every known setting with where it currently comes from: **Global**
settings can be moved into the project with one click (the current value is
copied into the project's `.omp/config.yml`), and **Project** settings are
edited in place. Skills and rules show only that project's own items, named
by project. The global entry without a project shows the global surface.

- **Overview** lists the discovered capability resources (config, models,
  skills, commands, rules, prompts, instructions, hooks, tools, extensions,
  MCP servers, env) with their scope (global vs project) and provenance
  (global / project / profile). The active agent directory is resolved from
  the server host via `omp config path`, so profiles, `PI_CODING_AGENT_DIR`,
  `PI_CONFIG_DIR`, and XDG relocation are honored automatically.
- **Settings** shows the effective omp settings (`omp config list --json`):
  key, type, description, current value. Search filters the list by key,
  type, or description. In a project's view, every setting is tagged by
  origin — **Global** entries offer **Move to project**, which copies the
  current value into the project's `.omp/config.yml`; **Project** entries are
  edited in place. Secret-typed keys (tokens, keys, passwords) are masked and
  write-only — their values are managed through omp's own auth/config
  commands, never edited here.
- **Skills** and **Rules**: the global view lists the omp agent-directory
  items alongside every project's own items, each project item labeled with
  its project name; a project's view lists only that project's own items. You
  can create, edit, and delete them directly: skills are
  `<name>/SKILL.md` files invoked on demand; rules are `<name>.md` files
  loaded into every session. A project rule with the same name as a global
  rule shadows it. New files start from a frontmatter template. Skills
  discovered from other CLI skill directories (e.g. `~/.cursor/skills`) are
  shown with their origin and can be moved into the omp agent directory where
  Pivot manages them.
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
