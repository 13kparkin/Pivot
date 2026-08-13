import packageJson from "../../package.json" with { type: "json" };

/** npm package name published from apps/server. */
export const CLI_PACKAGE_NAME = packageJson.name;

/** Installed binary name from package.json `bin`. */
export const CLI_BIN_NAME = Object.keys(packageJson.bin)[0] ?? packageJson.name;

export function cliPackageSpec(versionOrTag?: string): string {
  return versionOrTag ? `${CLI_PACKAGE_NAME}@${versionOrTag}` : CLI_PACKAGE_NAME;
}

export function cliPackageEntryPath(
  join: (...parts: string[]) => string,
  versionDir: string,
): string {
  return join(versionDir, "node_modules", CLI_PACKAGE_NAME, "dist", "bin.mjs");
}
