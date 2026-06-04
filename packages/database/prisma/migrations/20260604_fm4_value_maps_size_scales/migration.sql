-- FM.4 — catalog value maps + cross-system size scales (additive).

-- CreateTable
CREATE TABLE "FieldValueMap" (
  "id" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "marketplace" TEXT NOT NULL DEFAULT '*',
  "attribute" TEXT NOT NULL,
  "fromValue" TEXT NOT NULL,
  "toValue" TEXT NOT NULL,
  "confidence" TEXT NOT NULL DEFAULT 'MANUAL',
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FieldValueMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SizeScaleMap" (
  "id" TEXT NOT NULL,
  "scale" TEXT NOT NULL,
  "fromSystem" TEXT NOT NULL,
  "toSystem" TEXT NOT NULL,
  "fromValue" TEXT NOT NULL,
  "toValue" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SizeScaleMap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FieldValueMap_channel_marketplace_attribute_fromValue_key" ON "FieldValueMap"("channel", "marketplace", "attribute", "fromValue");

-- CreateIndex
CREATE INDEX "FieldValueMap_channel_marketplace_attribute_idx" ON "FieldValueMap"("channel", "marketplace", "attribute");

-- CreateIndex
CREATE UNIQUE INDEX "SizeScaleMap_scale_fromSystem_toSystem_fromValue_key" ON "SizeScaleMap"("scale", "fromSystem", "toSystem", "fromValue");

-- CreateIndex
CREATE INDEX "SizeScaleMap_scale_fromSystem_toSystem_idx" ON "SizeScaleMap"("scale", "fromSystem", "toSystem");

-- Seed canonical Xavia size scales (idempotent). EU/CM numeric → ALPHA.
INSERT INTO "SizeScaleMap" ("id", "scale", "fromSystem", "toSystem", "fromValue", "toValue") VALUES
  ('ss_mens_jacket_eu_alpha_44', 'MENS_JACKET', 'EU', 'ALPHA', '44', 'XS'),
  ('ss_mens_jacket_eu_alpha_46', 'MENS_JACKET', 'EU', 'ALPHA', '46', 'S'),
  ('ss_mens_jacket_eu_alpha_48', 'MENS_JACKET', 'EU', 'ALPHA', '48', 'M'),
  ('ss_mens_jacket_eu_alpha_50', 'MENS_JACKET', 'EU', 'ALPHA', '50', 'L'),
  ('ss_mens_jacket_eu_alpha_52', 'MENS_JACKET', 'EU', 'ALPHA', '52', 'XL'),
  ('ss_mens_jacket_eu_alpha_54', 'MENS_JACKET', 'EU', 'ALPHA', '54', 'XXL'),
  ('ss_mens_jacket_eu_alpha_56', 'MENS_JACKET', 'EU', 'ALPHA', '56', 'XXXL'),
  ('ss_mens_jacket_eu_alpha_58', 'MENS_JACKET', 'EU', 'ALPHA', '58', '4XL'),
  ('ss_helmet_cm_alpha_53', 'HELMET', 'CM', 'ALPHA', '53', 'XS'),
  ('ss_helmet_cm_alpha_54', 'HELMET', 'CM', 'ALPHA', '54', 'S'),
  ('ss_helmet_cm_alpha_55', 'HELMET', 'CM', 'ALPHA', '55', 'S'),
  ('ss_helmet_cm_alpha_56', 'HELMET', 'CM', 'ALPHA', '56', 'M'),
  ('ss_helmet_cm_alpha_57', 'HELMET', 'CM', 'ALPHA', '57', 'M'),
  ('ss_helmet_cm_alpha_58', 'HELMET', 'CM', 'ALPHA', '58', 'L'),
  ('ss_helmet_cm_alpha_59', 'HELMET', 'CM', 'ALPHA', '59', 'L'),
  ('ss_helmet_cm_alpha_60', 'HELMET', 'CM', 'ALPHA', '60', 'XL'),
  ('ss_helmet_cm_alpha_61', 'HELMET', 'CM', 'ALPHA', '61', 'XL'),
  ('ss_helmet_cm_alpha_62', 'HELMET', 'CM', 'ALPHA', '62', 'XXL'),
  ('ss_glove_eu_alpha_7', 'GLOVE', 'EU', 'ALPHA', '7', 'S'),
  ('ss_glove_eu_alpha_8', 'GLOVE', 'EU', 'ALPHA', '8', 'M'),
  ('ss_glove_eu_alpha_9', 'GLOVE', 'EU', 'ALPHA', '9', 'L'),
  ('ss_glove_eu_alpha_10', 'GLOVE', 'EU', 'ALPHA', '10', 'XL'),
  ('ss_glove_eu_alpha_11', 'GLOVE', 'EU', 'ALPHA', '11', 'XXL')
ON CONFLICT ("scale", "fromSystem", "toSystem", "fromValue") DO NOTHING;
