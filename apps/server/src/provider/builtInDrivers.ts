/**
 * BUILT_IN_DRIVERS — the static set of `ProviderDriver`s this build ships
 * with.
 *
 * Pivot ships omp only (AC8).
 *
 * @module provider/builtInDrivers
 */
import { OmpDriver, type OmpDriverEnv } from "./Drivers/OmpDriver.ts";
import type { AnyProviderDriver } from "./ProviderDriver.ts";

/**
 * Union of infrastructure services required to construct any built-in
 * driver. The registry layer declares `R = BuiltInDriversEnv`; the runtime
 * layer must provide every service in this union.
 */
export type BuiltInDriversEnv = OmpDriverEnv;

/**
 * Ordered list of built-in drivers. Order matters only for tie-breaking in
 * UI presentation — the registry itself is keyed by `driverKind`, so
 * iteration order has no functional effect on instance lookup.
 */
export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [OmpDriver];
