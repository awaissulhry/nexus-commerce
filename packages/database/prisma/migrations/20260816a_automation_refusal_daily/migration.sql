-- AUTO.P0 — the durable record of an AUTOMATION refusal (a rule that matched and was not allowed
-- to act). Sibling to AUTO.A7's AdWriteRefusal, which covers a write refused AT the gate.
--
-- Purely additive: one new table, one unique constraint, two indexes. Nothing altered, nothing
-- dropped.
--
-- 🔴 A COUNTER rather than a row per refusal, and the volume is the argument. Measured on prod
-- 2026-08-11 at the caps in force that day, the enabled rules produced 27,629 refusals PER DAY —
-- 10,084,585 rows a year. The pre-2026-08-04 regime wrote one execution row per refusal and hit
-- 693,704 rows in eight weeks, which is precisely what forced ADX.1 to stop writing them at all.
-- Keyed (actor, day, reason) this is tens of thousands of rows a year and answers every question
-- a surface actually asks.
--
-- Until this exists, a cap refusal is published ONLY to an in-process 50-event, 5-minute ring
-- buffer on one instance, so the Automations page's `capped` chip and RuleDetail's "its daily cap
-- declined to run it N times this week" have rendered 0 for every rule since 2026-08-04. Surfaces
-- reading this table must state that the record starts 2026-08-16 — earlier refusals are gone.
CREATE TABLE "AutomationRefusalDaily" (
  "id" TEXT NOT NULL,
  "actorKind" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "dayUtc" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "lastAt" TIMESTAMP(3) NOT NULL,
  "lastReason" TEXT NOT NULL,
  "lastEntityType" TEXT,
  "lastEntityId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AutomationRefusalDaily_pkey" PRIMARY KEY ("id")
);

-- The upsert key. Without it the increment path races itself into duplicate rows under the
-- evaluator's concurrency, and the counter under-reports exactly when volume is highest.
CREATE UNIQUE INDEX "AutomationRefusalDaily_actorKind_actorId_dayUtc_reason_key"
  ON "AutomationRefusalDaily"("actorKind", "actorId", "dayUtc", "reason");

CREATE INDEX "AutomationRefusalDaily_dayUtc_reason_idx" ON "AutomationRefusalDaily"("dayUtc", "reason");
CREATE INDEX "AutomationRefusalDaily_actorId_dayUtc_idx" ON "AutomationRefusalDaily"("actorId", "dayUtc");
