-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('USD', 'ZWG');

-- CreateEnum
CREATE TYPE "FulfilmentMethod" AS ENUM ('PLATFORM_FULFILLED', 'SELLER_FULFILLED');

-- CreateEnum
CREATE TYPE "SellerKycTier" AS ENUM ('INFORMAL', 'REGISTERED');

-- CreateEnum
CREATE TYPE "SellerPlan" AS ENUM ('STARTER', 'PRO');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DeliveryZone" AS ENUM ('METRO', 'INTERCITY');

-- CreateEnum
CREATE TYPE "PickupPointType" AS ENUM ('PARTNER_SHOP', 'MALL', 'BUS_DEPOT', 'COURIER_DEPOT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'EXCHANGE_RATE_SET';
ALTER TYPE "AuditAction" ADD VALUE 'SELLER_ONBOARDED';
ALTER TYPE "AuditAction" ADD VALUE 'SELLER_KYC_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'PRODUCT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'PRODUCT_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'OFFER_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'OFFER_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'OFFER_DELETED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "UserRole" ADD VALUE 'SELLER';
ALTER TYPE "UserRole" ADD VALUE 'WAREHOUSE';

-- DropIndex
DROP INDEX "orders_user_id_created_at_idx";

-- AlterTable
ALTER TABLE "addresses" ADD COLUMN     "landmark" TEXT,
ADD COLUMN     "suburb" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "cod_trust_score" INTEGER NOT NULL DEFAULT 50;

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" TEXT NOT NULL,
    "from_currency" "Currency" NOT NULL,
    "to_currency" "Currency" NOT NULL,
    "rate" DECIMAL(18,6) NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'ADMIN',
    "note" TEXT,
    "set_by_admin_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cities" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "zone" "DeliveryZone" NOT NULL DEFAULT 'INTERCITY',
    "cod_eligible" BOOLEAN NOT NULL DEFAULT false,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "cities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suburbs" (
    "id" TEXT NOT NULL,
    "city_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "suburbs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hubs" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city_id" TEXT NOT NULL,
    "suburb" TEXT,
    "address" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "operating_hours" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hubs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pickup_points" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PickupPointType" NOT NULL,
    "city_id" TEXT NOT NULL,
    "suburb" TEXT,
    "address" TEXT NOT NULL,
    "landmark" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "phone" TEXT,
    "operating_hours" TEXT,
    "agent_commission_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "hub_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pickup_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seller_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "business_name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "logo_url" TEXT,
    "is_first_party" BOOLEAN NOT NULL DEFAULT false,
    "kyc_tier" "SellerKycTier" NOT NULL DEFAULT 'INFORMAL',
    "kyc_status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "tax_number" TEXT,
    "national_id" TEXT,
    "phone" TEXT,
    "city_id" TEXT,
    "plan" "SellerPlan" NOT NULL DEFAULT 'STARTER',
    "sla_score" DECIMAL(5,2) NOT NULL DEFAULT 100,
    "dispute_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "rating_avg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rating_count" INTEGER NOT NULL DEFAULT 0,
    "lead_time_days" INTEGER NOT NULL DEFAULT 2,
    "usd_payout_details" JSONB,
    "zig_payout_details" JSONB,
    "approved_at" TIMESTAMP(3),
    "approved_by" TEXT,
    "rejection_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seller_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "parent_id" TEXT,
    "commission_rate" DECIMAL(5,2) NOT NULL DEFAULT 10,
    "fulfilment_fee_usd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "icon" TEXT,
    "image_url" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "brand_id" TEXT,
    "category_id" TEXT NOT NULL,
    "specifications" JSONB NOT NULL DEFAULT '{}',
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "weight_kg" DECIMAL(8,3),
    "rating_avg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rating_count" INTEGER NOT NULL DEFAULT 0,
    "search_vector" tsvector,
    "buy_box_offer_id" TEXT,
    "buy_box_price_usd" DECIMAL(12,2),
    "in_stock" BOOLEAN NOT NULL DEFAULT false,
    "offer_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_images" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "thumb_url" TEXT,
    "alt" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "seller_sku" TEXT,
    "price_usd" DECIMAL(12,2) NOT NULL,
    "list_price_usd" DECIMAL(12,2),
    "shipping_fee_usd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "stock_qty" INTEGER NOT NULL DEFAULT 0,
    "fulfilment_type" "FulfilmentMethod" NOT NULL,
    "hub_id" TEXT,
    "dispatch_city_id" TEXT,
    "lead_time_days" INTEGER NOT NULL DEFAULT 2,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_buy_box_winner" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exchange_rates_from_currency_to_currency_effective_from_idx" ON "exchange_rates"("from_currency", "to_currency", "effective_from" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "cities_name_key" ON "cities"("name");

-- CreateIndex
CREATE UNIQUE INDEX "cities_slug_key" ON "cities"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "suburbs_city_id_name_key" ON "suburbs"("city_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "hubs_code_key" ON "hubs"("code");

-- CreateIndex
CREATE INDEX "hubs_city_id_idx" ON "hubs"("city_id");

-- CreateIndex
CREATE UNIQUE INDEX "pickup_points_code_key" ON "pickup_points"("code");

-- CreateIndex
CREATE INDEX "pickup_points_city_id_is_active_idx" ON "pickup_points"("city_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "seller_profiles_user_id_key" ON "seller_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "seller_profiles_slug_key" ON "seller_profiles"("slug");

-- CreateIndex
CREATE INDEX "seller_profiles_kyc_status_idx" ON "seller_profiles"("kyc_status");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE INDEX "categories_parent_id_idx" ON "categories"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "brands_name_key" ON "brands"("name");

-- CreateIndex
CREATE UNIQUE INDEX "brands_slug_key" ON "brands"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "products_slug_key" ON "products"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "products_buy_box_offer_id_key" ON "products"("buy_box_offer_id");

-- CreateIndex
CREATE INDEX "products_category_id_status_idx" ON "products"("category_id", "status");

-- CreateIndex
CREATE INDEX "products_brand_id_idx" ON "products"("brand_id");

-- CreateIndex
CREATE INDEX "products_status_in_stock_idx" ON "products"("status", "in_stock");

-- CreateIndex
CREATE INDEX "products_buy_box_price_usd_idx" ON "products"("buy_box_price_usd");

-- CreateIndex
CREATE INDEX "products_search_vector_idx" ON "products" USING GIN ("search_vector");

-- CreateIndex
CREATE INDEX "product_images_product_id_idx" ON "product_images"("product_id");

-- CreateIndex
CREATE INDEX "offers_product_id_is_active_idx" ON "offers"("product_id", "is_active");

-- CreateIndex
CREATE INDEX "offers_seller_id_idx" ON "offers"("seller_id");

-- CreateIndex
CREATE INDEX "offers_hub_id_idx" ON "offers"("hub_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_idx" ON "audit_logs"("actor_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_idx" ON "audit_logs"("target_type");

-- CreateIndex
CREATE INDEX "audit_logs_target_id_idx" ON "audit_logs"("target_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_action_idx" ON "audit_logs"("actor_id", "action");

-- CreateIndex
CREATE INDEX "orders_user_id_idx" ON "orders"("user_id");

-- CreateIndex
CREATE INDEX "orders_provider_id_idx" ON "orders"("provider_id");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "orders_payment_status_idx" ON "orders"("payment_status");

-- CreateIndex
CREATE INDEX "orders_created_at_idx" ON "orders"("created_at" DESC);

-- CreateIndex
CREATE INDEX "orders_user_id_created_at_idx" ON "orders"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "orders_status_payment_status_idx" ON "orders"("status", "payment_status");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE INDEX "payments_gateway_idx" ON "payments"("gateway");

-- CreateIndex
CREATE INDEX "payments_created_at_idx" ON "payments"("created_at" DESC);

-- CreateIndex
CREATE INDEX "payments_status_gateway_idx" ON "payments"("status", "gateway");

-- CreateIndex
CREATE INDEX "providers_approval_status_idx" ON "providers"("approval_status");

-- CreateIndex
CREATE INDEX "providers_category_idx" ON "providers"("category");

-- CreateIndex
CREATE INDEX "providers_is_open_idx" ON "providers"("is_open");

-- CreateIndex
CREATE INDEX "providers_created_at_idx" ON "providers"("created_at" DESC);

-- CreateIndex
CREATE INDEX "providers_approval_status_is_open_idx" ON "providers"("approval_status", "is_open");

-- CreateIndex
CREATE INDEX "services_provider_id_idx" ON "services"("provider_id");

-- CreateIndex
CREATE INDEX "services_category_idx" ON "services"("category");

-- CreateIndex
CREATE INDEX "services_is_active_idx" ON "services"("is_active");

-- CreateIndex
CREATE INDEX "services_is_available_idx" ON "services"("is_available");

-- CreateIndex
CREATE INDEX "services_created_at_idx" ON "services"("created_at" DESC);

-- CreateIndex
CREATE INDEX "services_provider_id_is_active_idx" ON "services"("provider_id", "is_active");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_created_at_idx" ON "users"("created_at" DESC);

-- CreateIndex
CREATE INDEX "users_role_status_idx" ON "users"("role", "status");

-- AddForeignKey
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_set_by_admin_id_fkey" FOREIGN KEY ("set_by_admin_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suburbs" ADD CONSTRAINT "suburbs_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hubs" ADD CONSTRAINT "hubs_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_points" ADD CONSTRAINT "pickup_points_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_points" ADD CONSTRAINT "pickup_points_hub_id_fkey" FOREIGN KEY ("hub_id") REFERENCES "hubs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_profiles" ADD CONSTRAINT "seller_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_profiles" ADD CONSTRAINT "seller_profiles_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_buy_box_offer_id_fkey" FOREIGN KEY ("buy_box_offer_id") REFERENCES "offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_hub_id_fkey" FOREIGN KEY ("hub_id") REFERENCES "hubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_dispatch_city_id_fkey" FOREIGN KEY ("dispatch_city_id") REFERENCES "cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────
-- Hand-written: not expressible in schema.prisma
-- ─────────────────────────────────────────────────────────

-- Full-text search: weighted vector (title A, brand B, specs C, description D),
-- kept current by a trigger. Brand renames refresh their products too.
CREATE OR REPLACE FUNCTION products_search_vector_refresh() RETURNS trigger AS $$
DECLARE
  brand_name TEXT;
BEGIN
  SELECT name INTO brand_name FROM brands WHERE id = NEW.brand_id;
  NEW.search_vector :=
      setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A')
   || setweight(to_tsvector('simple', coalesce(brand_name, '')), 'B')
   || setweight(to_tsvector('simple', coalesce(NEW.sku, '')), 'B')
   || setweight(jsonb_to_tsvector('simple', coalesce(NEW.specifications, '{}'::jsonb), '["string"]'), 'C')
   || setweight(to_tsvector('english', coalesce(NEW.description, '')), 'D');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER products_search_vector_trg
  BEFORE INSERT OR UPDATE OF title, description, brand_id, sku, specifications ON products
  FOR EACH ROW EXECUTE FUNCTION products_search_vector_refresh();

CREATE OR REPLACE FUNCTION brands_refresh_product_search() RETURNS trigger AS $$
BEGIN
  UPDATE products SET title = title WHERE brand_id = NEW.id;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER brands_refresh_product_search_trg
  AFTER UPDATE OF name ON brands
  FOR EACH ROW EXECUTE FUNCTION brands_refresh_product_search();

-- Typo-tolerant title matching (pg_trgm is already installed)
CREATE INDEX "products_title_trgm_idx" ON "products" USING GIN ("title" gin_trgm_ops);

-- Integrity rules Prisma can't declare
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_rate_positive" CHECK ("rate" > 0);
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_distinct_pair" CHECK ("from_currency" <> "to_currency");
ALTER TABLE "offers" ADD CONSTRAINT "offers_price_positive" CHECK ("price_usd" > 0);
ALTER TABLE "offers" ADD CONSTRAINT "offers_shipping_non_negative" CHECK ("shipping_fee_usd" >= 0);
ALTER TABLE "offers" ADD CONSTRAINT "offers_stock_non_negative" CHECK ("stock_qty" >= 0);
ALTER TABLE "offers" ADD CONSTRAINT "offers_platform_needs_hub"
  CHECK ("fulfilment_type" <> 'PLATFORM_FULFILLED' OR "hub_id" IS NOT NULL);
ALTER TABLE "categories" ADD CONSTRAINT "categories_commission_range" CHECK ("commission_rate" >= 0 AND "commission_rate" <= 100);
ALTER TABLE "users" ADD CONSTRAINT "users_cod_trust_score_range" CHECK ("cod_trust_score" BETWEEN 0 AND 100);
