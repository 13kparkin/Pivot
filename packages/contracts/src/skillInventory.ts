import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const SkillInventoryInstallation = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  harness: ProviderDriverKind,
  harnessDisplayName: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  directoryPath: TrimmedNonEmptyString,
  skillFilePath: TrimmedNonEmptyString,
  content: Schema.String,
  enabled: Schema.Boolean,
});
export type SkillInventoryInstallation = typeof SkillInventoryInstallation.Type;

export const SkillInventory = Schema.Struct({
  scannedAt: TrimmedNonEmptyString,
  installations: Schema.Array(SkillInventoryInstallation),
});
export type SkillInventory = typeof SkillInventory.Type;
