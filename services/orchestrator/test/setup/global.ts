// Runs once per vitest run. The integration tests skip themselves without DATABASE_URL, which makes a bare `npm test`
// green without having tested anything: WOM_TEST_REQUIRE_DB=1 (Makefile, deploy, pre-push) turns that into a failure.
import { PrismaClient } from "@wom/db";
import { assertTestDatabase } from "./guard";

/** scenarios the integration tests publish; they must never outlive the run, even when it crashed */
const TEST_SLUGS = ["test-scn", "test-k8s", "test-snap", "test-appr-one", "test-appr-one-tutorial"];

async function unpublishTestScenarios(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await prisma.scenario.updateMany({ where: { slug: { in: TEST_SLUGS } }, data: { isPublished: false } });
  } finally {
    await prisma.$disconnect();
  }
}

export default async function setup(): Promise<(() => Promise<void>) | void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (process.env.WOM_TEST_REQUIRE_DB === "1") {
      throw new Error("WOM_TEST_REQUIRE_DB=1, but DATABASE_URL is not set: the integration tests would be skipped silently");
    }
    console.warn("[wom-test] DATABASE_URL is not set: the integration tests are skipped (set WOM_TEST_REQUIRE_DB=1 to make that an error)");
    return;
  }
  assertTestDatabase(url);
  await unpublishTestScenarios(); // what a crashed previous run left in the catalogue
  return unpublishTestScenarios;
}
