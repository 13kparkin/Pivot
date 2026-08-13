import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyManagedRtkBehindAdvisory,
  isManagedRtkBehind,
  RTK_BEHIND_MESSAGE,
} from "./OmpManagedBundleAdvisory.ts";

const OMP = ProviderDriverKind.make("omp");

function baseSnapshot(overrides?: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("omp"),
    driver: OMP,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-13T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "current",
      currentVersion: "1.0.0",
      latestVersion: "1.0.0",
      updateCommand: "Pivot managed install",
      canUpdate: true,
      checkedAt: "2026-08-13T00:00:00.000Z",
      message: null,
    },
    ...overrides,
  };
}

describe("managed rtk advisory fold", () => {
  it("detects missing and outdated managed rtk", () => {
    expect(isManagedRtkBehind({ rtkCurrent: null, rtkLatest: "0.45.0", rtkMissing: true })).toBe(
      true,
    );
    expect(
      isManagedRtkBehind({ rtkCurrent: "0.44.0", rtkLatest: "0.45.0", rtkMissing: false }),
    ).toBe(true);
    expect(
      isManagedRtkBehind({ rtkCurrent: "0.45.0", rtkLatest: "0.45.0", rtkMissing: false }),
    ).toBe(false);
    expect(isManagedRtkBehind({ rtkCurrent: null, rtkLatest: null, rtkMissing: true })).toBe(false);
  });

  it("forces behind_latest with an rtk message when omp is current", () => {
    const next = applyManagedRtkBehindAdvisory(baseSnapshot(), {
      rtkCurrent: null,
      rtkLatest: "0.45.0",
      rtkMissing: true,
      checkedAt: "2026-08-13T12:00:00.000Z",
    });
    expect(next.versionAdvisory?.status).toBe("behind_latest");
    expect(next.versionAdvisory?.message).toBe(RTK_BEHIND_MESSAGE);
  });

  it("keeps the omp message when omp is already behind", () => {
    const next = applyManagedRtkBehindAdvisory(
      baseSnapshot({
        versionAdvisory: {
          status: "behind_latest",
          currentVersion: "1.0.0",
          latestVersion: "1.1.0",
          updateCommand: "Pivot managed install",
          canUpdate: true,
          checkedAt: "2026-08-13T00:00:00.000Z",
          message: "Install the update now or review provider settings.",
        },
      }),
      {
        rtkCurrent: "0.44.0",
        rtkLatest: "0.45.0",
        rtkMissing: false,
        checkedAt: "2026-08-13T12:00:00.000Z",
      },
    );
    expect(next.versionAdvisory?.status).toBe("behind_latest");
    expect(next.versionAdvisory?.message).toBe(
      "Install the update now or review provider settings.",
    );
  });
});
