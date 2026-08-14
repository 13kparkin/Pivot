# Running Pivot in the Background

On a Linux host, Pivot can run as a background service for your user. It starts when the machine
boots and keeps running after you log out.

## Manage the Service

Install it with the latest Pivot release:

```sh
npx pivot-cli@latest service install
```

Check whether it is installed:

```sh
npx pivot-cli@latest service status
```

Update or repair it:

```sh
npx pivot-cli@latest service update
```

Stop it and remove it from startup:

```sh
npx pivot-cli@latest service uninstall
```

Updating restarts Pivot briefly. Let active agent work and terminal commands finish first.
If a remote update is already in progress, wait for it to finish before retrying a local update.

The systemd unit runs a small stable launcher. Exact Pivot versions are installed separately, so
a failed remote candidate can return to the previous version without rewriting the unit. The
launcher snapshots the database before a remote candidate starts, so database updates roll back
with the server version. An older launcher may require one local `service update` before this is
available.

## Using It with T3 Connect

T3 Connect may offer to install the service during setup so the host stays reachable after you log
out. This is only an onboarding shortcut: the service and T3 Connect are managed separately.

Signing out of T3 Connect does not remove the service. Use `pivot service uninstall` when you no longer
want Pivot to start in the background.

The background service currently requires Linux with systemd.
