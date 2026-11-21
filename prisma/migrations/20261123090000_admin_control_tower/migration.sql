-- CreateEnum
CREATE TYPE "RefundPayer" AS ENUM ('STORE', 'PLATFORM');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'LOCATION_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'ZONE_PRICING_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'PICKUP_POINT_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'CATEGORY_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'PRODUCT_MERGED';
ALTER TYPE "AuditAction" ADD VALUE 'DISPATCH_OVERRIDE';
ALTER TYPE "AuditAction" ADD VALUE 'DISPUTE_RESOLVED';
ALTER TYPE "AuditAction" ADD VALUE 'PAYOUT_HOLD_UPDATED';

-- AlterEnum
ALTER TYPE "StoreOrderEventType" ADD VALUE 'MOVED_BY_ADMIN';

-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "is_returnable" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "cities" ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "driver_profiles" ADD COLUMN     "max_parcel_value_usd" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "market_orders" ADD COLUMN     "payout_hold_at" TIMESTAMP(3),
ADD COLUMN     "payout_hold_reason" TEXT;

-- AlterTable
ALTER TABLE "pickup_points" ADD COLUMN     "agent_fee_usd" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "max_daily_parcels" INTEGER,
ADD COLUMN     "suburb_id" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "merged_into_id" TEXT;

-- AlterTable
ALTER TABLE "return_requests" ADD COLUMN     "refund_paid_by" "RefundPayer";

-- AlterTable
ALTER TABLE "seller_profiles" ADD COLUMN     "payout_hold_at" TIMESTAMP(3),
ADD COLUMN     "payout_hold_reason" TEXT;

-- AlterTable
ALTER TABLE "store_branches" ADD COLUMN     "location_verified_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "suburbs" ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "zone_id" TEXT;

-- CreateTable
CREATE TABLE "pricing_zones" (
    "id" TEXT NOT NULL,
    "city_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zone_pricing_rules" (
    "id" TEXT NOT NULL,
    "origin_zone_id" TEXT NOT NULL,
    "destination_zone_id" TEXT NOT NULL,
    "vehicle_class" "VehicleClass" NOT NULL,
    "customer_fee_usd" DECIMAL(12,2) NOT NULL,
    "driver_payout_usd" DECIMAL(12,2) NOT NULL,
    "customer_per_km_usd" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "driver_per_km_usd" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zone_pricing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pricing_zones_city_id_code_key" ON "pricing_zones"("city_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "zone_pricing_rules_origin_zone_id_destination_zone_id_vehic_key" ON "zone_pricing_rules"("origin_zone_id", "destination_zone_id", "vehicle_class");

-- CreateIndex
CREATE INDEX "suburbs_zone_id_idx" ON "suburbs"("zone_id");

-- AddForeignKey
ALTER TABLE "suburbs" ADD CONSTRAINT "suburbs_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "pricing_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_points" ADD CONSTRAINT "pickup_points_suburb_id_fkey" FOREIGN KEY ("suburb_id") REFERENCES "suburbs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_zones" ADD CONSTRAINT "pricing_zones_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zone_pricing_rules" ADD CONSTRAINT "zone_pricing_rules_origin_zone_id_fkey" FOREIGN KEY ("origin_zone_id") REFERENCES "pricing_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zone_pricing_rules" ADD CONSTRAINT "zone_pricing_rules_destination_zone_id_fkey" FOREIGN KEY ("destination_zone_id") REFERENCES "pricing_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Custom ──
ALTER TABLE "zone_pricing_rules"
  ADD CONSTRAINT "zone_pricing_rules_amounts_check" CHECK (
    customer_fee_usd >= 0 AND driver_payout_usd >= 0 AND customer_per_km_usd >= 0 AND driver_per_km_usd >= 0
    AND driver_payout_usd <= customer_fee_usd
  );
ALTER TABLE "pickup_points"
  ADD CONSTRAINT "pickup_points_agent_fee_check" CHECK (agent_fee_usd >= 0),
  ADD CONSTRAINT "pickup_points_capacity_check" CHECK (max_daily_parcels IS NULL OR max_daily_parcels > 0);
ALTER TABLE "driver_profiles"
  ADD CONSTRAINT "driver_profiles_max_parcel_check" CHECK (max_parcel_value_usd IS NULL OR max_parcel_value_usd > 0);
ALTER TABLE "products"
  ADD CONSTRAINT "products_not_merged_into_self" CHECK (merged_into_id IS NULL OR merged_into_id <> id);

-- Link existing pickup points to their suburb by name
UPDATE "pickup_points" p SET suburb_id = s.id
FROM "suburbs" s
WHERE p.suburb_id IS NULL AND p.suburb IS NOT NULL AND s.city_id = p.city_id AND lower(s.name) = lower(trim(p.suburb));

CREATE INDEX "market_orders_pickup_point_created_idx" ON "market_orders"("pickup_point_id", "created_at");
