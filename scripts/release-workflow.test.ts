// @effect-diagnostics nodeBuiltinImport:off - reads the workflow file under test.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";
import { parse as parseYaml } from "yaml";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

type WorkflowStep = {
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
};

type Workflow = {
  readonly jobs?: Readonly<Record<string, { readonly steps?: ReadonlyArray<WorkflowStep> }>>;
};

it("publishes releases with GITHUB_TOKEN so generated tags do not retrigger the workflow", () => {
  const workflow = parseYaml(
    NodeFS.readFileSync(NodePath.join(repoRoot, ".github/workflows/release.yml"), "utf8"),
  ) as Workflow;
  const releaseSteps = workflow.jobs?.release?.steps ?? [];
  const publishSteps = releaseSteps.filter((step) =>
    step.uses?.startsWith("softprops/action-gh-release@"),
  );

  assert.lengthOf(publishSteps, 2);
  for (const step of publishSteps) {
    assert.equal(step.with?.token, "${{ github.token }}");
  }
});
