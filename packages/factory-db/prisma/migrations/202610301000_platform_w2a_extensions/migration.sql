-- Written by hand (Prisma 7 models no extension without a preview feature), BEFORE the generated
-- …_platform_w2a_schema migration, whose trigram index needs it. When the migrations are renumbered, keep this file as
-- it is under a timestamp before the schema folder, and keep it IN prisma/migrations while `npm run migration` runs.

-- Global search (B-W2a-32; PLT-153): SearchEntry's typo-tolerant index (gin_trgm_ops: similarity, % and ILIKE).
-- pg_trgm ships with PostgreSQL (contrib) and is a trusted extension (PostgreSQL 13+): the migration login creates it
-- with CREATE on the database, no superuser needed. Production needs it available on the server (Railway's PostgreSQL
-- has it); IF NOT EXISTS keeps a server that has it already as it is.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
