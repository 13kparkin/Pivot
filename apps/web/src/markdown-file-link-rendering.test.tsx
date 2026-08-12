import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { describe, expect, it } from "vite-plus/test";

import {
  remarkTagMarkdownLinks,
  resolveRenderedMarkdownFileLinkMeta,
} from "./markdown-file-link-rendering";

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), "dataMarkdownLink"],
  },
} satisfies Parameters<typeof rehypeSanitize>[0];

function renderFileLinks(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkTagMarkdownLinks]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
      components={{
        a({ node, href, children }) {
          const fileLinkMeta = resolveRenderedMarkdownFileLinkMeta(node, href, "/repo/project");
          return fileLinkMeta ? (
            <span data-file-path={fileLinkMeta.filePath}>{children}</span>
          ) : (
            <a href={href}>{children}</a>
          );
        },
      }}
    >
      {markdown}
    </ReactMarkdown>,
  );
}

describe("rendered markdown file links", () => {
  it("uses the renderer link when its label contains link-looking inline code", () => {
    const markup = renderFileLinks("[see `[x](fake.ts)`](src/real.ts)");

    expect(markup).toContain('data-file-path="/repo/project/src/real.ts"');
    expect(markup).toContain("<code>[x](fake.ts)</code>");
    expect(markup).not.toContain('data-file-path="/repo/project/fake.ts"');
  });

  it("does not turn raw html anchors into file links", () => {
    const markup = renderFileLinks('<a href="src/raw.ts">raw</a>');

    expect(markup).toContain('<a href="src/raw.ts">raw</a>');
    expect(markup).not.toContain("data-file-path");
  });
});
