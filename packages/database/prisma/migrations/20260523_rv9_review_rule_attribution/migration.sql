-- RV.9.7 — Persist heuristic attribution of Reviews back to the
-- ReviewRequest + ReviewRule that likely caused them.

ALTER TABLE "Review"
  ADD COLUMN "attributedRequestId" TEXT,
  ADD COLUMN "attributedRuleId"    TEXT,
  ADD COLUMN "attributedAt"        TIMESTAMP(3);

CREATE INDEX "Review_attributedRequestId_idx" ON "Review"("attributedRequestId");
CREATE INDEX "Review_attributedRuleId_idx"    ON "Review"("attributedRuleId");

ALTER TABLE "Review"
  ADD CONSTRAINT "Review_attributedRequestId_fkey"
    FOREIGN KEY ("attributedRequestId") REFERENCES "ReviewRequest"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Review_attributedRuleId_fkey"
    FOREIGN KEY ("attributedRuleId") REFERENCES "ReviewRule"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
