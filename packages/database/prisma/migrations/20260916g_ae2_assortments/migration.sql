-- AE.2 — assortments and assortment shares between business profiles.
-- Plan: docs/2026-09-16-assortment-engine-plan.md §14. Additive only: three new tables, no data moved.
--
-- Order: (1) the tables Prisma derives from schema.prisma; (2) row-level security for the two
-- business-owned tables, emitted by workspaceModelSql() in scripts/workspace-policies.mjs so they
-- carry the same bytes the disposable test database gets; (3) the shared policy file
-- packages/database/workspaces/assortment-share.sql, which this migration ENDS WITH byte for byte
-- (policy-migrations.json, check-policy-migration-parity.mjs).

-- CreateTable
CREATE TABLE "Assortment" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "selection" TEXT NOT NULL DEFAULT 'list',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdByUserId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Assortment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssortmentMember" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "assortmentId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'include',
    "addedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssortmentMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssortmentShare" (
    "id" TEXT NOT NULL,
    "assortmentId" TEXT NOT NULL,
    "ownerWorkspaceId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fieldGroups" TEXT[],
    "followSettings" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedByUserId" TEXT,
    "respondedAt" TIMESTAMP(3),
    "pausedByUserId" TEXT,
    "pausedAt" TIMESTAMP(3),
    "endedBySide" TEXT,
    "endedByUserId" TEXT,
    "endedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssortmentShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Assortment_workspaceId_idx" ON "Assortment"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Assortment_workspace_name_key" ON "Assortment"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Assortment_id_workspaceId_key" ON "Assortment"("id", "workspaceId");

-- CreateIndex
CREATE INDEX "AssortmentMember_productId_idx" ON "AssortmentMember"("productId");

-- CreateIndex
CREATE INDEX "AssortmentMember_workspaceId_idx" ON "AssortmentMember"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AssortmentMember_assortmentId_productId_key" ON "AssortmentMember"("workspaceId", "assortmentId", "productId");

-- CreateIndex
CREATE INDEX "AssortmentShare_ownerWorkspaceId_status_idx" ON "AssortmentShare"("ownerWorkspaceId", "status");

-- CreateIndex
CREATE INDEX "AssortmentShare_workspaceId_status_idx" ON "AssortmentShare"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "AssortmentShare_assortmentId_idx" ON "AssortmentShare"("assortmentId");

-- AddForeignKey
ALTER TABLE "AssortmentMember" ADD CONSTRAINT "AssortmentMember_assortmentId_fkey" FOREIGN KEY ("assortmentId") REFERENCES "Assortment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssortmentMember" ADD CONSTRAINT "AssortmentMember_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssortmentShare" ADD CONSTRAINT "AssortmentShare_assortmentId_ownerWorkspaceId_fkey" FOREIGN KEY ("assortmentId", "ownerWorkspaceId") REFERENCES "Assortment"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssortmentShare" ADD CONSTRAINT "AssortmentShare_ownerWorkspaceId_fkey" FOREIGN KEY ("ownerWorkspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssortmentShare" ADD CONSTRAINT "AssortmentShare_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── (2) Row-level security for the business-owned tables ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Assortment" TO nexus_workspace_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AssortmentMember" TO nexus_workspace_runtime;
ALTER TABLE "Assortment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Assortment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "Assortment";
CREATE POLICY nexus_workspace_isolation ON "Assortment" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Assortment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "Assortment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "Assortment";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "Assortment" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
ALTER TABLE "AssortmentMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssortmentMember" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AssortmentMember";
CREATE POLICY nexus_workspace_isolation ON "AssortmentMember" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AssortmentMember"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AssortmentMember"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AssortmentMember";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AssortmentMember" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Assortment","from":"assortmentId","to":"id"},{"model":"Product","from":"productId","to":"id"}]');

-- AE.2 — offering an assortment to another business profile.
-- Plan: docs/2026-09-16-assortment-engine-plan.md §14.
--
-- Shared by the generator (scripts/workspace-policies.mjs, which the disposable test database
-- applies) and migration 20260916g_ae2_assortments, which ENDS WITH these exact bytes
-- (policy-migrations.json; checked by check-policy-migration-parity.mjs). Change this file only
-- through a NEW migration that ends with its new bytes.
--
-- The rules the database keeps, whatever the application does:
--   1. Consent cannot be skipped: only the FOLLOWER can make a pending share active.
--   2. What was offered cannot change after the offer.
--   3. A share is never deleted.
--   4. One open share (pending, active, paused) per assortment and follower.
--   5. Owner reads and writes its outgoing shares; the follower only reads its incoming ones and
--      answers through nexus_assortment_share_respond(); a third business sees nothing.

-- ── Values ──────────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Assortment_selection_check') THEN
    ALTER TABLE "Assortment" ADD CONSTRAINT "Assortment_selection_check" CHECK (selection IN ('list', 'all'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AssortmentMember_mode_check') THEN
    ALTER TABLE "AssortmentMember" ADD CONSTRAINT "AssortmentMember_mode_check" CHECK (mode IN ('include', 'exclude'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AssortmentShare_status_check') THEN
    ALTER TABLE "AssortmentShare" ADD CONSTRAINT "AssortmentShare_status_check"
      CHECK (status IN ('pending', 'active', 'paused', 'declined', 'revoked'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AssortmentShare_field_groups_check') THEN
    -- The field groups of plan §3.4. Channel listings are never a group: they are never shared.
    -- IS NOT NULL first: Prisma creates a list column as nullable, and a CHECK whose expression is
    -- NULL passes, so cardinality(NULL) > 0 alone would admit a share offering nothing.
    ALTER TABLE "AssortmentShare" ADD CONSTRAINT "AssortmentShare_field_groups_check"
      CHECK ("fieldGroups" IS NOT NULL AND cardinality("fieldGroups") > 0 AND "fieldGroups" <@ ARRAY['identity', 'content', 'attributes', 'translations', 'media', 'physical', 'compliance', 'structure', 'price', 'status']::text[]);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AssortmentShare_two_businesses_check') THEN
    ALTER TABLE "AssortmentShare" ADD CONSTRAINT "AssortmentShare_two_businesses_check" CHECK ("ownerWorkspaceId" <> "workspaceId");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AssortmentShare_ended_side_check') THEN
    ALTER TABLE "AssortmentShare" ADD CONSTRAINT "AssortmentShare_ended_side_check"
      CHECK (("endedBySide" IS NULL AND "endedAt" IS NULL) OR ("endedBySide" IN ('owner', 'follower') AND "endedAt" IS NOT NULL));
  END IF;
END $$;

-- ── One open share per assortment and follower ──────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "AssortmentShare_one_open_share"
  ON "AssortmentShare" ("assortmentId", "workspaceId") WHERE status IN ('pending', 'active', 'paused');

-- ── Row-level security ──────────────────────────────────────────────────────────────────────
ALTER TABLE "AssortmentShare" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssortmentShare" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AssortmentShare" TO nexus_workspace_runtime;

-- This table links TWO businesses, so it gets no nexus_workspace_reference_guard trigger — that
-- guard exists to reject exactly the cross-business link this row IS. The composite foreign key
-- to Assortment(id, workspaceId) is what ties the assortment to the offering business.

-- The OWNER: reads and writes its outgoing shares. FOR ALL, so INSERT/UPDATE/DELETE are the
-- owner's alone; the status guard below decides which updates are allowed and refuses DELETE.
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AssortmentShare";
CREATE POLICY nexus_workspace_isolation ON "AssortmentShare" FOR ALL TO nexus_workspace_runtime
USING (("ownerWorkspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AssortmentShare"."ownerWorkspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("ownerWorkspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AssortmentShare"."ownerWorkspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));

-- The FOLLOWER: reads its incoming shares, and nothing else.
-- 🔴 A SEPARATE FOR SELECT policy, never a second arm on the FOR ALL policy above: DELETE
-- consults USING alone and never reaches WITH CHECK, so widening that USING would let the
-- follower delete the owner's row (the BP.S1a trap).
DROP POLICY IF EXISTS nexus_assortment_share_follower_read ON "AssortmentShare";
CREATE POLICY nexus_assortment_share_follower_read ON "AssortmentShare" FOR SELECT TO nexus_workspace_runtime
USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AssortmentShare"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));

-- The follower may read the OFFERED ASSORTMENT's row (its name) while the share is open. Only
-- SELECT is added: every write on Assortment still consults nexus_workspace_isolation alone.
-- Members are NOT readable here; what the follower sees of the products is AE.3's preview.
DROP POLICY IF EXISTS nexus_assortment_follower_read ON "Assortment";
CREATE POLICY nexus_assortment_follower_read ON "Assortment" FOR SELECT TO nexus_workspace_runtime
USING (EXISTS (
  SELECT 1 FROM "AssortmentShare" s JOIN "Workspace" w ON w.id = s."workspaceId"
  WHERE s."assortmentId" = "Assortment".id
    AND s."ownerWorkspaceId" = "Assortment"."workspaceId"
    AND s."workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '')
    AND s.status IN ('pending', 'active', 'paused')
    AND w.status = 'active'
    AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
      SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
      WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
        AND m.status = 'active' AND u.status = 'active'))));

-- ── The status guard: which side may make which change ─────────────────────────────────────
-- The acting side is the business in the request context. It is NOT a parameter, so a caller
-- cannot claim to be the follower. A context that is neither business is refused.
CREATE OR REPLACE FUNCTION nexus_assortment_share_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  context_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
  side text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An assortment share is never deleted; revoke it instead' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.version <> 1
       OR NEW."respondedByUserId" IS NOT NULL OR NEW."respondedAt" IS NOT NULL
       OR NEW."pausedByUserId" IS NOT NULL OR NEW."pausedAt" IS NOT NULL
       OR NEW."endedBySide" IS NOT NULL OR NEW."endedByUserId" IS NOT NULL OR NEW."endedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'A new assortment share starts pending and unanswered' USING ERRCODE = '23514';
    END IF;
    IF context_id IS DISTINCT FROM NEW."ownerWorkspaceId" THEN
      RAISE EXCEPTION 'Only the business that owns the assortment can offer it' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW."assortmentId" <> OLD."assortmentId"
     OR NEW."ownerWorkspaceId" <> OLD."ownerWorkspaceId" OR NEW."workspaceId" <> OLD."workspaceId"
     OR NEW."fieldGroups" IS DISTINCT FROM OLD."fieldGroups" OR NEW."followSettings" <> OLD."followSettings"
     OR NEW."createdByUserId" <> OLD."createdByUserId" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'What a share offers cannot change after it is offered; revoke it and offer a new one' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Every change to a share must advance its version by one' USING ERRCODE = '23514';
  END IF;

  side := CASE WHEN context_id = OLD."ownerWorkspaceId" THEN 'owner'
               WHEN context_id = OLD."workspaceId" THEN 'follower' END;
  IF side IS NULL THEN
    RAISE EXCEPTION 'Only the two businesses in a share can change it' USING ERRCODE = '42501';
  END IF;

  IF NOT (
    (side = 'owner' AND (
      (OLD.status = 'pending' AND NEW.status = 'revoked') OR
      (OLD.status = 'active' AND NEW.status IN ('paused', 'revoked')) OR
      (OLD.status = 'paused' AND NEW.status IN ('active', 'revoked'))))
    OR
    (side = 'follower' AND (
      (OLD.status = 'pending' AND NEW.status IN ('active', 'declined')) OR
      (OLD.status IN ('active', 'paused') AND NEW.status = 'revoked')))
  ) THEN
    RAISE EXCEPTION 'The % cannot change a % share to %', side, OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('revoked', 'declined') AND (NEW."endedBySide" IS DISTINCT FROM side OR NEW."endedAt" IS NULL) THEN
    RAISE EXCEPTION 'An ended share records which side ended it and when' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('pending', 'active', 'paused') AND NEW."endedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'An open share has no end' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS nexus_assortment_share_guard ON "AssortmentShare";
CREATE TRIGGER nexus_assortment_share_guard BEFORE INSERT OR UPDATE OR DELETE ON "AssortmentShare"
  FOR EACH ROW EXECUTE FUNCTION nexus_assortment_share_guard();

-- ── The follower's answer ───────────────────────────────────────────────────────────────────
-- The follower has no UPDATE policy on AssortmentShare, so it answers here. SECURITY DEFINER lets
-- it write the owner's row; everything else is re-checked inside: the request's business must be
-- the follower, the person must be an active OWNER of it, the version must match, and the status
-- guard above still validates the change (it fires on this UPDATE with the follower's context).
-- Returns jsonb: the updated row, or {error, code, status} for a refusal the caller can show.
CREATE OR REPLACE FUNCTION nexus_assortment_share_respond(share_id text, decision text, expected_version integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET TimeZone = 'UTC' AS $$
DECLARE
  follower_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
  actor_id text := NULLIF(current_setting('nexus.actor_id', true), '');
  share "AssortmentShare"%ROWTYPE;
  next_status text;
BEGIN
  IF follower_id IS NULL OR actor_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Sign in as an owner of this business profile to answer a share.', 'code', 'session_required', 'status', 403);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "WorkspaceMembership" m
    JOIN "Workspace" w ON w.id = m."workspaceId"
    JOIN "UserProfile" u ON u.id = m."userId"
    WHERE m."workspaceId" = follower_id AND m."userId" = actor_id
      AND m.status = 'active' AND w.status = 'active' AND u.status = 'active'
      AND EXISTS (SELECT 1 FROM "WorkspaceMemberRole" mr JOIN "Role" r ON r.id = mr."roleId"
        WHERE mr."membershipId" = m.id AND r.key = 'OWNER')
  ) THEN
    RETURN jsonb_build_object('error', 'An owner of this business profile must answer a share.', 'code', 'workspace_owner_required', 'status', 403);
  END IF;

  next_status := CASE decision WHEN 'accept' THEN 'active' WHEN 'decline' THEN 'declined' WHEN 'leave' THEN 'revoked' END;
  IF next_status IS NULL THEN
    RETURN jsonb_build_object('error', 'Choose accept, decline or leave.', 'code', 'invalid_decision', 'status', 400);
  END IF;

  SELECT * INTO share FROM "AssortmentShare" WHERE id = share_id AND "workspaceId" = follower_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'This share is unavailable in this business profile.', 'code', 'share_not_found', 'status', 404);
  END IF;
  IF share.version <> expected_version THEN
    RETURN jsonb_build_object('error', 'This share changed since you loaded it. Review it again.', 'code', 'share_changed', 'status', 409,
      'currentStatus', share.status, 'currentVersion', share.version);
  END IF;
  IF NOT ((decision IN ('accept', 'decline') AND share.status = 'pending')
       OR (decision = 'leave' AND share.status IN ('active', 'paused'))) THEN
    RETURN jsonb_build_object('error', format('A %s share cannot be answered with %s.', share.status, decision), 'code', 'share_state', 'status', 409,
      'currentStatus', share.status, 'currentVersion', share.version);
  END IF;

  UPDATE "AssortmentShare" SET
    status = next_status,
    version = share.version + 1,
    "updatedAt" = CURRENT_TIMESTAMP,
    "respondedByUserId" = CASE WHEN decision IN ('accept', 'decline') THEN actor_id ELSE share."respondedByUserId" END,
    "respondedAt" = CASE WHEN decision IN ('accept', 'decline') THEN CURRENT_TIMESTAMP ELSE share."respondedAt" END,
    "endedBySide" = CASE WHEN decision IN ('decline', 'leave') THEN 'follower' END,
    "endedByUserId" = CASE WHEN decision IN ('decline', 'leave') THEN actor_id END,
    "endedAt" = CASE WHEN decision IN ('decline', 'leave') THEN CURRENT_TIMESTAMP END
  WHERE id = share_id
  RETURNING * INTO share;

  RETURN jsonb_build_object('share', to_jsonb(share));
END $$;

REVOKE ALL ON FUNCTION nexus_assortment_share_respond(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_assortment_share_respond(text, text, integer) TO nexus_workspace_runtime;
