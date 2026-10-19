// Seeds the demo user and every scenario folder under scenarios/ using the same loader as the CLI and the import endpoint.
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { loadScenarioFolder, lintBundle, toImportRecord, TUTORIAL_SUFFIX } from "@wom/scenario";
import { upsertImportRecord } from "../src/import";

const prisma = new PrismaClient();
const here = path.dirname(fileURLToPath(import.meta.url));
const scenariosDir = path.resolve(here, "../../../scenarios");

async function main() {
  // Users: production seeds the administrator from ADMIN_*; the demo account exists only outside production.
  if (process.env.ADMIN_USERNAME && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const username = process.env.ADMIN_USERNAME.toLowerCase();
    const email = process.env.ADMIN_EMAIL.toLowerCase();
    // The administrator may already be in the database under either name: a restored dump keeps the real e-mail of the
    // account, while ADMIN_EMAIL of a fresh install is a placeholder. Never create a second user, never rotate a password.
    const existing = await prisma.user.findFirst({ where: { OR: [{ username }, { email }] }, select: { id: true, username: true } });
    if (existing) {
      await prisma.user.update({ where: { id: existing.id }, data: { role: "admin" } });
      console.log(`seed: admin ${existing.username} already exists (password and e-mail kept)`);
    } else {
      const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
      await prisma.user.create({ data: { email, username, passwordHash, role: "admin" } });
      console.log(`seed: admin ${username} created`);
    }
  }
  if (process.env.NODE_ENV !== "production" || process.env.SEED_DEMO_PASSWORD) {
    const passwordHash = await bcrypt.hash(process.env.SEED_DEMO_PASSWORD ?? "demo1234", 10);
    await prisma.user.upsert({
      where: { email: "demo@wom.local" },
      update: { passwordHash },
      create: { email: "demo@wom.local", username: "demo", passwordHash, role: "admin" },
    });
    console.log("seed: user demo");
  } else {
    console.log("seed: production, demo user skipped");
  }

  // every folder that is still in the repository, with or without a lint error: a scenario that is merely broken keeps
  // its published version until it is fixed
  const inRepo = new Set<string>();
  for (const entry of readdirSync(scenariosDir, { withFileTypes: true })) {
    const dir = path.join(scenariosDir, entry.name);
    if (!entry.isDirectory() || !existsSync(path.join(dir, "scenario.yaml"))) continue;
    const bundle = loadScenarioFolder(dir);
    inRepo.add(bundle.meta.slug);
    inRepo.add(bundle.meta.slug + TUTORIAL_SUFFIX);
    const errors = lintBundle(bundle).filter((i) => i.level === "error");
    if (errors.length) {
      console.error(`seed: skipping ${entry.name}: ${errors.map((e) => e.message).join("; ")}`);
      continue;
    }
    await upsertImportRecord(prisma, toImportRecord(bundle), { source: "seed" });
    console.log(`seed: scenario ${bundle.meta.slug}`);
  }

  // A scenario deleted or renamed in the repository would otherwise stay in the catalogue with an image nobody builds.
  // Only rows the seed itself created are touched: the ones an admin imported or a moderator published stay.
  // An empty folder list means a wrong path, not "everything was deleted".
  if (inRepo.size) {
    const gone = await prisma.scenario.findMany({ where: { source: "seed", authorId: null, isPublished: true, slug: { notIn: [...inRepo] } }, select: { slug: true } });
    if (gone.length) {
      await prisma.scenario.updateMany({ where: { slug: { in: gone.map((g) => g.slug) }, source: "seed" }, data: { isPublished: false } });
      console.log(`seed: unpublished, no longer in scenarios/: ${gone.map((g) => g.slug).join(", ")}`);
    }
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
