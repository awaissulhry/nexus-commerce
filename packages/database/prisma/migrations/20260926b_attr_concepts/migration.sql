-- P3 (docs/attributes/PLAN.md §4.1, §5) — the link from a business attribute to a shared concept, and option
-- synonyms / retirement. Additive only: nullable or defaulted columns and one unique index (NULLs never collide).
ALTER TABLE "CustomAttribute" ADD COLUMN "semanticKey" TEXT;

ALTER TABLE "AttributeOption" ADD COLUMN "synonyms" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "CustomAttribute_workspace_semanticKey_key" ON "CustomAttribute"("workspaceId", "semanticKey");
