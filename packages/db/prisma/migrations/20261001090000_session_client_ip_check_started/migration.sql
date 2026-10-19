-- per-address session quota (clientIp) and the stuck-check watchdog (checkStartedAt)
ALTER TABLE "TrainingSession" ADD COLUMN "checkStartedAt" TIMESTAMP(3),
ADD COLUMN "clientIp" TEXT;

-- CreateIndex
CREATE INDEX "TrainingSession_clientIp_status_idx" ON "TrainingSession"("clientIp", "status");
