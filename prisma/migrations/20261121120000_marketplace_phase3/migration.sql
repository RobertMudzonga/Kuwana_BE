-- CreateEnum
CREATE TYPE "InboundStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('REQUESTED', 'APPROVED', 'PAID', 'REJECTED');

-- CreateEnum
CREATE TYPE "PayoutMethod" AS ENUM ('USD_BANK', 'ZWG_BANK', 'ECOCASH_MERCHANT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'INBOUND_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE 'INBOUND_RECEIVED';
ALTER TYPE "AuditAction" ADD VALUE 'SHIPMENT_STATUS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'PAYOUT_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE 'PAYOUT_UPDATED';

-- AlterTable
ALTER TABLE "ledger_entries" ADD COLUMN     "payout_id" TEXT;

-- AlterTable
ALTER TABLE "market_orders" ADD COLUMN     "pin_attempts" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "market_settings" ADD COLUMN     "min_payout_usd" DECIMAL(12,2) NOT NULL DEFAULT 10,
ADD COLUMN     "seller_hold_days" INTEGER NOT NULL DEFAULT 7;

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "courier_name" TEXT,
ADD COLUMN     "delivered_at" TIMESTAMP(3),
ADD COLUMN     "dispatched_at" TIMESTAMP(3),
ADD COLUMN     "dispatched_on_time" BOOLEAN,
ADD COLUMN     "packed_at" TIMESTAMP(3),
ADD COLUMN     "tracking_number" TEXT;

-- CreateTable
CREATE TABLE "inbound_shipments" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "hub_id" TEXT NOT NULL,
    "status" "InboundStatus" NOT NULL DEFAULT 'DRAFT',
    "expected_arrival" TIMESTAMP(3),
    "carrier" TEXT,
    "notes" TEXT,
    "submitted_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "received_by_id" TEXT,
    "receiving_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbound_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_shipment_items" (
    "id" TEXT NOT NULL,
    "inbound_id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "quantity_expected" INTEGER NOT NULL,
    "quantity_received" INTEGER,
    "quantity_damaged" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "inbound_shipment_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "method" "PayoutMethod" NOT NULL,
    "amount_usd" DECIMAL(14,2) NOT NULL,
    "amount_tx" DECIMAL(14,2) NOT NULL,
    "exchange_rate" DECIMAL(18,6) NOT NULL,
    "destination" JSONB NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'REQUESTED',
    "external_ref" TEXT,
    "note" TEXT,
    "processed_by_id" TEXT,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inbound_shipments_reference_key" ON "inbound_shipments"("reference");

-- CreateIndex
CREATE INDEX "inbound_shipments_seller_id_created_at_idx" ON "inbound_shipments"("seller_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "inbound_shipments_hub_id_status_idx" ON "inbound_shipments"("hub_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_shipment_items_inbound_id_offer_id_key" ON "inbound_shipment_items"("inbound_id", "offer_id");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_reference_key" ON "payouts"("reference");

-- CreateIndex
CREATE INDEX "payouts_seller_id_created_at_idx" ON "payouts"("seller_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "payouts_status_idx" ON "payouts"("status");

-- AddForeignKey
ALTER TABLE "inbound_shipments" ADD CONSTRAINT "inbound_shipments_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "seller_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_shipments" ADD CONSTRAINT "inbound_shipments_hub_id_fkey" FOREIGN KEY ("hub_id") REFERENCES "hubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_shipment_items" ADD CONSTRAINT "inbound_shipment_items_inbound_id_fkey" FOREIGN KEY ("inbound_id") REFERENCES "inbound_shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_shipment_items" ADD CONSTRAINT "inbound_shipment_items_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "seller_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written integrity rules
ALTER TABLE "inbound_shipment_items" ADD CONSTRAINT "inbound_items_expected_positive" CHECK ("quantity_expected" > 0);
ALTER TABLE "inbound_shipment_items" ADD CONSTRAINT "inbound_items_counts_non_negative"
  CHECK (("quantity_received" IS NULL OR "quantity_received" >= 0) AND "quantity_damaged" >= 0);
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_amount_positive" CHECK ("amount_usd" > 0 AND "amount_tx" > 0);
