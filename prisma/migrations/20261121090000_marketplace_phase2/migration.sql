-- CreateEnum
CREATE TYPE "PaymentPurpose" AS ENUM ('SERVICE_CHECKOUT', 'MARKET_ORDER');

-- CreateEnum
CREATE TYPE "MarketOrderStatus" AS ENUM ('PENDING_PAYMENT', 'AWAITING_COD_OTP', 'CONFIRMED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MarketPaymentStatus" AS ENUM ('UNPAID', 'PAID', 'COD_PENDING', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "DeliveryMode" AS ENUM ('DELIVERY', 'PICKUP');

-- CreateEnum
CREATE TYPE "DeliverySpeed" AS ENUM ('STANDARD', 'EXPRESS');

-- CreateEnum
CREATE TYPE "DeliveryTier" AS ENUM ('METRO_SAME_DAY', 'METRO_NEXT_DAY', 'INTERCITY_COURIER', 'PICKUP_POINT', 'SELLER_COURIER');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('PENDING', 'PROCESSING', 'PACKED', 'DISPATCHED', 'OUT_FOR_DELIVERY', 'READY_FOR_COLLECTION', 'DELIVERED', 'COLLECTED', 'CANCELLED', 'RETURNED');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('SALE', 'SHIPPING_FEE', 'COD_FEE', 'WALLET_CREDIT', 'WALLET_DEBIT', 'REFUND', 'COD_COLLECTED', 'PAYOUT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "CodCollectionStatus" AS ENUM ('NOT_COD', 'PENDING', 'COLLECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentMethod" ADD VALUE 'INNBUCKS';
ALTER TYPE "PaymentMethod" ADD VALUE 'ZIMSWITCH';
ALTER TYPE "PaymentMethod" ADD VALUE 'WALLET';

-- AlterTable
ALTER TABLE "addresses" ADD COLUMN     "city_id" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "purpose" "PaymentPurpose" NOT NULL DEFAULT 'SERVICE_CHECKOUT';

-- CreateTable
CREATE TABLE "market_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "free_delivery_threshold_usd" DECIMAL(12,2) NOT NULL DEFAULT 50,
    "metro_next_day_fee_usd" DECIMAL(12,2) NOT NULL DEFAULT 3,
    "metro_same_day_fee_usd" DECIMAL(12,2) NOT NULL DEFAULT 6,
    "same_day_cutoff_hour" INTEGER NOT NULL DEFAULT 12,
    "intercity_fee_usd" DECIMAL(12,2) NOT NULL DEFAULT 7,
    "pickup_fee_usd" DECIMAL(12,2) NOT NULL DEFAULT 1.5,
    "intercity_pickup_fee_usd" DECIMAL(12,2) NOT NULL DEFAULT 4,
    "heavy_threshold_kg" DECIMAL(8,3) NOT NULL DEFAULT 10,
    "heavy_surcharge_per_kg_usd" DECIMAL(12,2) NOT NULL DEFAULT 0.5,
    "cod_enabled" BOOLEAN NOT NULL DEFAULT true,
    "cod_max_order_usd" DECIMAL(12,2) NOT NULL DEFAULT 150,
    "cod_min_trust_score" INTEGER NOT NULL DEFAULT 40,
    "cod_fee_usd" DECIMAL(12,2) NOT NULL DEFAULT 1,
    "payment_timeout_minutes" INTEGER NOT NULL DEFAULT 30,
    "cod_otp_timeout_minutes" INTEGER NOT NULL DEFAULT 15,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_orders" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "MarketOrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "payment_status" "MarketPaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "payment_method" "PaymentMethod" NOT NULL,
    "payment_currency" "Currency" NOT NULL,
    "payment_phone" TEXT,
    "locked_exchange_rate" DECIMAL(18,6) NOT NULL,
    "exchange_rate_id" TEXT,
    "delivery_mode" "DeliveryMode" NOT NULL,
    "delivery_speed" "DeliverySpeed" NOT NULL DEFAULT 'STANDARD',
    "address_id" TEXT,
    "delivery_address" JSONB NOT NULL,
    "destination_city_id" TEXT NOT NULL,
    "pickup_point_id" TEXT,
    "recipient_name" TEXT NOT NULL,
    "recipient_phone" TEXT NOT NULL,
    "recipient_id_number" TEXT,
    "is_gift" BOOLEAN NOT NULL DEFAULT false,
    "items_subtotal_usd" DECIMAL(12,2) NOT NULL,
    "delivery_fee_usd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "seller_shipping_usd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cod_fee_usd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discount_usd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_usd" DECIMAL(12,2) NOT NULL,
    "total_zwg" DECIMAL(14,2) NOT NULL,
    "amount_due" DECIMAL(14,2) NOT NULL,
    "free_delivery_applied" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "cod_otp_hash" TEXT,
    "cod_otp_expires_at" TIMESTAMP(3),
    "cod_otp_attempts" INTEGER NOT NULL DEFAULT 0,
    "cod_otp_sent_at" TIMESTAMP(3),
    "collection_pin_hash" TEXT,
    "expires_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "source_type" "FulfilmentMethod" NOT NULL,
    "hub_id" TEXT,
    "seller_id" TEXT,
    "dispatch_city_id" TEXT,
    "tier" "DeliveryTier" NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'PENDING',
    "fee_usd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "weight_kg" DECIMAL(10,3),
    "eta_min_days" INTEGER NOT NULL,
    "eta_max_days" INTEGER NOT NULL,
    "dispatch_by" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_order_items" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "image_url" TEXT,
    "fulfilment_type" "FulfilmentMethod" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price_usd" DECIMAL(12,2) NOT NULL,
    "line_total_usd" DECIMAL(12,2) NOT NULL,
    "commission_rate" DECIMAL(5,2) NOT NULL,
    "commission_usd" DECIMAL(12,2) NOT NULL,
    "fulfilment_fee_usd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "seller_net_usd" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "user_id" TEXT NOT NULL,
    "balance_usd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "order_id" TEXT,
    "order_item_id" TEXT,
    "shipment_id" TEXT,
    "seller_id" TEXT,
    "user_id" TEXT,
    "payment_id" TEXT,
    "currency" "Currency" NOT NULL,
    "exchange_rate_at_tx" DECIMAL(18,6) NOT NULL,
    "gross_usd" DECIMAL(14,2) NOT NULL,
    "gross_tx" DECIMAL(14,2) NOT NULL,
    "commission_usd" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "fulfilment_fee_usd" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "platform_revenue_usd" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "seller_net_usd" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "wallet_delta_usd" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cod_status" "CodCollectionStatus" NOT NULL DEFAULT 'NOT_COD',
    "memo" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "market_orders_reference_key" ON "market_orders"("reference");

-- CreateIndex
CREATE INDEX "market_orders_user_id_created_at_idx" ON "market_orders"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "market_orders_status_expires_at_idx" ON "market_orders"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_reference_key" ON "shipments"("reference");

-- CreateIndex
CREATE INDEX "shipments_order_id_idx" ON "shipments"("order_id");

-- CreateIndex
CREATE INDEX "shipments_hub_id_status_idx" ON "shipments"("hub_id", "status");

-- CreateIndex
CREATE INDEX "shipments_seller_id_status_idx" ON "shipments"("seller_id", "status");

-- CreateIndex
CREATE INDEX "market_order_items_order_id_idx" ON "market_order_items"("order_id");

-- CreateIndex
CREATE INDEX "market_order_items_seller_id_created_at_idx" ON "market_order_items"("seller_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ledger_entries_order_id_idx" ON "ledger_entries"("order_id");

-- CreateIndex
CREATE INDEX "ledger_entries_seller_id_created_at_idx" ON "ledger_entries"("seller_id", "created_at");

-- CreateIndex
CREATE INDEX "ledger_entries_user_id_created_at_idx" ON "ledger_entries"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "ledger_entries_type_created_at_idx" ON "ledger_entries"("type", "created_at");

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_orders" ADD CONSTRAINT "market_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_orders" ADD CONSTRAINT "market_orders_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_orders" ADD CONSTRAINT "market_orders_destination_city_id_fkey" FOREIGN KEY ("destination_city_id") REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_orders" ADD CONSTRAINT "market_orders_pickup_point_id_fkey" FOREIGN KEY ("pickup_point_id") REFERENCES "pickup_points"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "market_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_hub_id_fkey" FOREIGN KEY ("hub_id") REFERENCES "hubs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "seller_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_dispatch_city_id_fkey" FOREIGN KEY ("dispatch_city_id") REFERENCES "cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_order_items" ADD CONSTRAINT "market_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "market_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_order_items" ADD CONSTRAINT "market_order_items_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_order_items" ADD CONSTRAINT "market_order_items_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_order_items" ADD CONSTRAINT "market_order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_order_items" ADD CONSTRAINT "market_order_items_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "seller_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "market_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "seller_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────
-- Hand-written: not expressible in schema.prisma
-- ─────────────────────────────────────────────────────────

-- The ledger is append-only. Corrections are new entries (ADJUSTMENT / REFUND), never edits.
-- DELETE is allowed only inside a transaction that sets kuwana.ledger_maintenance = 'on'
-- (used by automated tests to clean up their own rows).
CREATE OR REPLACE FUNCTION ledger_entries_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('kuwana.ledger_maintenance', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'ledger_entries is append-only (% blocked)', TG_OP;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_immutable_trg
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_immutable();

ALTER TABLE "wallets" ADD CONSTRAINT "wallets_balance_non_negative" CHECK ("balance_usd" >= 0);
ALTER TABLE "market_order_items" ADD CONSTRAINT "market_order_items_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "market_orders" ADD CONSTRAINT "market_orders_total_non_negative" CHECK ("total_usd" >= 0 AND "amount_due" >= 0);
ALTER TABLE "market_orders" ADD CONSTRAINT "market_orders_pickup_needs_point"
  CHECK ("delivery_mode" <> 'PICKUP' OR "pickup_point_id" IS NOT NULL);
ALTER TABLE "market_settings" ADD CONSTRAINT "market_settings_singleton" CHECK ("id" = 1);

INSERT INTO "market_settings" ("id", "updated_at") VALUES (1, NOW()) ON CONFLICT DO NOTHING;

-- Link existing addresses to structured cities where the name matches
UPDATE "addresses" a SET "city_id" = c."id"
FROM "cities" c
WHERE a."city_id" IS NULL AND lower(trim(a."city")) = lower(c."name");
