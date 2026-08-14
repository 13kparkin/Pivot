import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import { OmpConfigStore } from "./OmpConfigStore.ts";

it.layer(NodeServices.layer)("OmpConfigStore", (it) => {
  it.effect("round-trips modelRoles.plan and advisor.enabled in a temp omp home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ompHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-config-store-" });
      const store = new OmpConfigStore(fs, path, ompHome);

      const missing = yield* store.read();
      expect(missing.modelRoles).toEqual({});
      expect(missing.advisor).toBeUndefined();

      yield* store.write({
        modelRoles: { plan: "anthropic/claude-plan" },
        advisor: { enabled: true },
      });

      const loaded = yield* store.read();
      expect(loaded.modelRoles.plan).toBe("anthropic/claude-plan");
      expect(loaded.advisor?.enabled).toBe(true);
    }),
  );
});
