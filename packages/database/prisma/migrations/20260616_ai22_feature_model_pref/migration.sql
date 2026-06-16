-- AI-2.2 — per-feature AI model selection. One row per AI feature (or the
-- "__global__" sentinel) pins provider+model for that feature. Purely
-- additive: the table ships empty and an unset feature falls back to the
-- global default, then the provider default, so existing AI calls are
-- unchanged. Safe to deploy ahead of the resolver/UI wiring.

CREATE TABLE "AiFeatureModelPref" (
    "id" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiFeatureModelPref_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiFeatureModelPref_featureKey_key" ON "AiFeatureModelPref"("featureKey");
