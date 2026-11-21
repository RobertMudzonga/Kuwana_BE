-- CreateEnum
CREATE TYPE "ProductRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DUPLICATE', 'REJECTED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'PRODUCT_REQUEST_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE 'PRODUCT_REQUEST_REVIEWED';

-- CreateTable
CREATE TABLE "product_requests" (
    "id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "status" "ProductRequestStatus" NOT NULL DEFAULT 'PENDING',
    "title" TEXT NOT NULL,
    "brand_name" TEXT,
    "category_id" TEXT,
    "description" TEXT,
    "barcode" TEXT,
    "reference_url" TEXT,
    "images" JSONB NOT NULL DEFAULT '[]',
    "specifications" JSONB NOT NULL DEFAULT '{}',
    "weight_kg" DECIMAL(8,3),
    "note" TEXT,
    "product_id" TEXT,
    "review_note" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_requests_status_created_at_idx" ON "product_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "product_requests_seller_id_created_at_idx" ON "product_requests"("seller_id", "created_at");

-- AddForeignKey
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

