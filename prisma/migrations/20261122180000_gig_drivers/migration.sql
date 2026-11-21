-- CreateEnum
CREATE TYPE "DriverWalletBucket" AS ENUM ('FLOAT', 'EARNINGS');

-- CreateEnum
CREATE TYPE "DriverWithdrawalStatus" AS ENUM ('REQUESTED', 'PAID', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'DRIVER_KYC_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'DRIVER_WALLET_UPDATED';

-- AlterEnum
ALTER TYPE "PaymentPurpose" ADD VALUE 'DRIVER_FLOAT';

-- AlterTable
ALTER TABLE "delivery_jobs" ADD COLUMN     "fail_note" TEXT,
ADD COLUMN     "fail_reason" TEXT,
ADD COLUMN     "failed_at" TIMESTAMP(3),
ADD COLUMN     "returned_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "market_settings" ADD COLUMN     "driver_max_active_jobs" INTEGER NOT NULL DEFAULT 3;

-- CreateTable
CREATE TABLE "driver_withdrawals" (
    "id" TEXT NOT NULL,
    "driver_id" TEXT NOT NULL,
    "bucket" "DriverWalletBucket" NOT NULL,
    "amount_usd" DECIMAL(12,2) NOT NULL,
    "method" TEXT NOT NULL,
    "destination" JSONB NOT NULL,
    "status" "DriverWithdrawalStatus" NOT NULL DEFAULT 'REQUESTED',
    "external_ref" TEXT,
    "note" TEXT,
    "handled_by_id" TEXT,
    "handled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "driver_withdrawals_status_created_at_idx" ON "driver_withdrawals"("status", "created_at");

-- CreateIndex
CREATE INDEX "driver_withdrawals_driver_id_created_at_idx" ON "driver_withdrawals"("driver_id", "created_at");

-- AddForeignKey
ALTER TABLE "driver_withdrawals" ADD CONSTRAINT "driver_withdrawals_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "driver_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Custom ──
ALTER TABLE "driver_withdrawals" ADD CONSTRAINT "driver_withdrawals_amount_positive" CHECK (amount_usd > 0);
ALTER TABLE "market_settings" ADD CONSTRAINT "market_settings_driver_jobs_check" CHECK (driver_max_active_jobs BETWEEN 1 AND 10);
-- Online, approved drivers are matched to jobs by distance
CREATE INDEX "driver_profiles_online_idx" ON "driver_profiles" ("vehicle_class") WHERE is_online AND kyc_status = 'APPROVED';
