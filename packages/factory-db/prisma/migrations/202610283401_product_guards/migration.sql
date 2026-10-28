-- Written by hand (Prisma does not model triggers), after the generated 202610283400_product_compliance and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Product and compliance (plan A1 §2.5; PLAN §2.8 "PPE", "Cr VI"; features PRD-022, PRD-030, PRD-110, PRD-331,
-- QHS-103). apps/factory-api's modules/product and modules/compliance check all of this first; these rules hold for
-- every login, the owner included. The tenant of a row is held by the policies (USING and WITH CHECK on the tenant) and
-- by the references, not here. No runtime role has a DELETE grant on these tables (the policy migration); the owner
-- may remove only an unused draft (PRD-022).

-- Item
--   every row  its purchase and consumption factors are above 0; a Cr VI limit is set exactly when every lot needs a Cr VI
--              test, and is above 0 and at most 3 mg/kg (REACH Annex XVII entry 47: leather in contact with the skin).
CREATE FUNCTION "factory_item_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."purchaseFactor" <= 0 OR NEW."consumptionFactor" <= 0 THEN
    RAISE EXCEPTION 'product: the unit factors of item % are above 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."requiresCrViTest" <> (NEW."crViLimitMgKg" IS NOT NULL) THEN
    RAISE EXCEPTION 'product: item % has a Cr VI limit exactly when its lots need a Cr VI test', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."crViLimitMgKg" <= 0 OR NEW."crViLimitMgKg" > 3 THEN
    RAISE EXCEPTION 'product: the Cr VI limit of item % is above 0 and at most 3 mg/kg (REACH Annex XVII entry 47)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Item_guard" BEFORE INSERT OR UPDATE ON "Item"
  FOR EACH ROW EXECUTE FUNCTION "factory_item_guard"();

-- StyleRevision (A1 §2.5: a work order is made from a released revision, which never changes)
--   every row  RELEASED has releasedAt; DRAFT has neither releasedAt nor releasedById.
--   UPDATE     the style, the number and the creation never change; the status moves only DRAFT → RELEASED | OBSOLETE
--              and RELEASED → OBSOLETE; once out of DRAFT, nothing but the status changes (a change is a new revision).
--   DELETE     only a draft (PRD-022: an unused draft); a released or obsolete revision is kept. TRUNCATE refused.
CREATE FUNCTION "factory_style_revision_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'product: TRUNCATE on "%" is refused', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'product: revision % is %; it is kept, never deleted', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (NEW."id", NEW."styleId", NEW."revision", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."styleId", OLD."revision", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: the style, number and creation of revision % never change', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('RELEASED', 'OBSOLETE'))
                OR (OLD."status" = 'RELEASED' AND NEW."status" = 'OBSOLETE')) THEN
      RAISE EXCEPTION 'product: revision % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" <> 'DRAFT'
       AND (NEW."changeNote", NEW."plannedHideYieldPct", NEW."labelTemplateId", NEW."releasedAt", NEW."releasedById")
           IS DISTINCT FROM
           (OLD."changeNote", OLD."plannedHideYieldPct", OLD."labelTemplateId", OLD."releasedAt", OLD."releasedById") THEN
      RAISE EXCEPTION 'product: revision % is %; it never changes, a change is a new revision', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF (NEW."status" = 'RELEASED' AND NEW."releasedAt" IS NULL)
     OR (NEW."status" = 'DRAFT' AND (NEW."releasedAt" IS NOT NULL OR NEW."releasedById" IS NOT NULL)) THEN
    RAISE EXCEPTION 'product: revision % is % with the wrong release time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "StyleRevision_guard" BEFORE INSERT OR UPDATE OR DELETE ON "StyleRevision"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_revision_guard"();
CREATE TRIGGER "StyleRevision_no_truncate" BEFORE TRUNCATE ON "StyleRevision"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_style_revision_guard"();

-- BomLine, BomLineSize, BomLineColour, RoutingOperation: the parts of a revision
--   INSERT, UPDATE, DELETE  only while the revision is DRAFT; a row never moves to another revision. An UPDATE that
--                           changes nothing passes. The revision row is locked FOR SHARE, so a release waits for the
--                           transaction that edits its parts (and an edit after the release sees it released). A
--                           revision this session cannot see (another tenant's) is left to the policies and references.
--   TRUNCATE                refused.
CREATE FUNCTION "factory_style_revision_part_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  part_of uuid;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'product: TRUNCATE on "%" is refused', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."revisionId" IS DISTINCT FROM OLD."revisionId" THEN
      RAISE EXCEPTION 'product: a row of "%" never moves to another revision', TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    part_of := NEW."revisionId";
    SELECT r."status"::text INTO state FROM "StyleRevision" r
      WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."revisionId" FOR SHARE;
  ELSE
    part_of := OLD."revisionId";
    SELECT r."status"::text INTO state FROM "StyleRevision" r
      WHERE r."tenantId" = OLD."tenantId" AND r."id" = OLD."revisionId" FOR SHARE;
  END IF;
  IF state IS NOT NULL AND state <> 'DRAFT' THEN
    RAISE EXCEPTION 'product: revision % is %; its "%" rows never change, a change is a new revision', part_of, state, TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "BomLine_revision_guard" BEFORE INSERT OR UPDATE OR DELETE ON "BomLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_revision_part_guard"();
CREATE TRIGGER "BomLine_no_truncate" BEFORE TRUNCATE ON "BomLine"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_style_revision_part_guard"();
CREATE TRIGGER "BomLineSize_revision_guard" BEFORE INSERT OR UPDATE OR DELETE ON "BomLineSize"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_revision_part_guard"();
CREATE TRIGGER "BomLineSize_no_truncate" BEFORE TRUNCATE ON "BomLineSize"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_style_revision_part_guard"();
CREATE TRIGGER "BomLineColour_revision_guard" BEFORE INSERT OR UPDATE OR DELETE ON "BomLineColour"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_revision_part_guard"();
CREATE TRIGGER "BomLineColour_no_truncate" BEFORE TRUNCATE ON "BomLineColour"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_style_revision_part_guard"();
CREATE TRIGGER "RoutingOperation_revision_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RoutingOperation"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_revision_part_guard"();
CREATE TRIGGER "RoutingOperation_no_truncate" BEFORE TRUNCATE ON "RoutingOperation"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_style_revision_part_guard"();

-- Certificate (QHS-103; Reg. 2016/425 art. 8(3), Annex V)
--   every row  the validity ends after it starts and spans at most five years; a company or a brand party holds it.
--   UPDATE     the creation never changes; once out of DRAFT, nothing but the status, its reason and its time changes
--              (a new or extended certificate is a new row); the status moves only DRAFT → VALID | WITHDRAWN (a draft
--              typed by mistake), VALID → SUSPENDED | WITHDRAWN | EXPIRED, SUSPENDED → VALID | WITHDRAWN | EXPIRED.
--   DELETE     only a draft; a registered certificate is kept (10 years). TRUNCATE refused.
CREATE FUNCTION "factory_certificate_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'compliance: TRUNCATE on "%" is refused', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'compliance: certificate % is %; it is kept, never deleted', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (NEW."id", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'compliance: the creation of certificate % never changes', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('VALID', 'WITHDRAWN'))
                OR (OLD."status" = 'VALID' AND NEW."status" IN ('SUSPENDED', 'WITHDRAWN', 'EXPIRED'))
                OR (OLD."status" = 'SUSPENDED' AND NEW."status" IN ('VALID', 'WITHDRAWN', 'EXPIRED'))) THEN
      RAISE EXCEPTION 'compliance: certificate % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" <> 'DRAFT'
       AND (NEW."companyId", NEW."holderPartyId", NEW."standard", NEW."ppeClass", NEW."number", NEW."notifiedBodyName",
            NEW."notifiedBodyNumber", NEW."modelReference", NEW."validFrom", NEW."validTo", NEW."note")
           IS DISTINCT FROM
           (OLD."companyId", OLD."holderPartyId", OLD."standard", OLD."ppeClass", OLD."number", OLD."notifiedBodyName",
            OLD."notifiedBodyNumber", OLD."modelReference", OLD."validFrom", OLD."validTo", OLD."note") THEN
      RAISE EXCEPTION 'compliance: certificate % is %; only its status changes, a new or extended certificate is a new row', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF NEW."validTo" <= NEW."validFrom" THEN
    RAISE EXCEPTION 'compliance: certificate % ends (%) before it starts (%)', NEW."id", NEW."validTo", NEW."validFrom"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."validTo" > NEW."validFrom" + interval '5 years' THEN
    RAISE EXCEPTION 'compliance: certificate % is valid for more than five years (Reg. 2016/425 Annex V)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."companyId" IS NULL AND NEW."holderPartyId" IS NULL THEN
    RAISE EXCEPTION 'compliance: certificate % is held by a company or a brand party', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Certificate_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Certificate"
  FOR EACH ROW EXECUTE FUNCTION "factory_certificate_guard"();
CREATE TRIGGER "Certificate_no_truncate" BEFORE TRUNCATE ON "Certificate"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_certificate_guard"();

-- CertificateCoverage
--   every row  it covers exactly one style or one item; an item's coverage names no colourways or sizes.
--   UPDATE     the certificate, the style or item and the creation never change (another coverage is a new row).
--   DELETE     refused: an end of coverage is ARCHIVED (the gate's history). TRUNCATE refused.
CREATE FUNCTION "factory_certificate_coverage_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('TRUNCATE', 'DELETE') THEN
    RAISE EXCEPTION 'compliance: % on "%" is refused; a coverage is archived, never removed', TG_OP, TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."styleId" IS NULL) = (NEW."itemId" IS NULL)
     OR (NEW."itemId" IS NOT NULL AND (cardinality(NEW."colourwayIds") > 0 OR cardinality(NEW."sizes") > 0)) THEN
    RAISE EXCEPTION 'compliance: coverage % covers exactly one style (with its colourways and sizes) or one item', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW."id", NEW."certificateId", NEW."styleId", NEW."itemId", NEW."createdAt", NEW."createdById")
         IS DISTINCT FROM
         (OLD."id", OLD."certificateId", OLD."styleId", OLD."itemId", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'compliance: the certificate and the style or item of coverage % never change', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CertificateCoverage_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CertificateCoverage"
  FOR EACH ROW EXECUTE FUNCTION "factory_certificate_coverage_guard"();
CREATE TRIGGER "CertificateCoverage_no_truncate" BEFORE TRUNCATE ON "CertificateCoverage"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_certificate_coverage_guard"();

-- LabelTemplate (PRD-331: a style revision points at the template revision its units carry)
--   UPDATE     the code, revision number and creation never change; once out of DRAFT, nothing but the status changes
--              (a change is a new revision); the status moves only DRAFT → ACTIVE | RETIRED and ACTIVE → RETIRED.
--   DELETE     only a draft. TRUNCATE refused.
CREATE FUNCTION "factory_label_template_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'compliance: TRUNCATE on "%" is refused', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'compliance: label template % is %; it is kept, never deleted', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF (NEW."id", NEW."code", NEW."revision", NEW."createdAt", NEW."createdById")
     IS DISTINCT FROM
     (OLD."id", OLD."code", OLD."revision", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'compliance: the code, revision and creation of label template % never change', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status"
     AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('ACTIVE', 'RETIRED'))
              OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'RETIRED')) THEN
    RAISE EXCEPTION 'compliance: label template % cannot move from % to %', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'DRAFT'
     AND (NEW."companyId", NEW."name", NEW."styleId", NEW."languages", NEW."makerPartyId", NEW."makerName",
          NEW."makerAddress", NEW."importerName", NEW."importerAddress", NEW."composition", NEW."animalOriginPhrase",
          NEW."care", NEW."layout", NEW."widthMm", NEW."heightMm")
         IS DISTINCT FROM
         (OLD."companyId", OLD."name", OLD."styleId", OLD."languages", OLD."makerPartyId", OLD."makerName",
          OLD."makerAddress", OLD."importerName", OLD."importerAddress", OLD."composition", OLD."animalOriginPhrase",
          OLD."care", OLD."layout", OLD."widthMm", OLD."heightMm") THEN
    RAISE EXCEPTION 'compliance: label template % is %; only its status changes, a change is a new revision', OLD."id", OLD."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "LabelTemplate_guard" BEFORE UPDATE OR DELETE ON "LabelTemplate"
  FOR EACH ROW EXECUTE FUNCTION "factory_label_template_guard"();
CREATE TRIGGER "LabelTemplate_no_truncate" BEFORE TRUNCATE ON "LabelTemplate"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_label_template_guard"();

-- ComplianceDocument (Reg. 2016/425 art. 15, Annex IX: the DoC; Annex II 1.4: the user information)
--   every row  ISSUED has issuedAt; DRAFT has none.
--   UPDATE     the style, kind, language, revision and creation never change; once out of DRAFT, nothing but the status
--              changes (a new DoC is a new revision); the status moves only DRAFT → ISSUED | WITHDRAWN,
--              ISSUED → SUPERSEDED | WITHDRAWN and SUPERSEDED → WITHDRAWN.
--   DELETE     only a draft; an issued document is kept (10 years). TRUNCATE refused.
CREATE FUNCTION "factory_compliance_document_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'compliance: TRUNCATE on "%" is refused', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'compliance: document % is %; it is kept, never deleted', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (NEW."id", NEW."styleId", NEW."kind", NEW."language", NEW."revision", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."styleId", OLD."kind", OLD."language", OLD."revision", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'compliance: the style, kind, language, revision and creation of document % never change', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('ISSUED', 'WITHDRAWN'))
                OR (OLD."status" = 'ISSUED' AND NEW."status" IN ('SUPERSEDED', 'WITHDRAWN'))
                OR (OLD."status" = 'SUPERSEDED' AND NEW."status" = 'WITHDRAWN')) THEN
      RAISE EXCEPTION 'compliance: document % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" <> 'DRAFT'
       AND (NEW."companyId", NEW."number", NEW."certificateId", NEW."makerPartyId", NEW."makerName", NEW."makerAddress",
            NEW."productIdentification", NEW."standards", NEW."signedByName", NEW."signedByFunction", NEW."signedPlace",
            NEW."signedOn", NEW."issuedAt")
           IS DISTINCT FROM
           (OLD."companyId", OLD."number", OLD."certificateId", OLD."makerPartyId", OLD."makerName", OLD."makerAddress",
            OLD."productIdentification", OLD."standards", OLD."signedByName", OLD."signedByFunction", OLD."signedPlace",
            OLD."signedOn", OLD."issuedAt") THEN
      RAISE EXCEPTION 'compliance: document % is %; only its status changes, a new document is a new revision', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF (NEW."status" = 'ISSUED' AND NEW."issuedAt" IS NULL) OR (NEW."status" = 'DRAFT' AND NEW."issuedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'compliance: document % is % with the wrong issue time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ComplianceDocument_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ComplianceDocument"
  FOR EACH ROW EXECUTE FUNCTION "factory_compliance_document_guard"();
CREATE TRIGGER "ComplianceDocument_no_truncate" BEFORE TRUNCATE ON "ComplianceDocument"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_compliance_document_guard"();
