-- LX.1. Owner: no backfill or existing-value changes. DDL only.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "ProductTranslation"
  ADD COLUMN "attributes" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "sourceHash" TEXT,
  ADD COLUMN "authoredAt" TIMESTAMP(3),
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

-- Enforce legacy immutability for every writer, including older deployed code.
-- Empty initial bags remain accepted for existing product-creation defaults.
CREATE FUNCTION nexus_lx1_legacy_content_readonly() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."localizedContent" NOT IN ('{}'::jsonb, '{"en":{},"it":{}}'::jsonb) THEN
      RAISE EXCEPTION 'Product.localizedContent is legacy and read-only; author translations in ProductTranslation.'
        USING ERRCODE = '23514', CONSTRAINT = 'Product_localizedContent_readonly';
    END IF;
  ELSIF NEW."localizedContent" IS DISTINCT FROM OLD."localizedContent" THEN
    RAISE EXCEPTION 'Product.localizedContent is legacy and read-only; author translations in ProductTranslation.'
      USING ERRCODE = '23514', CONSTRAINT = 'Product_localizedContent_readonly';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Product_localizedContent_readonly"
BEFORE INSERT OR UPDATE OF "localizedContent" ON "Product"
FOR EACH ROW EXECUTE FUNCTION nexus_lx1_legacy_content_readonly();

COMMIT;
