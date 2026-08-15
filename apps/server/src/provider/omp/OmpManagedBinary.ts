/**
 * OmpManagedBinary — download omp GitHub release assets into T3 home.
 *
 * Layout: `{baseDir}/tools/omp/{version}/{platformKey}/omp[.exe]`
 * Active binary: `{baseDir}/tools/omp/current/omp[.exe]` (atomic replace).
 *
 * @module provider/omp/OmpManagedBinary
 */
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { parseGenericCliVersion } from "../providerSnapshot.ts";

export const OMP_GITHUB_REPO = "can1357/oh-my-pi";
export const OMP_MANAGED_UPDATE_LOCK_KEY = "omp-managed";
export const OMP_MANAGED_UPDATE_EXECUTABLE = "__omp_managed__";
export const OMP_NPM_PACKAGE_NAME = "@oh-my-pi/pi-coding-agent";

const INSTALL_LOCK_RETRY_COUNT = 100;
const INSTALL_LOCK_RETRY_DELAY = "100 millis";
const INSTALL_LOCK_STALE_MS = 5 * 60 * 1_000;

export class OmpManagedBinaryError extends Data.TaggedError("OmpManagedBinaryError")<{
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

export type OmpManagedBinarySource = "override" | "managed" | "path";

export type OmpManagedBinaryStatus =
  | {
      readonly status: "available";
      readonly executablePath: string;
      readonly source: OmpManagedBinarySource;
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

export type AvailableOmpManagedBinary = Extract<
  OmpManagedBinaryStatus,
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
  return platform === "win32" ? "omp.exe" : "omp";
}

export function isLinuxMuslHost(platform: NodeJS.Platform): boolean {
  if (platform !== "linux") {
    return false;
  }
  try {
    const report = process.report?.getReport() as
      | {
          readonly header?: {
            readonly glibcVersionRuntime?: unknown;
          };
        }
      | undefined;
    return typeof report?.header?.glibcVersionRuntime !== "string";
  } catch {
    return true;
  }
}

/** Map host platform/arch to an oh-my-pi release asset basename. */
export function resolveOmpReleaseAssetName(
  platform: NodeJS.Platform,
  arch: string,
  musl: boolean,
): string | null {
  if (platform === "darwin" && arch === "arm64") return "omp-darwin-arm64";
  if (platform === "darwin" && (arch === "x64" || arch === "x86_64")) return "omp-darwin-x64";
  if (platform === "linux" && arch === "arm64") {
    return musl ? "omp-linux-musl-arm64" : "omp-linux-arm64";
  }
  if (platform === "linux" && (arch === "x64" || arch === "x86_64")) {
    return musl ? "omp-linux-musl-x64" : "omp-linux-x64";
  }
  if (platform === "win32" && (arch === "x64" || arch === "x86_64")) {
    return "omp-windows-x64.exe";
  }
  return null;
}

export function platformKey(platform: NodeJS.Platform, arch: string, musl: boolean): string {
  if (platform === "linux" && musl) {
    return `${platform}-musl-${arch}`;
  }
  return `${platform}-${arch}`;
}

export function parseOmpVersionOutput(output: string): string | null {
  const slash = output.match(/\bomp\/(\d+\.\d+\.\d+)\b/i);
  if (slash?.[1]) {
    return slash[1];
  }
  return parseGenericCliVersion(output);
}

export function normalizeReleaseVersion(tagName: string): string {
  return tagName.trim().replace(/^v/i, "");
}

const wrapInstallFailure =
  (
    reason: OmpManagedBinaryError["reason"],
    message: string,
  ): (<E, R>(effect: Effect.Effect<void, E, R>) => Effect.Effect<void, OmpManagedBinaryError, R>) =>
  (effect) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new OmpManagedBinaryError({
            reason,
            message,
            cause,
          }),
      ),
    );

export interface OmpManagedBinaryOptions {
  readonly baseDir: string;
  /** Absolute override path (settings binaryPath when it contains a separator). */
  readonly binaryPathOverride?: string | undefined;
  readonly pathEnv?: string | undefined;
}

export interface OmpManagedBinaryApi {
  readonly resolve: Effect.Effect<OmpManagedBinaryStatus>;
  readonly install: Effect.Effect<AvailableOmpManagedBinary, OmpManagedBinaryError>;
  readonly fetchLatestReleaseVersion: Effect.Effect<string | null>;
}

export const makeOmpManagedBinary = Effect.fn("ompManagedBinary.make")(function* (
  options: OmpManagedBinaryOptions,
): Effect.fn.Return<
  OmpManagedBinaryApi,
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
  const assetName = resolveOmpReleaseAssetName(platform, arch, musl);
  const exeName = executableFileName(platform);
  const currentPath = path.join(options.baseDir, "tools", "omp", "current", exeName);
  const toolsRoot = path.join(options.baseDir, "tools", "omp");

  /**
   * Publish a freshly validated binary to `current`, which live sessions run
   * from. Overwriting it in place with copyFile fails with ETXTBSY ("Text file
   * busy") while any session is active, so copy to a sibling temp and rename
   * it over `current`: rename replaces the directory entry atomically and
   * running processes keep the old inode.
   */
  const publishToCurrent = Effect.fn("ompManagedBinary.publishToCurrent")(function* (
    versionedPath: string,
  ) {
    const publishTemp = `${currentPath}.${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}.tmp`;
    yield* fileSystem
      .copyFile(versionedPath, publishTemp)
      .pipe(wrapInstallFailure("write_failed", "Could not stage the managed omp binary."));
    yield* fileSystem
      .rename(publishTemp, currentPath)
      .pipe(
        wrapInstallFailure("write_failed", "Could not publish omp to the current path."),
        Effect.ensuring(fileSystem.remove(publishTemp, { force: true }).pipe(Effect.ignore)),
      );
    if (platform !== "win32") {
      yield* fileSystem
        .chmod(currentPath, 0o755)
        .pipe(wrapInstallFailure("write_failed", "Could not chmod the current omp binary."));
    }
  });

  const isExecutableFile = Effect.fn("ompManagedBinary.isExecutableFile")(function* (
    executablePath: string,
  ) {
    const info = yield* fileSystem.stat(executablePath).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return false;
    return platform === "win32" || (info.value.mode & 0o111) !== 0;
  });

  const probeVersion = (executablePath: string) =>
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
      return parseOmpVersionOutput(output);
    }).pipe(Effect.scoped);

  const resolvePathExecutable = Effect.gen(function* () {
    const pathValue = options.pathEnv ?? process.env.PATH;
    if (!pathValue) return null;
    const delimiter = platform === "win32" ? ";" : ":";
    for (const directory of pathValue.split(delimiter)) {
      const trimmed = directory.trim().replace(/^"|"$/gu, "");
      if (trimmed.length === 0) continue;
      const candidate = path.join(trimmed, exeName);
      if (yield* isExecutableFile(candidate)) return candidate;
    }
    return null;
  });

  const resolve: OmpManagedBinaryApi["resolve"] = Effect.gen(function* () {
    const override = options.binaryPathOverride?.trim();
    if (override && (override.includes("/") || override.includes("\\"))) {
      if (yield* isExecutableFile(override)) {
        const version = yield* probeVersion(override);
        return {
          status: "available",
          executablePath: override,
          source: "override",
          version,
        } satisfies OmpManagedBinaryStatus;
      }
      return { status: "missing" } satisfies OmpManagedBinaryStatus;
    }
    if (yield* isExecutableFile(currentPath)) {
      const version = yield* probeVersion(currentPath);
      return {
        status: "available",
        executablePath: currentPath,
        source: "managed",
        version,
      } satisfies OmpManagedBinaryStatus;
    }
    const pathExecutable = yield* resolvePathExecutable;
    if (pathExecutable) {
      const version = yield* probeVersion(pathExecutable);
      return {
        status: "available",
        executablePath: pathExecutable,
        source: "path",
        version,
      } satisfies OmpManagedBinaryStatus;
    }
    if (!assetName) {
      return {
        status: "unsupported",
        platform,
        arch,
      } satisfies OmpManagedBinaryStatus;
    }
    return { status: "missing" } satisfies OmpManagedBinaryStatus;
  });

  const fetchLatestRelease = Effect.fn("ompManagedBinary.fetchLatestRelease")(function* () {
    const response = yield* httpClient
      .execute(
        HttpClientRequest.get(
          `https://api.github.com/repos/${OMP_GITHUB_REPO}/releases/latest`,
        ).pipe(
          HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
          HttpClientRequest.setHeader("user-agent", "t3code-omp-managed-binary"),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.mapError(
          (cause) =>
            new OmpManagedBinaryError({
              reason: "download_failed",
              message: "Could not fetch the latest omp release metadata.",
              cause,
            }),
        ),
      );
    const payload = yield* response.json.pipe(
      Effect.flatMap(decodeGithubRelease),
      Effect.mapError(
        (cause) =>
          new OmpManagedBinaryError({
            reason: "download_failed",
            message: "Could not parse the latest omp release metadata.",
            cause,
          }),
      ),
    );
    return payload;
  });

  const fetchLatestReleaseVersion: OmpManagedBinaryApi["fetchLatestReleaseVersion"] =
    fetchLatestRelease().pipe(
      Effect.map((release) => normalizeReleaseVersion(release.tag_name)),
      Effect.orElseSucceed(() => null),
    );

  const runCommand = Effect.fn("ompManagedBinary.runCommand")(function* (
    command: string,
    args: ReadonlyArray<string>,
  ) {
    const child = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        shell: false,
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    const exitCode = Number(yield* child.exitCode);
    if (exitCode !== 0) {
      return yield* new OmpManagedBinaryError({
        reason: "validation_failed",
        message: `Command failed: ${command} (exit ${exitCode})`,
      });
    }
  });

  const acquireInstallLock = Effect.fn("ompManagedBinary.acquireInstallLock")(function* (
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
    return yield* new OmpManagedBinaryError({
      reason: "install_locked",
      message: "Another omp installation is still in progress.",
    });
  });

  const installUnlocked = Effect.fn("ompManagedBinary.installUnlocked")(function* () {
    if (!assetName) {
      return yield* new OmpManagedBinaryError({
        reason: "unsupported_platform",
        message: `Pivot does not provide a managed omp binary for ${platform}-${arch}.`,
      });
    }

    const release = yield* fetchLatestRelease();
    const version = normalizeReleaseVersion(release.tag_name);
    const asset = release.assets.find((entry) => entry.name === assetName);
    const checksumAsset = release.assets.find((entry) => entry.name === "SHA256SUMS.txt");
    if (!asset || !checksumAsset) {
      return yield* new OmpManagedBinaryError({
        reason: "download_failed",
        message: `omp release ${release.tag_name} is missing asset ${assetName}.`,
      });
    }

    const versionedPath = path.join(toolsRoot, version, platformKey(platform, arch, musl), exeName);
    const versionedDirectory = path.dirname(versionedPath);
    const currentDirectory = path.dirname(currentPath);
    const lockPath = path.join(toolsRoot, "install.lock");

    yield* fileSystem
      .makeDirectory(versionedDirectory, { recursive: true })
      .pipe(wrapInstallFailure("write_failed", "Could not create the omp tool directory."));
    yield* fileSystem
      .makeDirectory(currentDirectory, { recursive: true })
      .pipe(wrapInstallFailure("write_failed", "Could not create the omp current directory."));
    yield* acquireInstallLock(lockPath).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          new OmpManagedBinaryError({
            reason: "write_failed",
            message: "Could not acquire the omp installation lock.",
            cause,
          }),
        ),
      ),
    );

    return yield* Effect.gen(function* () {
      if (yield* isExecutableFile(versionedPath)) {
        const existingVersion = yield* probeVersion(versionedPath);
        if (existingVersion === version) {
          yield* publishToCurrent(versionedPath);
          return {
            status: "available",
            executablePath: currentPath,
            source: "managed",
            version,
          } satisfies AvailableOmpManagedBinary;
        }
      }

      const checksumText = yield* httpClient
        .execute(HttpClientRequest.get(checksumAsset.browser_download_url))
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.text),
          Effect.mapError(
            (cause) =>
              new OmpManagedBinaryError({
                reason: "download_failed",
                message: "Could not download omp SHA256SUMS.txt.",
                cause,
              }),
          ),
        );
      const expectedLine = checksumText
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .find((line) => line.endsWith(` ${assetName}`) || line.endsWith(` *${assetName}`));
      const expectedSha = expectedLine?.split(/\s+/)[0]?.toLowerCase();
      if (!expectedSha || expectedSha.length !== 64) {
        return yield* new OmpManagedBinaryError({
          reason: "invalid_checksum",
          message: `SHA256SUMS.txt has no entry for ${assetName}.`,
        });
      }

      const bytes = new Uint8Array(
        yield* httpClient.execute(HttpClientRequest.get(asset.browser_download_url)).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.arrayBuffer),
          Effect.mapError(
            (cause) =>
              new OmpManagedBinaryError({
                reason: "download_failed",
                message: "Could not download the omp release binary.",
                cause,
              }),
          ),
        ),
      );
      const digest = yield* crypto.digest("SHA-256", bytes).pipe(
        Effect.mapError(
          (cause) =>
            new OmpManagedBinaryError({
              reason: "validation_failed",
              message: "Could not hash the downloaded omp binary.",
              cause,
            }),
        ),
      );
      if (Encoding.encodeHex(digest) !== expectedSha) {
        return yield* new OmpManagedBinaryError({
          reason: "invalid_checksum",
          message: "Downloaded omp binary checksum did not match SHA256SUMS.txt.",
        });
      }

      const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
        directory: versionedDirectory,
        prefix: ".install-",
      });
      const tempBinary = path.join(tempDirectory, exeName);
      yield* fileSystem
        .writeFile(tempBinary, bytes)
        .pipe(wrapInstallFailure("write_failed", "Could not write the omp download."));
      if (platform !== "win32") {
        yield* fileSystem
          .chmod(tempBinary, 0o755)
          .pipe(wrapInstallFailure("write_failed", "Could not make omp executable."));
      }
      yield* runCommand(tempBinary, ["--version"]).pipe(
        wrapInstallFailure("validation_failed", "The downloaded omp binary did not run."),
      );

      const stagedPath = `${versionedPath}.${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}.tmp`;
      yield* fileSystem
        .rename(tempBinary, stagedPath)
        .pipe(wrapInstallFailure("write_failed", "Could not stage the omp binary."));
      yield* fileSystem
        .rename(stagedPath, versionedPath)
        .pipe(
          wrapInstallFailure("write_failed", "Could not activate the versioned omp binary."),
          Effect.ensuring(fileSystem.remove(stagedPath, { force: true }).pipe(Effect.ignore)),
        );
      yield* publishToCurrent(versionedPath);

      return {
        status: "available",
        executablePath: currentPath,
        source: "managed",
        version,
      } satisfies AvailableOmpManagedBinary;
    }).pipe(
      Effect.scoped,
      Effect.ensuring(fileSystem.remove(lockPath, { force: true }).pipe(Effect.ignore)),
      Effect.catch((cause) =>
        cause instanceof OmpManagedBinaryError
          ? Effect.fail(cause)
          : Effect.fail(
              new OmpManagedBinaryError({
                reason: "write_failed",
                message: "Could not install the managed omp binary.",
                cause,
              }),
            ),
      ),
    );
  });

  const install: OmpManagedBinaryApi["install"] = installSemaphore.withPermit(installUnlocked());

  return {
    resolve,
    install,
    fetchLatestReleaseVersion,
  };
});
