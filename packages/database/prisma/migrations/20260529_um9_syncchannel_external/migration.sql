-- UM.9/11/12/13 — add external marketing channels to SyncChannel so the
-- unified mutation path (OutboundSyncQueue.targetChannel) can route to
-- Google / Meta / TikTok. Pure additive enum values; ALTER TYPE ADD VALUE
-- is online-safe and must run outside a transaction (Prisma migrate runs
-- each statement standalone).
ALTER TYPE "SyncChannel" ADD VALUE IF NOT EXISTS 'GOOGLE';
ALTER TYPE "SyncChannel" ADD VALUE IF NOT EXISTS 'META';
ALTER TYPE "SyncChannel" ADD VALUE IF NOT EXISTS 'TIKTOK';
