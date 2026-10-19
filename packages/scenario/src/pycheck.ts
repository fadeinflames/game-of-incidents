// Syntax check of the Python files in a scenario image folder. The scenario images are Python stand-ins (app.py, loadgen.py, ...),
// and nothing ran them before the image was built and a session started. ast.parse only reads the source, it executes nothing.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import type { LintIssue } from "./lint";
import { isDirectory } from "./load";

const SCRIPT = [
  "import ast, json, sys",
  "out = []",
  "for p in sys.argv[1:]:",
  "    try:",
  "        ast.parse(open(p, 'rb').read(), p)",
  "    except SyntaxError as e:",
  "        out.append([p, e.lineno or 0, e.msg])",
  "    except (ValueError, RecursionError, MemoryError) as e:",
  "        out.append([p, 0, str(e) or type(e).__name__])",
  "print(json.dumps(out))",
].join("\n");

let found: string | null | undefined;
/** the first python 3 interpreter on PATH, or null: the check is skipped on a host without one */
export function findPython(): string | null {
  if (found !== undefined) return found;
  found = null;
  for (const cmd of ["python3", "python"]) {
    const r = spawnSync(cmd, ["-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8", timeout: 10_000 });
    if (r.status === 0 && r.stdout.trim() === "3") {
      found = cmd;
      break;
    }
  }
  return found;
}

/** *.py files under a folder (not through symlinks), at most `limit` of them */
export function pythonFiles(dir: string, limit = 200): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 8 || out.length >= limit) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (out.length >= limit) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(".py")) out.push(p);
    }
  };
  if (isDirectory(dir)) walk(dir, 0);
  return out;
}

/** `python-syntax` errors for the .py files under `dir`; empty when python is not installed or nothing is wrong */
export function pythonSyntaxIssues(dir: string): LintIssue[] {
  const files = pythonFiles(dir);
  const python = findPython();
  if (!files.length || !python) return [];
  const r = spawnSync(python, ["-c", SCRIPT, ...files], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (r.status !== 0) return [{ level: "error", rule: "python-syntax", message: `the syntax check of ${path.basename(dir)} did not finish: ${(r.stderr || r.error?.message || "no output").trim().split("\n").pop()}` }];
  const bad = JSON.parse(r.stdout) as [string, number, string][];
  return bad.map(([file, line, msg]) => ({ level: "error", rule: "python-syntax", message: `${path.relative(dir, file).split(path.sep).join("/")}:${line}: ${msg}` }));
}
