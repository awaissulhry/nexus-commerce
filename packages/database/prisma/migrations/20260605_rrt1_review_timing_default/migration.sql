-- RRT.1 — ReviewTimingDefault: operator-editable per-product-type review-request
-- timing baseline. Seeded one row per the hardcoded TIMING_RULES substring
-- (review-scheduler.service.ts) for EXACT behavioral parity. Fully additive.

CREATE TABLE "ReviewTimingDefault" (
    "id" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "delayDays" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewTimingDefault_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReviewTimingDefault_pattern_key" ON "ReviewTimingDefault"("pattern");
CREATE INDEX "ReviewTimingDefault_isActive_sortOrder_idx" ON "ReviewTimingDefault"("isActive", "sortOrder");

-- Parity seed (idempotent). gen_random_uuid() is available on Neon (PG14+).
INSERT INTO "ReviewTimingDefault" ("id","pattern","label","delayDays","sortOrder","updatedAt") VALUES
  (gen_random_uuid()::text,'casco','Helmets (casco)',21,10,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'helmet','Helmets',21,11,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'combinat','Suits (combinato)',16,20,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'tuta','Suits (tuta)',16,21,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'suit','Suits',16,22,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'giacca','Jackets (giacca)',14,30,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'giubbotto','Jackets (giubbotto)',14,31,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'jacket','Jackets',14,32,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'stival','Boots (stivali)',14,40,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'scarpe','Shoes (scarpe)',14,41,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'boot','Boots',14,42,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'pantalon','Trousers (pantaloni)',12,50,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'trouser','Trousers',12,51,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'guant','Gloves (guanti)',10,60,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'glove','Gloves',10,61,CURRENT_TIMESTAMP)
ON CONFLICT ("pattern") DO NOTHING;
