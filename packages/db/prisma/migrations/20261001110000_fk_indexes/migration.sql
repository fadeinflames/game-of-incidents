-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Scenario_authorId_idx" ON "Scenario"("authorId");

-- CreateIndex
CREATE INDEX "ScenarioSubmission_scenarioId_idx" ON "ScenarioSubmission"("scenarioId");

-- CreateIndex
CREATE INDEX "TrainingSession_scenarioId_status_idx" ON "TrainingSession"("scenarioId", "status");

-- CreateIndex
CREATE INDEX "TrainingSession_userId_createdAt_idx" ON "TrainingSession"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "TrainingSession_status_createdAt_idx" ON "TrainingSession"("status", "createdAt");
