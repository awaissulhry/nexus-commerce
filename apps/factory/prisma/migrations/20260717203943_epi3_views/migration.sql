-- CreateTable
CREATE TABLE "InboxView" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "emoji" TEXT,
    "color" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "exclusive" BOOLEAN NOT NULL DEFAULT true,
    "showElsewhere" BOOLEAN NOT NULL DEFAULT false,
    "criteria" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "InboxViewOverride" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "viewId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InboxViewOverride_viewId_fkey" FOREIGN KEY ("viewId") REFERENCES "InboxView" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InboxRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "criteria" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "stopProcessing" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "InboxViewOverride_conversationId_idx" ON "InboxViewOverride"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "InboxViewOverride_viewId_conversationId_key" ON "InboxViewOverride"("viewId", "conversationId");
