-- 2026-10-01 — a person's own product sheet layout, one per sheet, following them into every business profile.
-- Additive: a new table only. GLOBAL (model-ownership.json globalModels): no business owns a row; the service writes
-- and reads only the signed-in user's rows.
CREATE TABLE IF NOT EXISTS "UserSheetLayout" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSheetLayout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserSheetLayout_userId_surface_key" ON "UserSheetLayout"("userId", "surface");

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "UserSheetLayout" TO nexus_workspace_runtime;
