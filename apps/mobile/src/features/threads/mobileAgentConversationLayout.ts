export function mobileAgentTreeIndent(depth: number): {
  readonly indentation: number;
  readonly hiddenAncestors: number;
} {
  return {
    indentation: Math.min(Math.max(0, depth), 3) * 18,
    hiddenAncestors: Math.max(0, depth - 3),
  };
}
