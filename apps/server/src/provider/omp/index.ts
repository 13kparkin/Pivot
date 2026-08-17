// Public barrel for the omp provider feature module: outside code imports
// this file; code inside the module imports concrete files. Re-exports only.
export { OmpAdapter } from "./OmpAdapter.ts";
export { OmpCapabilitiesService } from "./OmpCapabilitiesService.ts";
export { OmpRpcRuntime, OmpSpawnError } from "./OmpRpcRuntime.ts";
export { OmpConfigStore, syncOmpSettingsToConfigStore } from "./OmpConfigStore.ts";
export { enrichOmpManagedBundleVersionAdvisory } from "./OmpManagedBundleAdvisory.ts";
export { OmpLoginError, listOmpLoginProviders, loginOmpProvider } from "./OmpLogin.ts";
export { parseOmpModelRoleSlug } from "./ompModelRoles.ts";
export {
  makeOmpManagedBinary,
  OMP_GITHUB_REPO,
  OMP_MANAGED_UPDATE_EXECUTABLE,
  OMP_MANAGED_UPDATE_LOCK_KEY,
  OMP_NPM_PACKAGE_NAME,
  OmpManagedBinaryError,
} from "./OmpManagedBinary.ts";
export { makeRtkManagedBinary, RtkManagedBinaryError } from "./RtkManagedBinary.ts";
export { ReviewBlockDecoder } from "./ReviewBlockDecoder.ts";
export { OmpToolPresentation } from "./OmpToolPresentation.ts";
