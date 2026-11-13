-- AlterTable
ALTER TABLE "ChallengeInstance" ADD COLUMN     "flag" TEXT;

-- CreateIndex
CREATE INDEX "ChallengeInstance_flag_idx" ON "ChallengeInstance"("flag");
