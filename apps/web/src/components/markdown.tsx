import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Children = { children?: React.ReactNode };

// The page that shows a brief has its own h1 (the scenario title) and h2 (the blocks of the side column), so the
// author's headings go one level down: `#` becomes h2, `##` h3 and so on. The look stays with the .md-1 / .md-2
// classes (globals.css), which carry what `.prose-wom h1` and `h2` used to.
const COMPONENTS = {
  h1: ({ children }: Children) => <h2 className="md-1">{children}</h2>,
  h2: ({ children }: Children) => <h3 className="md-2">{children}</h3>,
  h3: ({ children }: Children) => <h4>{children}</h4>,
  h4: ({ children }: Children) => <h5>{children}</h5>,
  h5: ({ children }: Children) => <h6>{children}</h6>,
  img: ({ alt }: { alt?: string }) => (alt ? <span>{alt}</span> : null),
  table: ({ children }: Children) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
  // a header cell says which column it heads (the cells below are read with it)
  th: ({ children, style }: Children & { style?: React.CSSProperties }) => (
    <th scope="col" style={style}>
      {children}
    </th>
  ),
};

/**
 * briefs, guides and debriefs: GFM markdown; a table scrolls sideways inside its own wrapper instead of stretching the column.
 * Images are never loaded: scenario text comes from authors, and an external <img> would tell a third party who opens the page
 * (and the CSP allows only same-origin and data: images anyway). The alt text is shown instead.
 * Memoized: the session page re-renders every few seconds, and the same text must not be parsed again each time.
 */
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
      {children}
    </ReactMarkdown>
  );
});
