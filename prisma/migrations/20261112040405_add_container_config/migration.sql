-- CreateTable
CREATE TABLE "ContainerConfig" (
    "challengeId" TEXT NOT NULL,
    "dockerfile" TEXT NOT NULL,
    "buildState" TEXT NOT NULL DEFAULT 'QUEUED',
    "buildId" TEXT,
    "imageDigest" TEXT,
    "buildLog" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContainerConfig_pkey" PRIMARY KEY ("challengeId")
);

-- AddForeignKey
ALTER TABLE "ContainerConfig" ADD CONSTRAINT "ContainerConfig_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "Challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;
