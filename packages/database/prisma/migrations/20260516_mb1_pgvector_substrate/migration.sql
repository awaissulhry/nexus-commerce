-- MB.1: Enable pgvector extension + Brand Brain content embedding table.
--
-- ContentEmbedding is intentionally NOT in schema.prisma — the vector(1536)
-- column type is unsupported by Prisma's type system, so we own all CRUD
-- against this table through prisma.$queryRaw / $executeRaw.
--
-- HNSW index (pgvector ≥0.5, available on Neon): cosine distance is the
-- right metric for text embeddings produced by normalised models like
-- text-embedding-3-small.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS "ContentEmbedding" (
  id           TEXT        NOT NULL,
  "entityType" TEXT        NOT NULL,
  "entityId"   TEXT        NOT NULL,
  "field"      TEXT        NOT NULL DEFAULT 'default',
  model        TEXT        NOT NULL DEFAULT 'text-embedding-3-small',
  dimensions   INTEGER     NOT NULL DEFAULT 1536,
  embedding    vector(1536),
  "snippet"    TEXT,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE ("entityType", "entityId", "field")
);

CREATE INDEX IF NOT EXISTS "ContentEmbedding_entityType_idx"
  ON "ContentEmbedding" ("entityType");

-- HNSW for fast approximate nearest-neighbour at small-to-medium corpus size.
-- Falls back to sequential scan when index isn't available (e.g. pgvector < 0.5).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'ContentEmbedding'
    AND indexname = 'ContentEmbedding_hnsw_cosine_idx'
  ) THEN
    EXECUTE 'CREATE INDEX "ContentEmbedding_hnsw_cosine_idx"
      ON "ContentEmbedding" USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)';
  END IF;
END $$;
