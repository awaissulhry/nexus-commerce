-- ACR.3 — control group: engine-held-out terms, so share moves are attributable.
ALTER TABLE "KeywordCoverageTerm" ADD COLUMN "isControl" BOOLEAN NOT NULL DEFAULT false;
