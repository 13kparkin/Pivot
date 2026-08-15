/**
 * RtkManagedBinary — download rtk GitHub release archives into T3 home.
 *
 * Layout: `{baseDir}/tools/rtk/{version}/{platformKey}/rtk[.exe]`
 * Active binary: `{baseDir}/tools/rtk/current/rtk[.exe]` (atomic replace).
 *
 * @module provider/omp/RtkManagedBinary
 */
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { parseGenericCliVersion } from "../providerSnapshot.ts";
import { isLinuxMuslHost, normalizeReleaseVersion, platformKey } from "./OmpManagedBinary.ts";

export const RTK_GITHUB_REPO = "rtk-ai/rtk";
/** Cache key for ProviderVersionCache companion checks. */
export const RTK_VERSION_CACHE_KEY = "github:rtk-ai/rtk";
/**
 * Args for `rtk init` hook activation. rtk 0.45.0 renamed the Oh My Pi agent
 * value from `omp` to `pi`; keep in sync with rtk's `--agent` enum.
 */
export const RTK_OMP_HOOK_INIT_ARGS = ["init", "-g", "--agent", "pi"] as const;

const INSTALL_LOCK_RETRY_COUNT = 100;
const INSTALL_LOCK_RETRY_DELAY = "100 millis";
const INSTALL_LOCK_STALE_MS = 5 * 60 * 1_000;

export class RtkManagedBinaryError extends Data.TaggedError("RtkManagedBinaryError")<{
  readonly reason:
    | "download_failed"
    | "invalid_checksum"
    | "install_locked"
    | "unsupported_platform"
    | "validation_failed"
    | "write_failed";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type RtkManagedBinaryStatus =
  | {
      readonly status: "available";
      readonly executablePath: string;
      readonly version: string | null;
    }
  | {
      readonly status: "missing";
    }
  | {
      readonly status: "unsupported";
      readonly platform: NodeJS.Platform;
      readonly arch: string;
    };

export type AvailableRtkManagedBinary = Extract<
  RtkManagedBinaryStatus,
  { readonly status: "available" }
>;

const GithubReleaseAsset = Schema.Struct({
  name: Schema.String,
  browser_download_url: Schema.String,
});

const GithubRelease = Schema.Struct({
  tag_name: Schema.String,
  assets: Schema.Array(GithubReleaseAsset),
});

const decodeGithubRelease = Schema.decodeUnknownEffect(GithubRelease);

function isAlreadyExists(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "AlreadyExists";
}

function executableFileName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "rtk.exe" : "rtk";
}

/** Map host platform/arch to an rtk-ai/rtk release archive basename. */
export function resolveRtkReleaseAssetName(
  platform: NodeJS.Platform,
  arch: string,
  musl: boolean,
): string | null {
  if (platform === "darwin" && arch === "arm64") return "rtk-aarch64-apple-darwin.tar.gz";
  if (platform === "darwin" && (arch === "x64" || arch === "x86_64")) {
    return "rtk-x86_64-apple-darwin.tar.gz";
  }
  if (platform === "linux" && (arch === "x64" || arch === "x86_64")) {
    // Upstream ships musl for linux x64; it runs on glibc hosts too.
    return "rtk-x86_64-unknown-linux-musl.tar.gz";
  }
  if (platform === "linux" && arch === "arm64") {
    // No musl-arm64 asset upstream.
    return musl ? null : "rtk-aarch64-unknown-linux-gnu.tar.gz";
  }
  if (platform === "win32" && (arch === "x64" || arch === "x86_64")) {
    return "rtk-x86_64-pc-windows-msvc.zip";
  }
  return null;
}

export function parseRtkVersionOutput(output: string): string | null {
  return parseGenericCliVersion(output);
}

export function parseChecksumLine(checksumText: string, assetName: string): string | null {
  const expectedLine = checksumText
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .find((line) => line.endsWith(` ${assetName}`) || line.endsWith(` *${assetName}`));
  const expectedSha = expectedLine?.split(/\s+/)[0]?.toLowerCase();
  if (!expectedSha || expectedSha.length !== 64) {
    return null;
  }
  return expectedSha;
}

const wrapInstallFailure =
  (
    reason: RtkManagedBinaryError["reason"],
    message: string,
  ): (<E, R>(effect: Effect.Effect<void, E, R>) => Effect.Effect<void, RtkManagedBinaryError, R>) =>
  (effect) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new RtkManagedBinaryError({
            reason,
            message,
            cause,
          }),
      ),
    );

export interface RtkManagedBinaryOptions {
  readonly baseDir: string;
}

export interface RtkManagedBinaryApi {
  readonly resolve: Effect.Effect<RtkManagedBinaryStatus>;
  readonly install: Effect.Effect<AvailableRtkManagedBinary, RtkManagedBinaryError>;
  readonly fetchLatestReleaseVersion: Effect.Effect<string | null>;
  readonly activateOmpHook: Effect.Effect<void, RtkManagedBinaryError>;
  readonly currentBinDirectory: string;
}

export const makeRtkManagedBinary = Effect.fn("rtkManagedBinary.make")(function* (
  options: RtkManagedBinaryOptions,
): Effect.fn.Return<
  RtkManagedBinaryApi,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
> {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const installSemaphore = yield* Semaphore.make(1);
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const musl = isLinuxMuslHost(platform);
  const assetName = resolveRtkReleaseAssetName(platform, arch, musl);
  const exeName = executableFileName(platform);
  const currentBinDirectory = path.join(options.baseDir, "tools", "rtk", "current");
  const currentPath = path.join(currentBinDirectory, exeName);
  const toolsRoot = path.join(options.baseDir, "tools", "rtk");

  const isExecutableFile = Effect.fn("rtkManagedBinary.isExecutableFile")(function* (
    executablePath: string,
  ) {
    const info = yield* fileSystem.stat(executablePath).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return false;
    return platform === "win32" || (info.value.mode & 0o111) !== 0;
  });

  const withProcessScope = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      return yield* effect.pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      );
    });

  const probeVersion = (executablePath: string) =>
    withProcessScope(
      Effect.gen(function* () {
        const child = yield* spawner
          .spawn(
            ChildProcess.make(executablePath, ["--version"], {
              shell: false,
            }),
          )
          .pipe(Effect.orElseSucceed(() => null));
        if (!child) {
          return null;
        }
        const [output, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(
              Stream.decodeText(),
              Stream.runFold(
                () => "",
                (acc, chunk) => acc + chunk,
              ),
              Effect.orElseSucceed(() => ""),
            ),
            child.exitCode.pipe(
              Effect.map(Number),
              Effect.orElseSucceed(() => 1),
            ),
          ],
          { concurrency: "unbounded" },
        );
        if (exitCode !== 0) {
          return null;
        }
        return parseRtkVersionOutput(output);
      }),
    );

  const resolve: RtkManagedBinaryApi["resolve"] = Effect.gen(function* () {
    if (yield* isExecutableFile(currentPath)) {
      const version = yield* probeVersion(currentPath);
      return {
        status: "available",
        executablePath: currentPath,
        version,
      } satisfies RtkManagedBinaryStatus;
    }
    if (!assetName) {
      return {
        status: "unsupported",
        platform,
        arch,
      } satisfies RtkManagedBinaryStatus;
    }
    return { status: "missing" } satisfies RtkManagedBinaryStatus;
  });

  const fetchLatestRelease = Effect.fn("rtkManagedBinary.fetchLatestRelease")(function* () {
    const response = yield* httpClient
      .execute(
        HttpClientRequest.get(
          `https://api.github.com/repos/${RTK_GITHUB_REPO}/releases/latest`,
        ).pipe(
          HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
          HttpClientRequest.setHeader("user-agent", "pivot-cli-rtk-managed-binary"),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.mapError(
          (cause) =>
            new RtkManagedBinaryError({
              reason: "download_failed",
              message: "Could not fetch the latest rtk release metadata.",
              cause,
            }),
        ),
      );
    const payload = yield* response.json.pipe(
      Effect.flatMap(decodeGithubRelease),
      Effect.mapError(
        (cause) =>
          new RtkManagedBinaryError({
            reason: "download_failed",
            message: "Could not parse the latest rtk release metadata.",
            cause,
          }),
      ),
    );
    return payload;
  });

  const fetchLatestReleaseVersion: RtkManagedBinaryApi["fetchLatestReleaseVersion"] =
    fetchLatestRelease().pipe(
      Effect.map((release) => normalizeReleaseVersion(release.tag_name)),
      Effect.orElseSucceed(() => null),
    );

  const runCommand = Effect.fn("rtkManagedBinary.runCommand")(function* (
    command: string,
    args: ReadonlyArray<string>,
  ) {
    yield* withProcessScope(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(command, args, {
            shell: false,
            stdout: "ignore",
            stderr: "ignore",
          }),
        );
        const exitCode = Number(yield* child.exitCode);
        if (exitCode !== 0) {
          return yield* new RtkManagedBinaryError({
            reason: "validation_failed",
            message: `Command failed: ${command} (exit ${exitCode})`,
          });
        }
      }),
    );
  });

  const extractArchive = Effect.fn("rtkManagedBinary.extractArchive")(function* (
    archivePath: string,
    extractDirectory: string,
  ) {
    if (platform === "win32") {
      yield* runCommand("powershell", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${extractDirectory.replaceAll("'", "''")}' -Force`,
      ]).pipe(wrapInstallFailure("write_failed", "Could not extract the rtk zip archive."));
      return;
    }
    yield* runCommand("tar", ["-xzf", archivePath, "-C", extractDirectory]).pipe(
      wrapInstallFailure("write_failed", "Could not extract the rtk tar archive."),
    );
  });

  const findExtractedBinary = Effect.fn("rtkManagedBinary.findExtractedBinary")(function* (
    extractDirectory: string,
  ) {
    const direct = path.join(extractDirectory, exeName);
    if (yield* isExecutableFile(direct)) {
      return direct;
    }
    const entries = yield* fileSystem.readDirectory(extractDirectory).pipe(
      Effect.mapError(
        (cause) =>
          new RtkManagedBinaryError({
            reason: "write_failed",
            message: "Could not list the extracted rtk archive.",
            cause,
          }),
      ),
    );
    for (const entry of entries) {
      const candidate = path.join(extractDirectory, entry);
      const info = yield* fileSystem.stat(candidate).pipe(Effect.option);
      if (Option.isNone(info)) continue;
      if (
        info.value.type === "File" &&
        (entry === exeName || entry === "rtk" || entry === "rtk.exe")
      ) {
        return candidate;
      }
      if (info.value.type === "Directory") {
        const nested = path.join(candidate, exeName);
        if (yield* isExecutableFile(nested)) {
          return nested;
        }
      }
    }
    return yield* new RtkManagedBinaryError({
      reason: "validation_failed",
      message: `Extracted rtk archive did not contain ${exeName}.`,
    });
  });

  const acquireInstallLock = Effect.fn("rtkManagedBinary.acquireInstallLock")(function* (
    lockPath: string,
  ) {
    for (let attempt = 0; attempt < INSTALL_LOCK_RETRY_COUNT; attempt += 1) {
      const acquired = yield* fileSystem.writeFileString(lockPath, "", { flag: "wx" }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          isAlreadyExists(error) ? Effect.succeed(false) : Effect.fail(error),
        ),
      );
      if (acquired) return;

      const now = yield* Clock.currentTimeMillis;
      const lockInfo = yield* fileSystem.stat(lockPath).pipe(Effect.option);
      const mtime = Option.flatMap(lockInfo, (info) => info.mtime);
      if (Option.isSome(mtime) && now - mtime.value.getTime() > INSTALL_LOCK_STALE_MS) {
        yield* fileSystem.remove(lockPath, { force: true });
        continue;
      }
      yield* Effect.sleep(INSTALL_LOCK_RETRY_DELAY);
    }
    return yield* new RtkManagedBinaryError({
      reason: "install_locked",
      message: "Another rtk installation is still in progress.",
    });
  });

  const activateBinary = Effect.fn("rtkManagedBinary.activateBinary")(function* (
    versionedPath: string,
  ) {
    // `currentPath` is the binary live rtk sessions run from; overwriting it
    // in place with copyFile fails with ETXTBSY while any session is active.
    // Copy to a sibling temp and rename it over `currentPath`: rename replaces
    // the directory entry atomically and running processes keep the old inode.
    const publishTemp = `${currentPath}.${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}.tmp`;
    yield* fileSystem
      .copyFile(versionedPath, publishTemp)
      .pipe(wrapInstallFailure("write_failed", "Could not stage the managed rtk binary."));
    yield* fileSystem
      .rename(publishTemp, currentPath)
      .pipe(
        wrapInstallFailure("write_failed", "Could not activate the managed rtk binary."),
        Effect.ensuring(fileSystem.remove(publishTemp, { force: true }).pipe(Effect.ignore)),
      );
    if (platform !== "win32") {
      yield* fileSystem
        .chmod(currentPath, 0o755)
        .pipe(wrapInstallFailure("write_failed", "Could not chmod the managed rtk binary."));
    }
  });

  const installUnlocked = Effect.fn("rtkManagedBinary.installUnlocked")(function* () {
    if (!assetName) {
      return yield* new RtkManagedBinaryError({
        reason: "unsupported_platform",
        message: `Pivot does not provide a managed rtk binary for ${platform}-${arch}${musl ? " (musl)" : ""}.`,
      });
    }

    const release = yield* fetchLatestRelease();
    const version = normalizeReleaseVersion(release.tag_name);
    const asset = release.assets.find((entry) => entry.name === assetName);
    const checksumAsset = release.assets.find((entry) => entry.name === "checksums.txt");
    if (!asset || !checksumAsset) {
      return yield* new RtkManagedBinaryError({
        reason: "download_failed",
        message: `rtk release ${release.tag_name} is missing asset ${assetName}.`,
      });
    }

    const versionedPath = path.join(toolsRoot, version, platformKey(platform, arch, musl), exeName);
    const versionedDirectory = path.dirname(versionedPath);
    const lockPath = path.join(toolsRoot, "install.lock");

    yield* fileSystem
      .makeDirectory(versionedDirectory, { recursive: true })
      .pipe(wrapInstallFailure("write_failed", "Could not create the rtk tool directory."));
    yield* fileSystem
      .makeDirectory(currentBinDirectory, { recursive: true })
      .pipe(wrapInstallFailure("write_failed", "Could not create the rtk current directory."));
    yield* acquireInstallLock(lockPath).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          new RtkManagedBinaryError({
            reason: "write_failed",
            message: "Could not acquire the rtk installation lock.",
            cause,
          }),
        ),
      ),
    );

    return yield* Effect.gen(function* () {
      if (yield* isExecutableFile(versionedPath)) {
        const existingVersion = yield* probeVersion(versionedPath);
        if (existingVersion === version) {
          yield* activateBinary(versionedPath);
          return {
            status: "available",
            executablePath: currentPath,
            version,
          } satisfies AvailableRtkManagedBinary;
        }
      }

      const checksumText = yield* httpClient
        .execute(HttpClientRequest.get(checksumAsset.browser_download_url))
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.text),
          Effect.mapError(
            (cause) =>
              new RtkManagedBinaryError({
                reason: "download_failed",
                message: "Could not download rtk checksums.txt.",
                cause,
              }),
          ),
        );
      const expectedSha = parseChecksumLine(checksumText, assetName);
      if (!expectedSha) {
        return yield* new RtkManagedBinaryError({
          reason: "invalid_checksum",
          message: `checksums.txt has no entry for ${assetName}.`,
        });
      }

      const bytes = new Uint8Array(
        yield* httpClient.execute(HttpClientRequest.get(asset.browser_download_url)).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.arrayBuffer),
          Effect.mapError(
            (cause) =>
              new RtkManagedBinaryError({
                reason: "download_failed",
                message: "Could not download the rtk release archive.",
                cause,
              }),
          ),
        ),
      );
      const digest = yield* crypto.digest("SHA-256", bytes).pipe(
        Effect.mapError(
          (cause) =>
            new RtkManagedBinaryError({
              reason: "validation_failed",
              message: "Could not hash the downloaded rtk archive.",
              cause,
            }),
        ),
      );
      if (Encoding.encodeHex(digest) !== expectedSha) {
        return yield* new RtkManagedBinaryError({
          reason: "invalid_checksum",
          message: "Downloaded rtk archive checksum did not match checksums.txt.",
        });
      }

      const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
        directory: versionedDirectory,
        prefix: ".install-",
      });
      const archivePath = path.join(tempDirectory, assetName);
      const extractDirectory = path.join(tempDirectory, "extract");
      yield* fileSystem
        .makeDirectory(extractDirectory, { recursive: true })
        .pipe(wrapInstallFailure("write_failed", "Could not create the rtk extract directory."));
      yield* fileSystem
        .writeFile(archivePath, bytes)
        .pipe(wrapInstallFailure("write_failed", "Could not write the rtk archive."));
      yield* extractArchive(archivePath, extractDirectory);
      const extractedBinary = yield* findExtractedBinary(extractDirectory);
      if (platform !== "win32") {
        yield* fileSystem
          .chmod(extractedBinary, 0o755)
          .pipe(wrapInstallFailure("write_failed", "Could not make rtk executable."));
      }
      yield* runCommand(extractedBinary, ["--version"]).pipe(
        wrapInstallFailure("validation_failed", "The downloaded rtk binary did not run."),
      );

      const stagedPath = `${versionedPath}.${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}.tmp`;
      yield* fileSystem
        .rename(extractedBinary, stagedPath)
        .pipe(wrapInstallFailure("write_failed", "Could not stage the rtk binary."));
      yield* fileSystem
        .rename(stagedPath, versionedPath)
        .pipe(
          wrapInstallFailure("write_failed", "Could not activate the versioned rtk binary."),
          Effect.ensuring(fileSystem.remove(stagedPath, { force: true }).pipe(Effect.ignore)),
        );
      yield* activateBinary(versionedPath);

      return {
        status: "available",
        executablePath: currentPath,
        version,
      } satisfies AvailableRtkManagedBinary;
    }).pipe(
      Effect.scoped,
      Effect.ensuring(fileSystem.remove(lockPath, { force: true }).pipe(Effect.ignore)),
      Effect.catch((cause) =>
        cause instanceof RtkManagedBinaryError
          ? Effect.fail(cause)
          : Effect.fail(
              new RtkManagedBinaryError({
                reason: "write_failed",
                message: "Could not install the managed rtk binary.",
                cause,
              }),
            ),
      ),
    );
  });

  const install: RtkManagedBinaryApi["install"] = installSemaphore.withPermit(installUnlocked());

  const activateOmpHook: RtkManagedBinaryApi["activateOmpHook"] = Effect.gen(function* () {
    const status = yield* resolve;
    if (status.status !== "available") {
      return yield* new RtkManagedBinaryError({
        reason: "validation_failed",
        message: "Managed rtk is not available; cannot activate the omp rewrite hook.",
      });
    }
    yield* runCommand(status.executablePath, RTK_OMP_HOOK_INIT_ARGS).pipe(
      wrapInstallFailure(
        "validation_failed",
        "Could not run `rtk init -g --agent pi` for the managed rtk binary.",
      ),
    );
  });

  return {
    resolve,
    install,
    fetchLatestReleaseVersion,
    activateOmpHook,
    currentBinDirectory,
  };
});
