-- AlterTable
ALTER TABLE "ContainerConfig" ADD COLUMN     "testAccessUrl" TEXT,
ADD COLUMN     "testContainerId" TEXT,
ADD COLUMN     "testExpiresAt" TIMESTAMP(3),
ADD COLUMN     "testState" TEXT;
