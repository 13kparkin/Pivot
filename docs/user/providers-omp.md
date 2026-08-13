# omp

Pivot drives [omp](https://omp.sh) over `omp --mode rpc`. omp is the only built-in agent backend.

## Install

1. Open **Settings → omp** and click **Install**. Pivot downloads a managed omp binary into the T3 home (`tools/omp/`), then downloads managed [rtk](https://github.com/rtk-ai/rtk) into `tools/rtk/` and runs `rtk init -g --agent omp` so bash rewrite hooks are active for omp.
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

Thread rollback uses omp session branching (`get_branch_messages` + `branch`). Context usage in the existing meter comes from omp `get_state` / `get_session_stats`.
