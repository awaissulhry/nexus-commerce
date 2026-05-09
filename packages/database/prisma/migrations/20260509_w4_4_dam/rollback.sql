-- Rollback for W4.4 — drop AssetUsage + DigitalAsset.
DROP TABLE IF EXISTS "AssetUsage" CASCADE;
DROP TABLE IF EXISTS "DigitalAsset" CASCADE;
