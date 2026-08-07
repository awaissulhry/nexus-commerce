-- NAF.SB.W.8 — worker instances: "create a worker" as a narrower copy of a
-- code charter. Session-locks doc §4, Half A; the design and this column name
-- were agreed with the Workflows stream before either half was built.
--
-- Additive only: two nullable columns and one index. No existing row changes,
-- and every existing row has templateKey = NULL, which means "I am a code
-- charter" — exactly what they were before.
ALTER TABLE "AgentCharter" ADD COLUMN "templateKey" TEXT;
ALTER TABLE "AgentCharter" ADD COLUMN "promptOverlay" TEXT;

CREATE INDEX "AgentCharter_templateKey_idx" ON "AgentCharter"("templateKey");
