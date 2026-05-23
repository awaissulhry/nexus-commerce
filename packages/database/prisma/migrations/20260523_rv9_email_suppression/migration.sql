-- RV.9.5 — GDPR/CAN-SPAM email suppression list.

CREATE TABLE "EmailSuppression" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "channel" TEXT,
    "source" TEXT NOT NULL,
    "reason" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

-- Composite unique allows a customer to be suppressed channel-by-channel
-- OR globally (channel=NULL). Postgres treats NULL as distinct in unique
-- indexes, but we only care about (email, NULL) being unique against
-- itself which works fine.
CREATE UNIQUE INDEX "EmailSuppression_email_channel_key" ON "EmailSuppression"("email", "channel");
CREATE INDEX "EmailSuppression_email_idx" ON "EmailSuppression"("email");
