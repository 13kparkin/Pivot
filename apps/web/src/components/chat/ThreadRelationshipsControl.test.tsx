import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  canDetach: false,
  relationships: [] as ReadonlyArray<unknown>,
}));

vi.mock("@t3tools/client-runtime/state/thread-relationships", () => ({
  deriveThreadRelationshipGraph: () => ({ nodes: new Map() }),
  immediateThreadRelationships: () => testState.relationships,
  resolveMergeBackTargetThreadId: () => null,
}));
vi.mock("@t3tools/client-runtime/state/thread-workflows", () => ({
  canDetachThreadProviderSession: () => testState.canDetach,
  resolveLatestMergeBackRun: () => null,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({ snapshots: [] }),
}));
vi.mock("../../state/entities", () => ({
  useThreadProjection: () => ({ projection: { runs: [] } }),
  useThreadShells: () => [],
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    mergeBack: Symbol("mergeBack"),
    stopSession: Symbol("stopSession"),
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  MenuTrigger: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  MenuPopup: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  MenuItem: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

const environmentId = "environment:relationships" as EnvironmentId;
const threadId = "thread:relationships" as ThreadId;
const childThreadId = "thread:relationships:subagent" as ThreadId;

const renderPanel = () =>
  renderToStaticMarkup(
    <ThreadRelationshipsPanel environmentId={environmentId} threadId={threadId} />,
  );

describe("ThreadRelationshipsPanel", () => {
  beforeEach(() => {
    testState.canDetach = false;
    testState.relationships = [
      {
        threadId: childThreadId,
        edge: {
          kind: "subagent",
          sourceThreadId: threadId,
          targetThreadId: childThreadId,
          status: "running",
        },
      },
    ];
  });

  it("keeps disconnect controls when hidden subagent edges are the only relationships", () => {
    testState.canDetach = true;

    const markup = renderPanel();

    expect(markup).toContain("Lineage");
    expect(markup).toContain("Disconnect agent session");
    expect(markup).not.toContain("Subagent");
  });

  it("renders nothing when no visible relationship or detachable session exists", () => {
    expect(renderPanel()).toBe("");
  });
});
