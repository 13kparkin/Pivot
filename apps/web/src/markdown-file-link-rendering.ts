import { resolveMarkdownFileLinkMeta, type MarkdownFileLinkMeta } from "./markdown-links";

type MarkdownLinkAstNode = {
  type?: string;
  data?: {
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownLinkAstNode[];
};

type RenderedMarkdownLinkNode = {
  properties?: Record<string, unknown>;
};

export function remarkTagMarkdownLinks() {
  return (tree: MarkdownLinkAstNode) => {
    const visit = (node: MarkdownLinkAstNode) => {
      if (node.type === "link" || node.type === "linkReference") {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataMarkdownLink: "",
          },
        };
      }
      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

export function resolveRenderedMarkdownFileLinkMeta(
  node: RenderedMarkdownLinkNode | undefined,
  href: string | undefined,
  cwd?: string,
): MarkdownFileLinkMeta | null {
  if (node?.properties?.dataMarkdownLink == null) return null;
  return resolveMarkdownFileLinkMeta(href, cwd);
}
