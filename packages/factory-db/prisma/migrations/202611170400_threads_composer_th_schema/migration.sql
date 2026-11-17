-- AlterEnum
ALTER TYPE "EmailOutboundStatus" ADD VALUE 'WITHDRAWN';

-- AlterTable
ALTER TABLE "EmailOutbound" ADD COLUMN     "sendAfter" TIMESTAMPTZ(3),
ADD COLUMN     "withdrawnAt" TIMESTAMPTZ(3),
ADD COLUMN     "withdrawnById" UUID;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "amount" INTEGER,
ADD COLUMN     "amountCurrency" TEXT,
ADD COLUMN     "correctsMessageId" UUID,
ADD COLUMN     "held" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "replyToMessageId" UUID;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "messageId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "Message_tenantId_threadId_id_key" ON "Message"("tenantId", "threadId", "id");

-- CreateIndex
CREATE INDEX "Task_tenantId_messageId_idx" ON "Task"("tenantId", "messageId");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_tenantId_messageId_fkey" FOREIGN KEY ("tenantId", "messageId") REFERENCES "Message"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_tenantId_threadId_replyToMessageId_fkey" FOREIGN KEY ("tenantId", "threadId", "replyToMessageId") REFERENCES "Message"("tenantId", "threadId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_tenantId_threadId_correctsMessageId_fkey" FOREIGN KEY ("tenantId", "threadId", "correctsMessageId") REFERENCES "Message"("tenantId", "threadId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

