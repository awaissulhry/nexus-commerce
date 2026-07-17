-- FC3 — followed threads (Google's model: replying or being @mentioned in a
-- thread auto-follows it; followers are part of a reply's notify audience).
-- Additive only: one nullable Json column on ChatMember holding an array of
-- thread rootIds (capped in chat-service; NULL = follows nothing).

-- AlterTable
ALTER TABLE "ChatMember" ADD COLUMN "followedThreads" JSONB;
