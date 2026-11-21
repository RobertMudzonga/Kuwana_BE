-- AlterEnum
ALTER TYPE "DeliveryTier" ADD VALUE 'STORE_DELIVERY';

-- AlterEnum
ALTER TYPE "MarketOrderStatus" ADD VALUE 'AWAITING_DEPOSIT';

-- AlterTable
ALTER TABLE "market_orders" ADD COLUMN     "cash_due_usd" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "deposit_paid_at" TIMESTAMP(3),
ADD COLUMN     "deposit_usd" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "market_settings" ADD COLUMN     "cod_deposit_required" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "pickup_point_discount_pct" DECIMAL(5,2) NOT NULL DEFAULT 40;

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "distance_km" DECIMAL(6,2),
ADD COLUMN     "driver_fee_usd" DECIMAL(12,2),
ADD COLUMN     "eta_minutes" INTEGER,
ADD COLUMN     "vehicle_class" "VehicleClass";


-- ── Custom ──
ALTER TABLE "market_orders" ADD CONSTRAINT "market_orders_deposit_check" CHECK (deposit_usd >= 0 AND cash_due_usd >= 0 AND deposit_usd + cash_due_usd <= total_usd + 0.01);
ALTER TABLE "market_settings" ADD CONSTRAINT "market_settings_pickup_discount_check" CHECK (pickup_point_discount_pct BETWEEN 0 AND 100);
-- Partner pickup points (development placeholders) get map pins so drivers can be routed there
UPDATE "pickup_points" SET lat = v.lat, lng = v.lng FROM (VALUES
  ('PP-HRE-AVD', -17.7992, 31.0376), ('PP-HRE-BRW', -17.7565, 31.0915), ('PP-HRE-WGT', -17.7815, 30.9855),
  ('PP-HRE-MBR', -17.8615, 31.0365), ('PP-CTG-TC', -18.0105, 31.0745), ('PP-BYO-CBD', -20.1505, 28.5850),
  ('PP-BYO-NKL', -20.1900, 28.5300), ('PP-MUT-CBD', -18.9705, 32.6705), ('PP-GWE-CBD', -19.4510, 29.8165),
  ('PP-MSV-CBD', -20.0745, 30.8330), ('PP-VFA-TWN', -17.9245, 25.8370)
) AS v(code, lat, lng) WHERE pickup_points.code = v.code AND pickup_points.lat IS NULL;
