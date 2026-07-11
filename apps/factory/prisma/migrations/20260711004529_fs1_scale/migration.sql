-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "lastMessageDirection" TEXT;

-- CreateIndex
CREATE INDEX "Attachment_messageId_idx" ON "Attachment"("messageId");

-- CreateIndex
CREATE INDEX "Conversation_snoozeUntil_idx" ON "Conversation"("snoozeUntil");

-- CreateIndex
CREATE INDEX "Conversation_followUpAt_idx" ON "Conversation"("followUpAt");

-- CreateIndex
CREATE INDEX "MovementLedger_createdAt_idx" ON "MovementLedger"("createdAt");

-- CreateIndex
CREATE INDEX "WorkOrder_orderId_idx" ON "WorkOrder"("orderId");

-- FS1 backfill: derive lastMessageDirection for existing conversations from
-- their newest message (one-time; the two write points maintain it hereafter).
UPDATE "Conversation" SET "lastMessageDirection" = (
  SELECT m."direction" FROM "Message" m
  WHERE m."conversationId" = "Conversation"."id"
  ORDER BY m."sentAt" DESC LIMIT 1
);
