-- CreateEnum
CREATE TYPE "StoreOrderEventType" AS ENUM ('ACCEPTED', 'READY', 'TIMED_OUT', 'OUT_OF_STOCK', 'REASSIGNED_IN');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'STORE_STAFF';

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "accept_by" TIMESTAMP(3),
ADD COLUMN     "accepted_at" TIMESTAMP(3),
ADD COLUMN     "accepted_by_id" TEXT,
ADD COLUMN     "reassign_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "store_branch_id" TEXT;

-- CreateTable
CREATE TABLE "store_order_events" (
    "id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "type" "StoreOrderEventType" NOT NULL,
    "on_time" BOOLEAN,
    "note" TEXT,
    "actor_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_order_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "store_order_events_seller_id_created_at_idx" ON "store_order_events"("seller_id", "created_at");

-- CreateIndex
CREATE INDEX "store_order_events_shipment_id_idx" ON "store_order_events"("shipment_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_store_branch_id_fkey" FOREIGN KEY ("store_branch_id") REFERENCES "store_branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_order_events" ADD CONSTRAINT "store_order_events_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_order_events" ADD CONSTRAINT "store_order_events_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_order_events" ADD CONSTRAINT "store_order_events_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "store_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Custom: the SLA sweep looks for unaccepted store parcels past their deadline ──
CREATE INDEX "shipments_store_accept_idx" ON "shipments" ("accept_by") WHERE accepted_at IS NULL AND store_branch_id IS NOT NULL;
