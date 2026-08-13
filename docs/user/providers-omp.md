# omp

Pivot drives [omp](https://omp.sh) over `omp --mode rpc`. omp is the only built-in agent backend.

## Install

1. Open **Settings → omp** and click **Install**. Pivot downloads a managed omp binary into the T3 home (`tools/omp/`), then downloads managed [rtk](https://github.com/rtk-ai/rtk) into `tools/rtk/` and runs `rtk init -g --agent omp` so bash rewrite hooks are active for omp.
2. Authenticate omp for the models you use (Settings → omp accounts, or `omp login` on the server host).

When Pivot detects that managed omp **or** managed rtk is behind the latest GitHub release, Settings shows the same Update action. Updating refreshes both binaries and re-runs the omp hook init.

You can still point **Binary path** at your own `omp`. In that case Pivot does not manage rtk for you.

Unsupported hosts (for example linux musl on arm64 for rtk) fail Install with a clear error.

## Settings

| Field        | Purpose                                            |
| ------------ | -------------------------------------------------- |
| Binary path  | Path to `omp` when it is not on PATH               |
| omp accounts | List omp login providers and start OAuth/API login |

Model lists come from omp (`get_available_models`), not from a hardcoded catalog in Pivot.

Login runs on the machine hosting the T3 server (browser opens there; OAuth callbacks stay there). You can also sign in from a terminal on that host with `omp login`.
