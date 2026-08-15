import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildItemRows, filterItemRows, isValidItemName } from "./CapabilityItemsPanel.logic";

describe("buildItemRows", () => {
  it("sorts global before project, then alphabetically", () => {
    const rows = buildItemRows([
      { name: "zeta", scope: "project" },
      { name: "alpha", scope: "global" },
      { name: "beta", scope: "project" },
    ]);
    expect(rows.map((row) => `${row.scope}:${row.name}`)).toEqual([
      "global:alpha",
      "project:beta",
      "project:zeta",
    ]);
  });

  it("labels scopes and flags project items that shadow a global one", () => {
    const rows = buildItemRows([
      { name: "codegraph", scope: "global", description: "g" },
      { name: "codegraph", scope: "project", description: "p" },
      { name: "only-project", scope: "project" },
    ]);
    const global = rows.find((row) => row.scope === "global");
    expect(global?.scopeLabel).toBe("Global");
    expect(global?.shadowed).toBe(false);
    const shadow = rows.find((row) => row.scope === "project" && row.name === "codegraph");
    expect(shadow?.scopeLabel).toBe("Project");
    expect(shadow?.shadowed).toBe(true);
    const onlyProject = rows.find((row) => row.name === "only-project");
    expect(onlyProject?.shadowed).toBe(false);
  });

  it("labels project items with their project title when present", () => {
    const rows = buildItemRows([
      {
        name: "tidy",
        scope: "project",
        projectId: ProjectId.make("proj-a"),
        projectTitle: "Pivot",
      },
      { name: "plain", scope: "project" },
    ]);
    const titled = rows.find((row) => row.name === "tidy");
    expect(titled?.scopeLabel).toBe("Project · Pivot");
    const untitled = rows.find((row) => row.name === "plain");
    expect(untitled?.scopeLabel).toBe("Project");
  });

  it("orders same-named project items deterministically by project id", () => {
    const rows = buildItemRows([
      { name: "codegraph", scope: "project", projectId: ProjectId.make("proj-b") },
      { name: "codegraph", scope: "project", projectId: ProjectId.make("proj-a") },
    ]);
    expect(rows.map((row) => row.projectId)).toEqual([
      ProjectId.make("proj-a"),
      ProjectId.make("proj-b"),
    ]);
  });
});

describe("filterItemRows", () => {
  const rows = buildItemRows([
    { name: "codegraph", scope: "global", description: "Prefer CodeGraph" },
    { name: "create-ticket", scope: "global", description: "Draft tickets" },
    { name: "testing-standards", scope: "project", description: "Test conventions" },
  ]);

  it("returns every row for an empty query", () => {
    expect(filterItemRows(rows, "")).toHaveLength(3);
    expect(filterItemRows(rows, "   ")).toHaveLength(3);
  });

  it("matches by name, case-insensitively", () => {
    expect(filterItemRows(rows, "CODEGRAPH").map((row) => row.name)).toEqual(["codegraph"]);
  });

  it("matches by description", () => {
    expect(filterItemRows(rows, "ticket").map((row) => row.name)).toEqual(["create-ticket"]);
  });

  it("returns no rows when nothing matches", () => {
    expect(filterItemRows(rows, "xyzzy")).toEqual([]);
  });
});

describe("isValidItemName", () => {
  it("accepts safe slugs", () => {
    for (const good of ["codegraph", "create-ticket", "my.rule_2"]) {
      expect(isValidItemName(good)).toBe(true);
    }
  });

  it("rejects traversal, whitespace and separators", () => {
    for (const bad of ["../evil", "a/b", "..", ".hidden", "", "a b", "a\\b"]) {
      expect(isValidItemName(bad)).toBe(false);
    }
  });
});
