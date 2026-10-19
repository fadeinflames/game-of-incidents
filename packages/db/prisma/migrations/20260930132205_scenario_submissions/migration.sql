-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('UPLOADED', 'LINT_FAILED', 'TESTING', 'PASSED', 'FAILED', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Scenario" ADD COLUMN     "authorId" TEXT;

-- CreateTable
CREATE TABLE "ScenarioSubmission" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'UPLOADED',
    "archive" BYTEA NOT NULL,
    "record" JSONB,
    "lintReport" JSONB,
    "testReport" JSONB,
    "moderatorNote" TEXT,
    "scenarioId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScenarioSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScenarioSubmission_authorId_createdAt_idx" ON "ScenarioSubmission"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "ScenarioSubmission_status_createdAt_idx" ON "ScenarioSubmission"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "Scenario" ADD CONSTRAINT "Scenario_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScenarioSubmission" ADD CONSTRAINT "ScenarioSubmission_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScenarioSubmission" ADD CONSTRAINT "ScenarioSubmission_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "Scenario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
