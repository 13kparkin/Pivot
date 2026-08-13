import { describe, expect, it } from "vite-plus/test";

import {
  normalizeReleaseVersion,
  parseOmpVersionOutput,
  platformKey,
  resolveOmpReleaseAssetName,
} from "./OmpManagedBinary.ts";

describe("OmpManagedBinary helpers", () => {
  it("maps host platforms to oh-my-pi release asset names", () => {
    expect(resolveOmpReleaseAssetName("darwin", "arm64", false)).toBe("omp-darwin-arm64");
    expect(resolveOmpReleaseAssetName("darwin", "x64", false)).toBe("omp-darwin-x64");
    expect(resolveOmpReleaseAssetName("linux", "x64", false)).toBe("omp-linux-x64");
    expect(resolveOmpReleaseAssetName("linux", "x64", true)).toBe("omp-linux-musl-x64");
    expect(resolveOmpReleaseAssetName("linux", "arm64", true)).toBe("omp-linux-musl-arm64");
    expect(resolveOmpReleaseAssetName("win32", "x64", false)).toBe("omp-windows-x64.exe");
    expect(resolveOmpReleaseAssetName("freebsd", "x64", false)).toBeNull();
  });

  it("builds platform keys that include musl when needed", () => {
    expect(platformKey("linux", "x64", false)).toBe("linux-x64");
    expect(platformKey("linux", "x64", true)).toBe("linux-musl-x64");
    expect(platformKey("darwin", "arm64", false)).toBe("darwin-arm64");
  });

  it("parses omp --version output and release tags", () => {
    expect(parseOmpVersionOutput("omp/17.3.0\n")).toBe("17.3.0");
    expect(parseOmpVersionOutput("something 1.2.3 else")).toBe("1.2.3");
    expect(normalizeReleaseVersion("v17.3.0")).toBe("17.3.0");
    expect(normalizeReleaseVersion("17.3.0")).toBe("17.3.0");
  });
});
