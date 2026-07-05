-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN "gmailAttachmentId" TEXT;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "followUpAt" DATETIME;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "bodyHtml" TEXT;
ALTER TABLE "Message" ADD COLUMN "bodyText" TEXT;
ALTER TABLE "Message" ADD COLUMN "rfcMessageId" TEXT;

-- CreateTable
CREATE TABLE "FactoryEventOutbox" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PartyEmail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "partyId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "label" TEXT,
    "matchDomain" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "PartyEmail_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PartyEmail" ("email", "id", "label", "partyId") SELECT "email", "id", "label", "partyId" FROM "PartyEmail";
DROP TABLE "PartyEmail";
ALTER TABLE "new_PartyEmail" RENAME TO "PartyEmail";
CREATE UNIQUE INDEX "PartyEmail_email_key" ON "PartyEmail"("email");
CREATE INDEX "PartyEmail_partyId_idx" ON "PartyEmail"("partyId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "FactoryEventOutbox_createdAt_idx" ON "FactoryEventOutbox"("createdAt");
