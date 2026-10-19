-- The scenario a session runs on, as it was when the session was requested (grader, break script, hints, environment):
-- a re-import of the scenario while the session is running must not change what its check and its hints are. Nullable and
-- additive: rows from before the migration keep working (the live scenario is used), the previous release ignores the column.
-- Reverse: ALTER TABLE "TrainingSession" DROP COLUMN "scenarioSnapshot";
ALTER TABLE "TrainingSession" ADD COLUMN "scenarioSnapshot" JSONB;
