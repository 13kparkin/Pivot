# omp

Pivot drives [omp](https://omp.sh) over `omp --mode rpc`. omp is the only built-in agent backend.

## Install

1. Open **Settings → omp** and click **Install** to download a managed omp binary into the T3 home (`tools/omp/`), or install the `omp` CLI yourself and set **Binary path**.
2. Authenticate omp for the models you use (Settings → omp accounts, or `omp login` on the server host).
3. Optional token savings: install [rtk](https://github.com/rtk-ai/rtk) on that same PATH, then install the omp plugin for the omp user the server uses:

```bash
omp plugin install github:authrequest/pi-rtk
```

With `rtk` present, agent bash calls can be rewritten via `rtk rewrite`. If `rtk` is missing, commands still run as written.

## Settings

| Field        | Purpose                                            |
| ------------ | -------------------------------------------------- |
| Binary path  | Path to `omp` when it is not on PATH               |
| omp accounts | List omp login providers and start OAuth/API login |

Model lists come from omp (`get_available_models`), not from a hardcoded catalog in Pivot.

Login runs on the machine hosting the T3 server (browser opens there; OAuth callbacks stay there). You can also sign in from a terminal on that host with `omp login`.
