-- SG.9 — "stop suggesting for this one" (H10's third verb, repointed to their real semantics:
-- a MUTE on the producers, not a pause on the entity). Additive: new table only.
CREATE TABLE "AdsSuggestionMute" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'rules',
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityName" TEXT,
    "marketplace" TEXT,
    "reason" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdsSuggestionMute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdsSuggestionMute_scope_entityType_entityId_key" ON "AdsSuggestionMute"("scope", "entityType", "entityId");
CREATE INDEX "AdsSuggestionMute_scope_idx" ON "AdsSuggestionMute"("scope");

-- SG.9 — an autopilot decision keeps its outbound queue handle, so "APPLIED" can be settled
-- against what the write gate actually did instead of asserting delivery at enqueue time.
ALTER TABLE "AutopilotDecision" ADD COLUMN "outboundQueueId" TEXT;
