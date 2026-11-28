ALTER TABLE "GameConfig" ADD COLUMN "suspendInstances" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "instancePauseStartedAt" TIMESTAMP(3),
ADD COLUMN "instanceControllerHeartbeat" TIMESTAMP(3);
ALTER TABLE "ChallengeInstance" ADD COLUMN "suspensionStartedAt" TIMESTAMP(3),
ADD COLUMN "suspensionError" TEXT,
ADD COLUMN "suspensionCheckedAt" TIMESTAMP(3);
