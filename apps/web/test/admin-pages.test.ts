import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Next.js skips a layout when the request carries a matching Next-Router-State-Tree header, so the layout check alone
// does not protect an admin page. Every page under /admin must check the role itself, as the first statement.
const ADMIN_DIR = path.resolve(__dirname, "../src/app/(app)/admin");

function pageFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return pageFiles(full);
    return /^page\.tsx?$/.test(name) ? [full] : [];
  });
}

/** the first statement of the default exported page function */
function firstStatement(source: string): string | null {
  const head = /export default async function \w+\([\s\S]*?\)\s*\{\s*\n/.exec(source);
  if (!head) return null;
  const rest = source.slice(head.index + head[0].length);
  for (const raw of rest.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("//")) continue;
    return line;
  }
  return null;
}

describe("admin pages", () => {
  const files = pageFiles(ADMIN_DIR);

  it("finds the admin pages (guards the test itself against a moved directory)", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it.each(files.map((f) => [path.relative(ADMIN_DIR, f).replace(/\\/g, "/"), f]))("%s calls requireAdminPage() first", (_name, file) => {
    const first = firstStatement(readFileSync(file, "utf8"));
    expect(first, "default export must be an async function").not.toBeNull();
    expect(first).toMatch(/^(const \w+ = )?await requireAdminPage\(\);?$/);
  });

  it("the helper itself is used by the layout as well", () => {
    expect(readFileSync(path.join(ADMIN_DIR, "layout.tsx"), "utf8")).toContain("await requireAdminPage()");
  });
});
