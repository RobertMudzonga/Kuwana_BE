-- Ordering platform: multi-item orders, store settings, options, deliveries,
-- addresses, favourites, push devices, phone verification, promos, SOS alerts.
-- Existing single-service orders are converted to orders with one order item.

-- CreateEnum
CREATE TYPE "FulfilmentType" AS ENUM ('DELIVERY', 'COLLECTION');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('ECOCASH', 'ONEMONEY', 'CARD', 'CASH');

-- CreateEnum
CREATE TYPE "OrderPaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('AVAILABLE', 'ASSIGNED', 'PICKED_UP', 'DELIVERED', 'CANCELLED', 'SELF_DELIVERED');

-- CreateEnum
CREATE TYPE "PromoType" AS ENUM ('PERCENT', 'FIXED');

-- CreateEnum
CREATE TYPE "EmergencyAlertStatus" AS ENUM ('OPEN', 'RESOLVED');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'DRIVER';
ALTER TYPE "PaymentGateway" ADD VALUE 'MOCK';
ALTER TYPE "AuditAction" ADD VALUE 'DELIVERY_ACCEPTED';
ALTER TYPE "AuditAction" ADD VALUE 'DELIVERY_STATUS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'REVIEW_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'SETTINGS_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'EMERGENCY_ALERT';
ALTER TYPE "AuditAction" ADD VALUE 'PHONE_VERIFIED';
ALTER TYPE "AuditAction" ADD VALUE 'PASSWORD_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'PASSWORD_RESET';

-- AlterTable: users, providers, services
ALTER TABLE "users" ADD COLUMN "phone_verified" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "providers" ADD COLUMN "delivery_fee" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN "delivery_radius_km" DOUBLE PRECISION,
ADD COLUMN "estimated_prep_minutes" INTEGER,
ADD COLUMN "is_open" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "min_order" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN "offers_collection" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "offers_delivery" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "opening_hours" TEXT;

ALTER TABLE "services" ADD COLUMN "is_available" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "section" TEXT,
ADD COLUMN "stock" INTEGER;

-- CreateTable
CREATE TABLE "service_option_groups" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "max_select" INTEGER NOT NULL DEFAULT 1,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "service_option_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_options" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "service_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "image_url" TEXT,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_history" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "actor_id" TEXT,
    "note" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addresses" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "instructions" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "favourites" (
    "user_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favourites_pkey" PRIMARY KEY ("user_id","service_id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliveries" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "driver_id" TEXT,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'AVAILABLE',
    "fee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "proof_photo_url" TEXT,
    "driver_lat" DOUBLE PRECISION,
    "driver_lng" DOUBLE PRECISION,
    "location_at" TIMESTAMP(3),
    "assigned_at" TIMESTAMP(3),
    "picked_up_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phone_verifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phone_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "PromoType" NOT NULL,
    "value" DECIMAL(12,2) NOT NULL,
    "min_subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "max_uses" INTEGER,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promo_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "commission_percent" DECIMAL(5,2) NOT NULL DEFAULT 10,
    "service_fee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emergency_alerts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "accuracy" DOUBLE PRECISION,
    "status" "EmergencyAlertStatus" NOT NULL DEFAULT 'OPEN',
    "resolved_at" TIMESTAMP(3),
    "resolved_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emergency_alerts_pkey" PRIMARY KEY ("id")
);

-- ── Orders: add new columns (nullable first so existing rows can be filled) ──
ALTER TABLE "orders"
ADD COLUMN "reference" TEXT,
ADD COLUMN "checkout_ref" TEXT,
ADD COLUMN "subtotal" DECIMAL(12,2),
ADD COLUMN "address" JSONB,
ADD COLUMN "cancel_reason" TEXT,
ADD COLUMN "commission" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN "delivery_fee" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN "service_fee" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN "tax" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN "estimated_ready_at" TIMESTAMP(3),
ADD COLUMN "fulfilment" "FulfilmentType" NOT NULL DEFAULT 'DELIVERY',
ADD COLUMN "payment_method" "PaymentMethod" NOT NULL DEFAULT 'CASH',
ADD COLUMN "payment_phone" TEXT,
ADD COLUMN "payment_status" "OrderPaymentStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN "promo_code" TEXT;

-- Legacy orders were single service bookings without an address: treat as collection
UPDATE "orders" o SET
  "reference" = 'KW' || upper(substr(md5(o."id"), 1, 8)),
  "checkout_ref" = o."id",
  "subtotal" = o."total_amount",
  "fulfilment" = 'COLLECTION',
  "payment_method" = CASE WHEN EXISTS (SELECT 1 FROM "payments" p WHERE p."order_id" = o."id") THEN 'CARD'::"PaymentMethod" ELSE 'CASH'::"PaymentMethod" END,
  "payment_status" = COALESCE((
    SELECT CASE p."status"
      WHEN 'SUCCEEDED' THEN 'PAID'::"OrderPaymentStatus"
      WHEN 'REFUNDED' THEN 'REFUNDED'::"OrderPaymentStatus"
      WHEN 'FAILED' THEN 'FAILED'::"OrderPaymentStatus"
      ELSE 'PENDING'::"OrderPaymentStatus" END
    FROM "payments" p WHERE p."order_id" = o."id" LIMIT 1), 'PENDING'),
  "cancel_reason" = CASE WHEN o."status" = 'DISPUTED' THEN 'Disputed (migrated from legacy order)' ELSE NULL END;

-- Each legacy order becomes an order with one item
INSERT INTO "order_items" ("id", "order_id", "service_id", "title", "image_url", "unit_price", "quantity", "options")
SELECT gen_random_uuid()::text, o."id", o."service_id", s."title", s."image_url", o."unit_price", o."quantity", '[]'::jsonb
FROM "orders" o JOIN "services" s ON s."id" = o."service_id";

-- ── Order status enum: map legacy values onto the new lifecycle ──
CREATE TYPE "OrderStatus_new" AS ENUM ('PENDING_PAYMENT', 'PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'COLLECTED', 'CANCELLED', 'REJECTED', 'REFUNDED');
ALTER TABLE "orders" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "orders" ALTER COLUMN "status" TYPE "OrderStatus_new" USING (
  CASE "status"::text
    WHEN 'PENDING' THEN 'PLACED'
    WHEN 'CONFIRMED' THEN 'ACCEPTED'
    WHEN 'IN_PROGRESS' THEN 'PREPARING'
    WHEN 'COMPLETED' THEN 'COLLECTED'
    WHEN 'DISPUTED' THEN 'CANCELLED'
    ELSE "status"::text
  END::"OrderStatus_new"
);
ALTER TABLE "order_status_history" ALTER COLUMN "status" TYPE "OrderStatus_new" USING ("status"::text::"OrderStatus_new");
ALTER TYPE "OrderStatus" RENAME TO "OrderStatus_old";
ALTER TYPE "OrderStatus_new" RENAME TO "OrderStatus";
DROP TYPE "OrderStatus_old";
ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'PLACED';

INSERT INTO "order_status_history" ("id", "order_id", "status", "note", "at")
SELECT gen_random_uuid()::text, o."id", o."status", 'Migrated', o."updated_at" FROM "orders" o;

-- Now drop the legacy single-service columns and enforce the new ones
ALTER TABLE "orders" DROP CONSTRAINT "orders_service_id_fkey";
ALTER TABLE "orders" DROP COLUMN "quantity", DROP COLUMN "service_id", DROP COLUMN "unit_price";
ALTER TABLE "orders" ALTER COLUMN "reference" SET NOT NULL,
ALTER COLUMN "checkout_ref" SET NOT NULL,
ALTER COLUMN "subtotal" SET NOT NULL;

-- ── Payments: link to the checkout instead of a single order ──
ALTER TABLE "payments" ADD COLUMN "checkout_ref" TEXT,
ADD COLUMN "method" "PaymentMethod" NOT NULL DEFAULT 'CARD',
ADD COLUMN "poll_url" TEXT;
UPDATE "payments" p SET "checkout_ref" = o."checkout_ref" FROM "orders" o WHERE o."id" = p."order_id";
ALTER TABLE "payments" DROP CONSTRAINT "payments_order_id_fkey";
DROP INDEX "payments_order_id_key";
ALTER TABLE "payments" DROP COLUMN "order_id";
ALTER TABLE "payments" ALTER COLUMN "checkout_ref" SET NOT NULL;

-- CreateIndex
CREATE INDEX "service_option_groups_service_id_idx" ON "service_option_groups"("service_id");

-- CreateIndex
CREATE INDEX "service_options_group_id_idx" ON "service_options"("group_id");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "order_status_history_order_id_idx" ON "order_status_history"("order_id");

-- CreateIndex
CREATE INDEX "addresses_user_id_idx" ON "addresses"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_token_key" ON "devices"("token");

-- CreateIndex
CREATE INDEX "devices_user_id_idx" ON "devices"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_order_id_key" ON "deliveries"("order_id");

-- CreateIndex
CREATE INDEX "deliveries_status_idx" ON "deliveries"("status");

-- CreateIndex
CREATE INDEX "deliveries_driver_id_idx" ON "deliveries"("driver_id");

-- CreateIndex
CREATE INDEX "phone_verifications_user_id_created_at_idx" ON "phone_verifications"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "promo_codes_code_key" ON "promo_codes"("code");

-- CreateIndex
CREATE INDEX "emergency_alerts_status_created_at_idx" ON "emergency_alerts"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_reference_key" ON "orders"("reference");

-- CreateIndex
CREATE INDEX "orders_checkout_ref_idx" ON "orders"("checkout_ref");

-- CreateIndex
CREATE INDEX "orders_user_id_created_at_idx" ON "orders"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_provider_id_status_idx" ON "orders"("provider_id", "status");

-- CreateIndex
CREATE INDEX "payments_checkout_ref_idx" ON "payments"("checkout_ref");

-- CreateIndex
CREATE INDEX "payments_gateway_ref_idx" ON "payments"("gateway_ref");

-- AddForeignKey
ALTER TABLE "service_option_groups" ADD CONSTRAINT "service_option_groups_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_options" ADD CONSTRAINT "service_options_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "service_option_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favourites" ADD CONSTRAINT "favourites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favourites" ADD CONSTRAINT "favourites_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_verifications" ADD CONSTRAINT "phone_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_alerts" ADD CONSTRAINT "emergency_alerts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Default platform settings row
INSERT INTO "platform_settings" ("id", "commission_percent", "service_fee", "tax_percent", "currency", "updated_at")
VALUES (1, 10, 0, 0, 'USD', CURRENT_TIMESTAMP) ON CONFLICT ("id") DO NOTHING;
