// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalRandom:off globalDateInEffect:off - OS-level test exercises executing-binary overwrite semantics.
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

/** Real-timer wait — `Effect.sleep` is frozen under the test runtime's TestClock. */
const wait = (ms: number) =>
  Effect.promise<void>(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/**
 * The managed-binary publish (`OmpManagedBinary`, `RtkManagedBinary`) must not
 * overwrite the `current` binary in place: it is the one live sessions run
 * from, and an in-place copy over an executing ELF fails with ETXTBSY. The
 * fix copies to a sibling temp and renames it over `current`. This test pins
 * the OS invariant that rename replaces an executing file while a plain copy
 * does not — the reason the publish uses rename.
 */
describe("managed binary publish over an executing binary", () => {
  it.effect("rename replaces an executing ELF where an in-place copy fails", () => {
    const baseDir = NodePath.join(NodeOS.tmpdir(), `t3-etxtbsy-${Date.now()}-${Math.random()}`);
    const currentPath = NodePath.join(baseDir, "current", "omp");
    const newBinaryPath = NodePath.join(baseDir, "new", "omp");
    NodeFS.mkdirSync(NodePath.join(baseDir, "current"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(baseDir, "new"), { recursive: true });

    let child: ReturnType<typeof NodeChildProcess.spawn> | undefined;
    return Effect.gen(function* () {
      if (!NodeFS.existsSync("/bin/sleep")) {
        // The ETXTBSY scenario is Linux-specific; nothing to assert elsewhere.
        return;
      }

      // Seed a long-running executable at `current` so its text segment is
      // ETXTBSY-locked, exactly like a live session, and a distinct new binary.
      NodeFS.copyFileSync("/bin/sleep", currentPath);
      NodeFS.chmodSync(currentPath, 0o755);
      NodeFS.copyFileSync("/bin/true", newBinaryPath);
      NodeFS.chmodSync(newBinaryPath, 0o755);
      child = NodeChildProcess.spawn(currentPath, ["30"], { detached: true });
      child.unref();
      yield* wait(100);

      // In-place copy fails with ETXTBSY (the bug the publish avoids)…
      let copyFailedWithBusy = false;
      try {
        NodeFS.copyFileSync(newBinaryPath, currentPath);
      } catch (error) {
        copyFailedWithBusy =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: string }).code === "ETXTBSY";
      }
      expect(copyFailedWithBusy).toBe(true);

      // …while copy-to-temp + rename replaces it atomically.
      const publishTemp = `${currentPath}.${Date.now()}.tmp`;
      NodeFS.copyFileSync(newBinaryPath, publishTemp);
      NodeFS.renameSync(publishTemp, currentPath);
      expect(NodeFS.readFileSync(currentPath).equals(NodeFS.readFileSync(newBinaryPath))).toBe(
        true,
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (child) {
            child.kill("SIGKILL");
          }
          NodeFS.rmSync(baseDir, { recursive: true, force: true });
        }),
      ),
    );
  });
});
