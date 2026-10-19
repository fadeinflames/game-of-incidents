#!/usr/bin/env node
// `wom` CLI entry: runs the TypeScript sources through tsx (no build step, same as the services).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const r = spawnSync(process.execPath, ["--import", "tsx", cli, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
