-- EV.1 — transactional outbox for the event broker.
-- Additive only: one new table, no change to any existing table.

-- CreateTable
CREATE TABLE "EventOutbox" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "context" TEXT NOT NULL,
    "accountId" TEXT,
    "subject" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "causationId" TEXT,
    "source" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventOutbox_eventId_key" ON "EventOutbox"("eventId");

-- CreateIndex
CREATE INDEX "EventOutbox_publishedAt_occurredAt_idx" ON "EventOutbox"("publishedAt", "occurredAt");

-- CreateIndex
CREATE INDEX "EventOutbox_type_occurredAt_idx" ON "EventOutbox"("type", "occurredAt");

-- CreateIndex
CREATE INDEX "EventOutbox_subject_idx" ON "EventOutbox"("subject");
