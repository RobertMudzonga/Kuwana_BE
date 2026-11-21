-- CreateEnum
CREATE TYPE "VehicleClass" AS ENUM ('BIKE', 'CAR', 'BAKKIE');

-- CreateEnum
CREATE TYPE "DropoffType" AS ENUM ('ADDRESS', 'PICKUP_POINT');

-- CreateEnum
CREATE TYPE "DeliveryJobStatus" AS ENUM ('AWAITING_STORE', 'OPEN', 'CLAIMED', 'IN_TRANSIT', 'DELIVERED', 'RETURNING', 'RETURNED_TO_STORE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DriverWalletEntryType" AS ENUM ('FLOAT_DEPOSIT', 'FLOAT_WITHDRAWAL', 'COLLATERAL_LOCK', 'COLLATERAL_RELEASE', 'COD_OFFSET', 'DELIVERY_EARNING', 'EARNINGS_WITHDRAWAL', 'PENALTY', 'ADJUSTMENT');

-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "required_vehicle_class" "VehicleClass" NOT NULL DEFAULT 'BIKE';

-- AlterTable
ALTER TABLE "market_settings" ADD COLUMN     "collateral_buffer_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "escrow_hold_hours" INTEGER NOT NULL DEFAULT 48,
ADD COLUMN     "hubs_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "job_broadcast_radius_km" DECIMAL(6,2) NOT NULL DEFAULT 8,
ADD COLUMN     "max_delivery_radius_km" DECIMAL(6,2) NOT NULL DEFAULT 40,
ADD COLUMN     "store_accept_sla_minutes" INTEGER NOT NULL DEFAULT 15;

-- AlterTable
ALTER TABLE "offers" ADD COLUMN     "prep_time_mins" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "store_branch_id" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "required_vehicle_class" "VehicleClass";

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "store_branch_id" TEXT;

-- AlterTable
ALTER TABLE "suburbs" ADD COLUMN     "lat" DOUBLE PRECISION,
ADD COLUMN     "lng" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "store_branches" (
    "id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city_id" TEXT NOT NULL,
    "suburb_id" TEXT,
    "address" TEXT NOT NULL,
    "landmark" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "geom" geography(Point, 4326),
    "phone" TEXT,
    "operating_hours" JSONB NOT NULL DEFAULT '{}',
    "is_paused" BOOLEAN NOT NULL DEFAULT false,
    "default_prep_time_mins" INTEGER NOT NULL DEFAULT 30,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_fee_bands" (
    "id" TEXT NOT NULL,
    "vehicle_class" "VehicleClass" NOT NULL,
    "max_km" DECIMAL(6,2) NOT NULL,
    "customer_fee_usd" DECIMAL(12,2) NOT NULL,
    "driver_fee_usd" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_fee_bands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "national_id" TEXT NOT NULL,
    "license_number" TEXT,
    "license_expiry" DATE,
    "vehicle_class" "VehicleClass" NOT NULL,
    "vehicle_reg" TEXT,
    "vehicle_description" TEXT,
    "id_doc_url" TEXT,
    "license_doc_url" TEXT,
    "selfie_url" TEXT,
    "kyc_status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "city_id" TEXT,
    "is_online" BOOLEAN NOT NULL DEFAULT false,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "geom" geography(Point, 4326),
    "location_updated_at" TIMESTAMP(3),
    "rating_avg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rating_count" INTEGER NOT NULL DEFAULT 0,
    "completed_jobs" INTEGER NOT NULL DEFAULT 0,
    "approved_at" TIMESTAMP(3),
    "approved_by" TEXT,
    "rejection_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_wallets" (
    "driver_id" TEXT NOT NULL,
    "available_float_usd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "locked_float_usd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "withdrawable_earnings_usd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_wallets_pkey" PRIMARY KEY ("driver_id")
);

-- CreateTable
CREATE TABLE "driver_wallet_entries" (
    "id" TEXT NOT NULL,
    "driver_id" TEXT NOT NULL,
    "type" "DriverWalletEntryType" NOT NULL,
    "available_delta_usd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "locked_delta_usd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "earnings_delta_usd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "available_after_usd" DECIMAL(12,2) NOT NULL,
    "locked_after_usd" DECIMAL(12,2) NOT NULL,
    "earnings_after_usd" DECIMAL(12,2) NOT NULL,
    "delivery_job_id" TEXT,
    "reference" TEXT,
    "memo" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_wallet_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_jobs" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "pickup_branch_id" TEXT NOT NULL,
    "dropoff_type" "DropoffType" NOT NULL,
    "pickup_point_id" TEXT,
    "dropoff_address" JSONB,
    "dropoff_lat" DOUBLE PRECISION,
    "dropoff_lng" DOUBLE PRECISION,
    "recipient_name" TEXT NOT NULL,
    "recipient_phone" TEXT NOT NULL,
    "vehicle_required" "VehicleClass" NOT NULL,
    "distance_km" DECIMAL(6,2) NOT NULL,
    "customer_fee_usd" DECIMAL(12,2) NOT NULL,
    "driver_fee_usd" DECIMAL(12,2) NOT NULL,
    "parcel_value_usd" DECIMAL(12,2) NOT NULL,
    "cod_amount_usd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "collateral_required_usd" DECIMAL(12,2) NOT NULL,
    "pickup_pin_hash" TEXT,
    "delivery_otp_hash" TEXT,
    "pin_attempts" INTEGER NOT NULL DEFAULT 0,
    "otp_attempts" INTEGER NOT NULL DEFAULT 0,
    "status" "DeliveryJobStatus" NOT NULL DEFAULT 'AWAITING_STORE',
    "driver_id" TEXT,
    "broadcast_at" TIMESTAMP(3),
    "claimed_at" TIMESTAMP(3),
    "picked_up_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "store_branches_code_key" ON "store_branches"("code");

-- CreateIndex
CREATE INDEX "store_branches_seller_id_idx" ON "store_branches"("seller_id");

-- CreateIndex
CREATE INDEX "store_branches_city_id_is_active_idx" ON "store_branches"("city_id", "is_active");

-- CreateIndex
CREATE INDEX "store_branches_geom_idx" ON "store_branches" USING GIST ("geom");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_fee_bands_vehicle_class_max_km_key" ON "delivery_fee_bands"("vehicle_class", "max_km");

-- CreateIndex
CREATE UNIQUE INDEX "driver_profiles_user_id_key" ON "driver_profiles"("user_id");

-- CreateIndex
CREATE INDEX "driver_profiles_kyc_status_idx" ON "driver_profiles"("kyc_status");

-- CreateIndex
CREATE INDEX "driver_profiles_is_online_vehicle_class_idx" ON "driver_profiles"("is_online", "vehicle_class");

-- CreateIndex
CREATE INDEX "driver_profiles_geom_idx" ON "driver_profiles" USING GIST ("geom");

-- CreateIndex
CREATE INDEX "driver_wallet_entries_driver_id_created_at_idx" ON "driver_wallet_entries"("driver_id", "created_at");

-- CreateIndex
CREATE INDEX "driver_wallet_entries_delivery_job_id_idx" ON "driver_wallet_entries"("delivery_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_jobs_reference_key" ON "delivery_jobs"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_jobs_shipment_id_key" ON "delivery_jobs"("shipment_id");

-- CreateIndex
CREATE INDEX "delivery_jobs_status_vehicle_required_idx" ON "delivery_jobs"("status", "vehicle_required");

-- CreateIndex
CREATE INDEX "delivery_jobs_driver_id_status_idx" ON "delivery_jobs"("driver_id", "status");

-- CreateIndex
CREATE INDEX "delivery_jobs_pickup_branch_id_status_idx" ON "delivery_jobs"("pickup_branch_id", "status");

-- CreateIndex
CREATE INDEX "offers_store_branch_id_idx" ON "offers"("store_branch_id");

-- CreateIndex
CREATE INDEX "shipments_store_branch_id_status_idx" ON "shipments"("store_branch_id", "status");

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_store_branch_id_fkey" FOREIGN KEY ("store_branch_id") REFERENCES "store_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_store_branch_id_fkey" FOREIGN KEY ("store_branch_id") REFERENCES "store_branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_branches" ADD CONSTRAINT "store_branches_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_branches" ADD CONSTRAINT "store_branches_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_branches" ADD CONSTRAINT "store_branches_suburb_id_fkey" FOREIGN KEY ("suburb_id") REFERENCES "suburbs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_profiles" ADD CONSTRAINT "driver_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_profiles" ADD CONSTRAINT "driver_profiles_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_wallets" ADD CONSTRAINT "driver_wallets_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "driver_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_wallet_entries" ADD CONSTRAINT "driver_wallet_entries_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "driver_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_wallet_entries" ADD CONSTRAINT "driver_wallet_entries_delivery_job_id_fkey" FOREIGN KEY ("delivery_job_id") REFERENCES "delivery_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_pickup_branch_id_fkey" FOREIGN KEY ("pickup_branch_id") REFERENCES "store_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_pickup_point_id_fkey" FOREIGN KEY ("pickup_point_id") REFERENCES "pickup_points"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "driver_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Custom: geography columns follow lat/lng ─────────────────
CREATE OR REPLACE FUNCTION sync_geom_from_lat_lng() RETURNS trigger AS $$
BEGIN
  IF NEW.lat IS NULL OR NEW.lng IS NULL THEN
    NEW.geom := NULL;
  ELSE
    NEW.geom := ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326)::geography;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER store_branches_geom BEFORE INSERT OR UPDATE OF lat, lng ON "store_branches"
  FOR EACH ROW EXECUTE FUNCTION sync_geom_from_lat_lng();
CREATE TRIGGER driver_profiles_geom BEFORE INSERT OR UPDATE OF lat, lng ON "driver_profiles"
  FOR EACH ROW EXECUTE FUNCTION sync_geom_from_lat_lng();

ALTER TABLE "store_branches" ADD CONSTRAINT "store_branches_lat_lng_check"
  CHECK (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180);

-- ── Custom: driver wallet balances never go negative ─────────
ALTER TABLE "driver_wallets" ADD CONSTRAINT "driver_wallets_non_negative" CHECK (
  available_float_usd >= 0 AND locked_float_usd >= 0 AND withdrawable_earnings_usd >= 0);

ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_amounts_check" CHECK (
  customer_fee_usd >= 0 AND driver_fee_usd >= 0 AND parcel_value_usd >= 0
  AND cod_amount_usd >= 0 AND collateral_required_usd >= 0 AND distance_km >= 0);

ALTER TABLE "offers" ADD CONSTRAINT "offers_prep_time_check" CHECK (prep_time_mins BETWEEN 0 AND 1440);

-- ── Custom: driver wallet entries are append-only ────────────
-- DELETE is allowed only inside a transaction that sets kuwana.ledger_maintenance = 'on' (tests)
CREATE OR REPLACE FUNCTION driver_wallet_entries_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('kuwana.ledger_maintenance', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'driver_wallet_entries is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER driver_wallet_entries_no_update BEFORE UPDATE OR DELETE ON "driver_wallet_entries"
  FOR EACH ROW EXECUTE FUNCTION driver_wallet_entries_immutable();

-- ── Custom: default delivery fee bands (admin-editable) ──────
INSERT INTO "delivery_fee_bands" (id, vehicle_class, max_km, customer_fee_usd, driver_fee_usd, updated_at) VALUES
  (gen_random_uuid()::text, 'BIKE',    3,  2.50,  1.80, now()),
  (gen_random_uuid()::text, 'BIKE',    7,  3.50,  2.50, now()),
  (gen_random_uuid()::text, 'BIKE',   15,  5.00,  3.60, now()),
  (gen_random_uuid()::text, 'BIKE',   25,  7.00,  5.00, now()),
  (gen_random_uuid()::text, 'BIKE',   40,  9.50,  7.00, now()),
  (gen_random_uuid()::text, 'CAR',     7,  5.00,  3.80, now()),
  (gen_random_uuid()::text, 'CAR',    15,  7.00,  5.20, now()),
  (gen_random_uuid()::text, 'CAR',    25,  9.00,  6.80, now()),
  (gen_random_uuid()::text, 'CAR',    40, 12.00,  9.00, now()),
  (gen_random_uuid()::text, 'BAKKIE', 10, 12.00,  9.00, now()),
  (gen_random_uuid()::text, 'BAKKIE', 25, 18.00, 14.00, now()),
  (gen_random_uuid()::text, 'BAKKIE', 40, 25.00, 19.00, now());
