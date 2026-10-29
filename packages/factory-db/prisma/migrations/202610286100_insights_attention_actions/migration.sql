-- CreateEnum
CREATE TYPE "AttentionVerb" AS ENUM ('ASSIGNED', 'UNASSIGNED', 'RESOLVED', 'ACKNOWLEDGED');

-- CreateTable
CREATE TABLE "AttentionAction" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "rowKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "subKey" TEXT,
    "companyId" UUID,
    "siteId" UUID,
    "partyId" UUID,
    "assignedToId" UUID,
    "assignedById" UUID,
    "assignedAt" TIMESTAMPTZ(3),
    "resolvedCondition" TEXT,
    "resolveNote" TEXT,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "acknowledgedCondition" TEXT,
    "acknowledgedById" UUID,
    "acknowledgedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "AttentionAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttentionActionLog" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "actionId" UUID NOT NULL,
    "rowKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "recordLabel" TEXT NOT NULL,
    "companyId" UUID,
    "siteId" UUID,
    "partyId" UUID,
    "verb" "AttentionVerb" NOT NULL,
    "condition" TEXT NOT NULL,
    "actorId" UUID NOT NULL,
    "assigneeId" UUID,
    "note" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttentionActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TodayLayout" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "userId" UUID NOT NULL,
    "sections" JSONB NOT NULL,
    "panels" JSONB NOT NULL,
    "mainLens" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "TodayLayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttentionAction_tenantId_assignedToId_idx" ON "AttentionAction"("tenantId", "assignedToId");

-- CreateIndex
CREATE UNIQUE INDEX "AttentionAction_tenantId_rowKey_key" ON "AttentionAction"("tenantId", "rowKey");

-- CreateIndex
CREATE UNIQUE INDEX "AttentionAction_tenantId_id_key" ON "AttentionAction"("tenantId", "id");

-- CreateIndex
CREATE INDEX "AttentionActionLog_tenantId_actionId_at_idx" ON "AttentionActionLog"("tenantId", "actionId", "at");

-- CreateIndex
CREATE INDEX "AttentionActionLog_tenantId_actorId_at_idx" ON "AttentionActionLog"("tenantId", "actorId", "at");

-- CreateIndex
CREATE INDEX "TodayLayout_tenantId_userId_idx" ON "TodayLayout"("tenantId", "userId");

-- AddForeignKey
ALTER TABLE "AttentionAction" ADD CONSTRAINT "AttentionAction_tenantId_assignedToId_fkey" FOREIGN KEY ("tenantId", "assignedToId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AttentionActionLog" ADD CONSTRAINT "AttentionActionLog_tenantId_actionId_fkey" FOREIGN KEY ("tenantId", "actionId") REFERENCES "AttentionAction"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TodayLayout" ADD CONSTRAINT "TodayLayout_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

