-- CreateTable
CREATE TABLE "ChallengeInstance" (
    "id" TEXT NOT NULL,
    "challengeId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "containerId" TEXT,
    "imageDigest" TEXT,
    "token" TEXT,
    "accessUrl" TEXT,
    "terminalUrl" TEXT,
    "vpnIp" TEXT,
    "portMap" JSONB,
    "expiresAt" TIMESTAMP(3),
    "startCount" INTEGER NOT NULL DEFAULT 0,
    "lastLog" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChallengeInstance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChallengeInstance_state_idx" ON "ChallengeInstance"("state");

-- CreateIndex
CREATE INDEX "ChallengeInstance_expiresAt_idx" ON "ChallengeInstance"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChallengeInstance_challengeId_teamId_key" ON "ChallengeInstance"("challengeId", "teamId");

-- AddForeignKey
ALTER TABLE "ChallengeInstance" ADD CONSTRAINT "ChallengeInstance_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "Challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChallengeInstance" ADD CONSTRAINT "ChallengeInstance_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
