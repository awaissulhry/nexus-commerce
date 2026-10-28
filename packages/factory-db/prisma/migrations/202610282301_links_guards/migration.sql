-- Written by hand (Prisma does not model triggers), after the generated 202610282300_links_tokens and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The evidence of a link's opens and answers is append-only (plan A1 §2.1 "Append-only"; features SAL-099, PLT-073):
-- no login may change or remove a row, the owner included. It reuses factory_refuse_audit_change() of the
-- …_audit_append_only migration. scripts/factory/check-append-only.mjs requires both triggers on every table marked
-- @append-only.
CREATE TRIGGER "LinkEvidence_append_only" BEFORE UPDATE OR DELETE ON "LinkEvidence"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_audit_change"();
CREATE TRIGGER "LinkEvidence_no_truncate" BEFORE TRUNCATE ON "LinkEvidence"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_audit_change"();

-- A one-off link is fixed once made (plan A1 §3.10 "Links"; feature SAL-099): one purpose, one record, one party, one
-- token, one expiry, one use limit. A link session runs as factory_partner_runtime with an UPDATE grant on the link's
-- visible columns (it counts its own uses); this guard keeps it, and every other login, to what may move:
--   INSERT    a new link is unused, not revoked, at version 1, allows at least one use and expires after it was made.
--   UPDATE    refused when any column but uses, lastUsedAt, revokedAt, revokedById, note, version or updatedAt changes;
--             uses only go up, one at a time, never past maxUses, and never on a revoked link; a revocation is final
--             (revokedAt and revokedById never change again once set, and revokedById needs revokedAt); version goes
--             up by at most one.
--   DELETE    refused: a link is revoked, never deleted (its evidence points at it).
--   TRUNCATE  refused.
-- An AFTER trigger: for the runtime roles the row-level-security policies speak first (moving a link to another tenant
-- or party fails on their WITH CHECK); the guard then holds for every login, the owner included.
CREATE FUNCTION "factory_guard_link_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'links: TRUNCATE on "%" is refused', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'links: link % is never deleted; revoke it', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."uses" <> 0 OR NEW."lastUsedAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL OR NEW."revokedById" IS NOT NULL
       OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'links: a new link is unused, not revoked, at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."maxUses" < 1 OR NEW."expiresAt" <= NEW."createdAt" THEN
      RAISE EXCEPTION 'links: a new link allows at least one use and expires after it was made'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF (NEW."id", NEW."tenantId", NEW."companyId", NEW."partyId", NEW."purpose", NEW."recordType", NEW."recordId",
      NEW."tokenHash", NEW."email", NEW."expiresAt", NEW."maxUses", NEW."createdAt", NEW."createdById")
     IS DISTINCT FROM
     (OLD."id", OLD."tenantId", OLD."companyId", OLD."partyId", OLD."purpose", OLD."recordType", OLD."recordId",
      OLD."tokenHash", OLD."email", OLD."expiresAt", OLD."maxUses", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'links: link % is fixed once made; only its uses, its revocation and its note may change', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."uses" < OLD."uses" OR NEW."uses" > OLD."uses" + 1 OR NEW."uses" > NEW."maxUses" THEN
    RAISE EXCEPTION 'links: the uses of link % go up one at a time, to at most %', OLD."id", OLD."maxUses"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."uses" > OLD."uses" AND OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'links: link % is revoked; it is not used any more', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."revokedAt" IS NOT NULL
     AND (NEW."revokedAt", NEW."revokedById") IS DISTINCT FROM (OLD."revokedAt", OLD."revokedById") THEN
    RAISE EXCEPTION 'links: the revocation of link % is final', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."revokedAt" IS NULL AND NEW."revokedById" IS NOT NULL THEN
    RAISE EXCEPTION 'links: link % names who revoked it but is not revoked', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
    RAISE EXCEPTION 'links: the version of link % goes up by one', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "OneOffLink_guard" AFTER INSERT OR UPDATE OR DELETE ON "OneOffLink"
  FOR EACH ROW EXECUTE FUNCTION "factory_guard_link_change"();
CREATE TRIGGER "OneOffLink_no_truncate" BEFORE TRUNCATE ON "OneOffLink"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_guard_link_change"();
