-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "ownerId" UUID;

-- CreateTable
CREATE TABLE "ThreadRead" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "threadId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "partyId" UUID,
    "lastReadMessageId" UUID NOT NULL,
    "readAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThreadRead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ThreadRead_tenantId_userId_idx" ON "ThreadRead"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "ThreadRead_tenantId_partyId_idx" ON "ThreadRead"("tenantId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "ThreadRead_tenantId_key_key" ON "ThreadRead"("tenantId", "key");

-- CreateIndex
CREATE INDEX "Thread_tenantId_ownerId_idx" ON "Thread"("tenantId", "ownerId");

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_tenantId_ownerId_fkey" FOREIGN KEY ("tenantId", "ownerId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ThreadRead" ADD CONSTRAINT "ThreadRead_tenantId_threadId_fkey" FOREIGN KEY ("tenantId", "threadId") REFERENCES "Thread"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ThreadRead" ADD CONSTRAINT "ThreadRead_tenantId_threadId_partyId_fkey" FOREIGN KEY ("tenantId", "threadId", "partyId") REFERENCES "Thread"("tenantId", "id", "partyId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ThreadRead" ADD CONSTRAINT "ThreadRead_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ThreadRead" ADD CONSTRAINT "ThreadRead_tenantId_lastReadMessageId_fkey" FOREIGN KEY ("tenantId", "lastReadMessageId") REFERENCES "Message"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

