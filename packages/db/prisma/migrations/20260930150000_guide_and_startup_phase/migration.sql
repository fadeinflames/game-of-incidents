-- teaching stages per scenario + provisioning phase per session
ALTER TABLE "Scenario" ADD COLUMN "guideMd" TEXT;
ALTER TABLE "TrainingSession" ADD COLUMN "startupPhase" TEXT;
