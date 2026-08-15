# Install Pivot

Pivot is a web and desktop GUI for running coding agents on your machine.

## Requirements

Node.js `^22.16 || ^23.11 || >=24.10` on the machine that runs the Pivot server.

The [omp](https://omp.sh) CLI, installed and authenticated. See [omp](./providers-omp.md).

## Run Without Installing

```bash
npx pivot-cli@latest
```

This starts the Pivot server on your machine and opens the local web app. Use
`npx pivot-cli@latest --help` for the full CLI reference.

## Desktop App

Download the latest release from
[GitHub Releases](https://github.com/13kparkin/Pivot/releases).

Pivot is not published to winget, Homebrew, or the AUR yet — GitHub Releases is the
desktop distribution channel.

## Providers

Pivot drives omp; it does not ship the CLI. Install omp on the server host, then authenticate it.

| Provider | CLI                   | Default binary | Notes                                                                                                         |
| -------- | --------------------- | -------------- | ------------------------------------------------------------------------------------------------------------- |
| omp      | [omp](https://omp.sh) | `omp`          | Required. Settings → Install also ships managed [rtk](https://github.com/rtk-ai/rtk) and activates omp hooks. |

Run omp login on the machine running the Pivot server, not on the device you browse from.

### Binary Discovery

`omp` must be on the server's `PATH`, or have an explicit binary path set in
**Settings** → omp → **Binary path**. Use the explicit path when a version
manager or a non-standard install location keeps the CLI off the `PATH` of the shell that
started Pivot.

### When Auth Is Needed

omp auth is required before you start a session, not before you start Pivot. You can install
Pivot, open it, and finish omp setup afterwards. See [omp](./providers-omp.md).

## Next Steps

- [Remote access](./remote-access.md)
- [Permission modes](./permission-modes.md)
- [Source control](./source-control.md)
