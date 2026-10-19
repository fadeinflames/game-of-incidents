-- queue time before provisioning must not count towards the provisioning timeout
ALTER TABLE "TrainingSession" ADD COLUMN "provisioningStartedAt" TIMESTAMP(3);
