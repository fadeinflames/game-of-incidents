// Pre-pull the public images that scenarios load into kind (postgres, ingress-nginx, cert-manager, ...), so that the
// first session of a heavy scenario does not spend its provisioning budget on `docker pull`.
// Usage: npx tsx scripts/prepull-images.ts [scenarios-dir]   (DOCKER_HOST as for the sandbox daemon)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { loadScenarioFolder, prepullImages } from "@wom/scenario";

const dir = path.resolve(process.argv[2] ?? "scenarios");
const images = new Set<string>();
for (const entry of readdirSync(dir, { withFileTypes: true })) {
  const p = path.join(dir, entry.name);
  if (!entry.isDirectory() || !existsSync(path.join(p, "scenario.yaml"))) continue;
  try {
    const b = loadScenarioFolder(p);
    for (const img of prepullImages(b.meta.environment)) images.add(img);
  } catch (e) {
    console.error(`prepull: skipping ${entry.name}: ${(e as Error).message}`);
  }
}
let pulled = 0;
for (const img of [...images].sort()) {
  try {
    execFileSync("docker", ["image", "inspect", img], { stdio: "ignore" });
    console.log(`prepull: present ${img}`);
  } catch {
    console.log(`prepull: pulling ${img}`);
    try {
      execFileSync("docker", ["pull", "--platform", "linux/amd64", img], { stdio: ["ignore", "ignore", "inherit"] });
      pulled++;
    } catch (e) {
      console.error(`prepull: FAILED ${img}: ${(e as Error).message}`);
    }
  }
}
console.log(`prepull: ${images.size} public image(s), ${pulled} pulled`);
