-- NAF.AQ — "not now": an approval the operator has deliberately set aside.
--
-- Additive only: one nullable column and one index. No existing row or object
-- is altered, and every existing status keeps its meaning.
--
-- Why a column rather than client state: the research is specific that the
-- counter to approval fatigue is "keeping state so 'later' does not become
-- 'never'". A snooze held in a browser is lost on reload, invisible to the
-- rail badge, and would let the count disagree with the queue.
--
-- NOT a second expiry. `expiresAt` still owns the request's life; a snooze can
-- never outlive it, which the API enforces — waking something up after it has
-- already been refused would be worse than not snoozing it at all.

-- AlterTable
ALTER TABLE "AgentApproval" ADD COLUMN "snoozedUntil" TIMESTAMP(3);

-- CreateIndex — the waiting view's filter: pending AND (not snoozed OR due).
CREATE INDEX "AgentApproval_status_snoozedUntil_idx" ON "AgentApproval"("status", "snoozedUntil");
