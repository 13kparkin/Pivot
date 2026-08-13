import { describe, expect, it } from "vite-plus/test";

import { normalizeReleaseVersion } from "./OmpManagedBinary.ts";
import {
  parseChecksumLine,
  parseRtkVersionOutput,
  resolveRtkReleaseAssetName,
} from "./RtkManagedBinary.ts";

describe("RtkManagedBinary helpers", () => {
  it("maps host platforms to rtk-ai release asset names", () => {
    expect(resolveRtkReleaseAssetName("darwin", "arm64", false)).toBe(
      "rtk-aarch64-apple-darwin.tar.gz",
    );
    expect(resolveRtkReleaseAssetName("darwin", "x64", false)).toBe(
      "rtk-x86_64-apple-darwin.tar.gz",
    );
    expect(resolveRtkReleaseAssetName("linux", "x64", false)).toBe(
      "rtk-x86_64-unknown-linux-musl.tar.gz",
    );
    expect(resolveRtkReleaseAssetName("linux", "x64", true)).toBe(
      "rtk-x86_64-unknown-linux-musl.tar.gz",
    );
    expect(resolveRtkReleaseAssetName("linux", "arm64", false)).toBe(
      "rtk-aarch64-unknown-linux-gnu.tar.gz",
    );
    expect(resolveRtkReleaseAssetName("linux", "arm64", true)).toBeNull();
    expect(resolveRtkReleaseAssetName("win32", "x64", false)).toBe(
      "rtk-x86_64-pc-windows-msvc.zip",
    );
    expect(resolveRtkReleaseAssetName("freebsd", "x64", false)).toBeNull();
  });

  it("parses version output and checksum lines", () => {
    expect(parseRtkVersionOutput("rtk 0.45.0\n")).toBe("0.45.0");
    expect(normalizeReleaseVersion("v0.45.0")).toBe("0.45.0");
    expect(
      parseChecksumLine(
        "abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1  rtk-x86_64-unknown-linux-musl.tar.gz\n",
        "rtk-x86_64-unknown-linux-musl.tar.gz",
      ),
    ).toBe("abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1");
    expect(parseChecksumLine("not-a-checksum", "rtk-x86_64-unknown-linux-musl.tar.gz")).toBeNull();
  });
});
