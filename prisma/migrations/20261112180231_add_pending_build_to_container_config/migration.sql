-- AlterTable
ALTER TABLE "ContainerConfig" ADD COLUMN     "pendingDigest" TEXT,
ADD COLUMN     "pendingLog" TEXT,
ADD COLUMN     "pendingState" TEXT;
