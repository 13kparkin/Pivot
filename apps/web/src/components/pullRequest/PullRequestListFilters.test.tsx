import type { ProjectId } from "@t3tools/contracts";
import { CircleIcon } from "lucide-react";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { PullRequestFiltersMenu } from "./PullRequestListFilters";

function findValueChange(
  node: ReactNode,
):
  | ReactElement<{ readonly children?: ReactNode; readonly onValueChange: (value: string) => void }>
  | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    const props = child.props as {
      readonly children?: ReactNode;
      readonly onValueChange?: (value: string) => void;
    };
    if (props.onValueChange) {
      return child as ReactElement<{
        readonly children?: ReactNode;
        readonly onValueChange: (value: string) => void;
      }>;
    }
    const nested = findValueChange(props.children);
    if (nested) return nested;
  }
  return undefined;
}

/** The nested radio-group component element carrying this label, invoked so its group shows. */
function findLabeledGroup(node: ReactNode, label: string): ReactNode {
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    const props = child.props as { readonly children?: ReactNode; readonly label?: string };
    if (props.label === label && typeof child.type === "function") {
      return (child.type as (properties: unknown) => ReactNode)(child.props);
    }
    const nested = findLabeledGroup(props.children, label);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function menu(overrides: Partial<Parameters<typeof PullRequestFiltersMenu>[0]>) {
  return PullRequestFiltersMenu({
    state: "open",
    stateOptions: [
      { value: "open", label: "Open", Icon: CircleIcon },
      { value: "closed", label: "Closed", Icon: CircleIcon },
    ],
    onState: () => undefined,
    involvement: "all",
    involvementOptions: [{ value: "all", label: "All", Icon: CircleIcon }],
    onInvolvement: () => undefined,
    reviewStatus: undefined,
    reviewStatusOptions: [{ value: "", label: "Any review status", Icon: CircleIcon }],
    onReviewStatus: () => undefined,
    maxSize: undefined,
    sizeOptions: [{ value: "", label: "Any size", Icon: CircleIcon }],
    onMaxSize: () => undefined,
    label: undefined,
    labelOptions: [{ value: "", label: "Any label", Icon: CircleIcon }],
    onLabel: () => undefined,
    host: undefined,
    hostOptions: [],
    onHost: () => undefined,
    environmentId: null,
    projects: [],
    projectId: undefined,
    unavailable: new Map(),
    onProject: () => undefined,
    ...overrides,
    quickFiltersSupported: overrides.quickFiltersSupported ?? true,
  });
}

describe("pull request filters menu", () => {
  it("does not emit a change when the selected state is chosen again", () => {
    const onState = vi.fn();
    const group = findValueChange(findLabeledGroup(menu({ onState }), "State"));
    expect(group).toBeDefined();

    group?.props.onValueChange("open");
    expect(onState).not.toHaveBeenCalled();

    group?.props.onValueChange("closed");
    expect(onState).toHaveBeenCalledOnce();
    expect(onState).toHaveBeenCalledWith("closed");
  });

  it("hides quick filters when the server does not advertise support", () => {
    const view = menu({ quickFiltersSupported: false });

    expect(findLabeledGroup(view, "Review")).toBeUndefined();
    expect(findLabeledGroup(view, "Size")).toBeUndefined();
    expect(findLabeledGroup(view, "Label")).toBeUndefined();
  });

  it("maps the review, size, and label any options back to no filter", () => {
    const onReviewStatus = vi.fn();
    const onMaxSize = vi.fn();
    const onLabel = vi.fn();
    const view = menu({
      reviewStatus: "approved",
      reviewStatusOptions: [
        { value: "", label: "Any review status", Icon: CircleIcon },
        { value: "approved", label: "Approved", Icon: CircleIcon },
      ],
      maxSize: "m",
      sizeOptions: [
        { value: "", label: "Any size", Icon: CircleIcon },
        { value: "m", label: "Size ≤ M", Icon: CircleIcon },
      ],
      label: "bug",
      labelOptions: [
        { value: "", label: "Any label", Icon: CircleIcon },
        { value: "bug", label: "bug", Icon: CircleIcon },
      ],
      onReviewStatus,
      onMaxSize,
      onLabel,
    });

    findValueChange(findLabeledGroup(view, "Review"))?.props.onValueChange("");
    findValueChange(findLabeledGroup(view, "Size"))?.props.onValueChange("");
    findValueChange(findLabeledGroup(view, "Label"))?.props.onValueChange("");

    expect(onReviewStatus).toHaveBeenCalledWith(undefined);
    expect(onMaxSize).toHaveBeenCalledWith(undefined);
    expect(onLabel).toHaveBeenCalledWith(undefined);
  });

  it("does not emit a change when the selected project is chosen again", () => {
    const projectId = "project-1" as ProjectId;
    const onProject = vi.fn();
    const view = menu({
      projects: [{ id: projectId, title: "T3 Code", workspaceRoot: "/work/t3code" }],
      projectId,
      onProject,
    });
    const radioGroup = findValueChange(view);
    expect(radioGroup).toBeDefined();

    radioGroup?.props.onValueChange(projectId);
    expect(onProject).not.toHaveBeenCalled();

    radioGroup?.props.onValueChange("all");
    expect(onProject).toHaveBeenCalledWith(undefined);
  });
});
