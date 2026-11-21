-- CreateEnum
CREATE TYPE "CodRemittanceStatus" AS ENUM ('COLLECTED', 'VERIFIED', 'DISCREPANCY');

-- CreateEnum
CREATE TYPE "ReturnReason" AS ENUM ('DEFECTIVE', 'WRONG_ITEM', 'DAMAGED_IN_TRANSIT', 'NOT_AS_DESCRIBED');

-- CreateEnum
CREATE TYPE "ReturnMethod" AS ENUM ('DROP_OFF', 'COURIER_COLLECTION');

-- CreateEnum
CREATE TYPE "RefundDestination" AS ENUM ('WALLET', 'ORIGINAL');

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('APPROVED', 'DROPPED_OFF', 'RECEIVED', 'REFUNDED', 'REJECTED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'COD_VERIFIED';
ALTER TYPE "AuditAction" ADD VALUE 'RETURN_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'STAFF_UPDATED';

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'PICKUP_AGENT';

-- AlterTable
ALTER TABLE "market_settings" ADD COLUMN     "max_delivery_attempts" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "return_window_days" INTEGER NOT NULL DEFAULT 7;

-- AlterTable
ALTER TABLE "offers" ADD COLUMN     "bin_location" TEXT;

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "delivery_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "driver_id" TEXT,
ADD COLUMN     "handed_over_by_id" TEXT,
ADD COLUMN     "last_attempt_note" TEXT,
ADD COLUMN     "out_for_delivery_at" TIMESTAMP(3),
ADD COLUMN     "ready_for_collection_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "hub_id" TEXT,
ADD COLUMN     "pickup_point_id" TEXT;

-- CreateTable
CREATE TABLE "cod_remittances" (
    "id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "collector_id" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "expected_amount" DECIMAL(14,2) NOT NULL,
    "collected_amount" DECIMAL(14,2) NOT NULL,
    "status" "CodRemittanceStatus" NOT NULL DEFAULT 'COLLECTED',
    "collected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_by_id" TEXT,
    "verified_at" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "cod_remittances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_requests" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "reason" "ReturnReason" NOT NULL,
    "details" TEXT,
    "method" "ReturnMethod" NOT NULL,
    "pickup_point_id" TEXT,
    "refund_destination" "RefundDestination" NOT NULL,
    "status" "ReturnStatus" NOT NULL DEFAULT 'APPROVED',
    "refund_usd" DECIMAL(12,2),
    "refund_manual" BOOLEAN NOT NULL DEFAULT false,
    "inspection_note" TEXT,
    "seller_at_fault" BOOLEAN,
    "dropped_off_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "handled_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "return_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_items" (
    "id" TEXT NOT NULL,
    "return_id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "resellable" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "return_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cod_remittances_shipment_id_key" ON "cod_remittances"("shipment_id");

-- CreateIndex
CREATE INDEX "cod_remittances_collector_id_status_idx" ON "cod_remittances"("collector_id", "status");

-- CreateIndex
CREATE INDEX "cod_remittances_status_idx" ON "cod_remittances"("status");

-- CreateIndex
CREATE UNIQUE INDEX "return_requests_reference_key" ON "return_requests"("reference");

-- CreateIndex
CREATE INDEX "return_requests_order_id_idx" ON "return_requests"("order_id");

-- CreateIndex
CREATE INDEX "return_requests_status_created_at_idx" ON "return_requests"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "return_items_return_id_order_item_id_key" ON "return_items"("return_id", "order_item_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_hub_id_fkey" FOREIGN KEY ("hub_id") REFERENCES "hubs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_pickup_point_id_fkey" FOREIGN KEY ("pickup_point_id") REFERENCES "pickup_points"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_remittances" ADD CONSTRAINT "cod_remittances_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_remittances" ADD CONSTRAINT "cod_remittances_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "market_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_remittances" ADD CONSTRAINT "cod_remittances_collector_id_fkey" FOREIGN KEY ("collector_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "market_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_pickup_point_id_fkey" FOREIGN KEY ("pickup_point_id") REFERENCES "pickup_points"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "return_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "market_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written integrity rules
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_dropoff_needs_point"
  CHECK ("method" <> 'DROP_OFF' OR "pickup_point_id" IS NOT NULL);
ALTER TABLE "cod_remittances" ADD CONSTRAINT "cod_remittances_amounts_non_negative"
  CHECK ("expected_amount" >= 0 AND "collected_amount" >= 0);
