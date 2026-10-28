-- Written by hand (Prisma does not model triggers or partial indexes), after the generated
-- 202610283600_sales_quotes_orders and before the policy migration. When the migrations are renumbered, keep this file as
-- it is under its new timestamp.

-- Sales (plan A1 §2.1 "Issued documents", §2.5; PLAN §2.8 "Codice del Consumo", §4.7; features SAL-157, SAL-184,
-- SAL-195, SAL-204, SAL-304, FIN-066). apps/factory-api's modules/sales checks all of this first; these rules hold for
-- every login, the owner included. The tenant and the party of a row are held by the policies (USING and WITH CHECK)
-- and by the references, not here: the triggers leave "tenantId" (and, where a partner may write, "partyId") to them.
-- Every refusal is a check_violation (SQLSTATE 23514): a restrict_violation reaches a Prisma model call as P2003 without
-- its message. A rule that reads another row skips a row this session cannot see (another tenant's): the policies
-- refuse that write anyway.
--
-- "Everything but these columns" is compared as jsonb (to_jsonb(row) minus the named keys), so a column added later is
-- frozen too unless a later migration names it.

CREATE FUNCTION "factory_sales_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sales: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- Quote (the header: its status follows its current version's)
--   UPDATE     an UPDATE that changes nothing passes; the company, number and creation never change; the status moves
--              DRAFT → PENDING_APPROVAL | SENT | CANCELLED, PENDING_APPROVAL → APPROVED | DRAFT | CANCELLED,
--              APPROVED → SENT | DRAFT | CANCELLED, SENT → ACCEPTED | DECLINED | EXPIRED | DRAFT (a new version) |
--              CANCELLED, DECLINED | EXPIRED → DRAFT (a new version); ACCEPTED and CANCELLED are final (only the internal
--              note changes). A partner session (the accept link: factory_partner_runtime, src/roles.ts) changes only
--              the status, SENT → ACCEPTED | DECLINED.
--   TRUNCATE   refused (no runtime role deletes a quote; a quote with versions cannot be deleted: the references).
CREATE FUNCTION "factory_quote_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'partyId'];
BEGIN
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."companyId", NEW."number", NEW."createdAt", NEW."createdById")
     IS DISTINCT FROM
     (OLD."id", OLD."companyId", OLD."number", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'sales: the company, number and creation of quote % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" <> OLD."status"
     AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('PENDING_APPROVAL', 'SENT', 'CANCELLED'))
              OR (OLD."status" = 'PENDING_APPROVAL' AND NEW."status" IN ('APPROVED', 'DRAFT', 'CANCELLED'))
              OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('SENT', 'DRAFT', 'CANCELLED'))
              OR (OLD."status" = 'SENT' AND NEW."status" IN ('ACCEPTED', 'DECLINED', 'EXPIRED', 'DRAFT', 'CANCELLED'))
              OR (OLD."status" IN ('DECLINED', 'EXPIRED') AND NEW."status" = 'DRAFT')) THEN
    RAISE EXCEPTION 'sales: quote % cannot move from % to %', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" IN ('ACCEPTED', 'CANCELLED')
     AND (to_jsonb(NEW) - (kept || ARRAY['internalNote', 'version', 'updatedAt']))
         IS DISTINCT FROM
         (to_jsonb(OLD) - (kept || ARRAY['internalNote', 'version', 'updatedAt'])) THEN
    RAISE EXCEPTION 'sales: quote % is %; only its internal note changes', OLD."id", OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF current_user = 'factory_partner_runtime'
     AND ((to_jsonb(NEW) - (kept || ARRAY['status', 'version', 'updatedAt']))
          IS DISTINCT FROM
          (to_jsonb(OLD) - (kept || ARRAY['status', 'version', 'updatedAt']))
          OR (NEW."status" <> OLD."status" AND NOT (OLD."status" = 'SENT' AND NEW."status" IN ('ACCEPTED', 'DECLINED')))) THEN
    RAISE EXCEPTION 'sales: a partner session only accepts or declines a SENT quote (quote %)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Quote_guard" BEFORE UPDATE ON "Quote"
  FOR EACH ROW EXECUTE FUNCTION "factory_quote_guard"();
CREATE TRIGGER "Quote_no_truncate" BEFORE TRUNCATE ON "Quote"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_refuse_truncate"();

-- QuoteVersion (SAL-157: the party accepts exactly what was sent)
--   INSERT     a version starts as DRAFT.
--   every row  from SENT on (SENT, ACCEPTED, DECLINED, EXPIRED, SUPERSEDED) it has sentAt, validUntil and the
--              document's SHA-256; before it (DRAFT, PENDING_APPROVAL, APPROVED) no sentAt; closedAt is set exactly in a
--              final status (ACCEPTED, DECLINED, EXPIRED, SUPERSEDED, CANCELLED).
--   UPDATE     an UPDATE that changes nothing passes; the quote, number and creation never change; the status moves
--              DRAFT → PENDING_APPROVAL | SENT | CANCELLED, PENDING_APPROVAL → APPROVED | DRAFT | CANCELLED,
--              APPROVED → SENT | DRAFT | CANCELLED, SENT → ACCEPTED | DECLINED | EXPIRED | SUPERSEDED | CANCELLED;
--              a SENT version changes nothing but that decision (status, closedAt, decisionNote); a final one never
--              changes. A partner session changes only a SENT version, to ACCEPTED or DECLINED. A version becomes
--              ACCEPTED only with its QuoteAcceptance row in the same transaction (checked at commit, below).
--   DELETE     only a DRAFT (no runtime role has the grant; a version that left DRAFT is kept). TRUNCATE refused.
-- At most one ACCEPTED version per quote: the partial unique index below.
CREATE FUNCTION "factory_quote_version_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'partyId'];
  sent_states CONSTANT text[] := ARRAY['SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED'];
  final_states CONSTANT text[] := ARRAY['ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED', 'CANCELLED'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'sales: quote version % is %; it is kept, never deleted', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'sales: quote version % starts as DRAFT, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."quoteId", NEW."revision", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."quoteId", OLD."revision", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'sales: the quote, number and creation of quote version % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('PENDING_APPROVAL', 'SENT', 'CANCELLED'))
                OR (OLD."status" = 'PENDING_APPROVAL' AND NEW."status" IN ('APPROVED', 'DRAFT', 'CANCELLED'))
                OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('SENT', 'DRAFT', 'CANCELLED'))
                OR (OLD."status" = 'SENT' AND NEW."status" IN ('ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'sales: quote version % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'SENT'
       AND (to_jsonb(NEW) - (kept || ARRAY['status', 'closedAt', 'decisionNote', 'version', 'updatedAt']))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || ARRAY['status', 'closedAt', 'decisionNote', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'sales: quote version % was sent; only its decision changes, a change is a new version', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status"::text = ANY (final_states) AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'sales: quote version % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_partner_runtime'
       AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept)
       AND NOT (OLD."status" = 'SENT' AND NEW."status" IN ('ACCEPTED', 'DECLINED')) THEN
      RAISE EXCEPTION 'sales: a partner session only accepts or declines a SENT quote version (version %)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."status"::text = ANY (sent_states) AND (NEW."sentAt" IS NULL OR NEW."validUntil" IS NULL OR NEW."documentSha256" IS NULL) THEN
    RAISE EXCEPTION 'sales: quote version % is % without its send time, validity or document hash', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED') AND NEW."sentAt" IS NOT NULL THEN
    RAISE EXCEPTION 'sales: quote version % is % but has a send time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status"::text = ANY (final_states)) <> (NEW."closedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'sales: quote version % is % with the wrong closing time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "QuoteVersion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "QuoteVersion"
  FOR EACH ROW EXECUTE FUNCTION "factory_quote_version_guard"();
CREATE TRIGGER "QuoteVersion_no_truncate" BEFORE TRUNCATE ON "QuoteVersion"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_refuse_truncate"();

-- One ACCEPTED version per quote (A1 §2.5: an order is made from THE accepted version). Prisma cannot express a partial
-- unique index, so it lives here.
CREATE UNIQUE INDEX "QuoteVersion_one_accepted_per_quote" ON "QuoteVersion" ("tenantId", "quoteId") WHERE "status" = 'ACCEPTED';

-- QuoteLine, QuoteLineSize: the parts of a version
--   INSERT, UPDATE, DELETE  only while the version is DRAFT (an approval or a send freezes them); a line never moves to
--                           another version, a size row to another line. An UPDATE that changes nothing passes. The
--                           version row is locked FOR SHARE, so a send or an approval request waits for the transaction
--                           that edits its parts (and an edit after it sees it).
--   every row               a line has at least one piece; a MADE_TO_MEASURE line is exactly one unit with a measurement
--                           profile, a SIZE_GRID line has none; a size row has at least one piece and belongs to a
--                           SIZE_GRID line.
--   TRUNCATE                refused.
CREATE FUNCTION "factory_quote_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  part_of uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."versionId" IS DISTINCT FROM OLD."versionId" THEN
      RAISE EXCEPTION 'sales: quote line % never moves to another version', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    part_of := NEW."versionId";
    SELECT v."status"::text INTO state FROM "QuoteVersion" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."versionId" FOR SHARE;
  ELSE
    part_of := OLD."versionId";
    SELECT v."status"::text INTO state FROM "QuoteVersion" v WHERE v."tenantId" = OLD."tenantId" AND v."id" = OLD."versionId" FOR SHARE;
  END IF;
  IF state IS NOT NULL AND state <> 'DRAFT' THEN
    RAISE EXCEPTION 'sales: quote version % is %; its lines change only while it is DRAFT', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."quantity" < 1
     OR (NEW."kind" = 'MADE_TO_MEASURE') <> (NEW."measurementProfileId" IS NOT NULL)
     OR (NEW."kind" = 'MADE_TO_MEASURE' AND NEW."quantity" <> 1) THEN
    RAISE EXCEPTION 'sales: quote line % is a size grid of at least one piece, or one made-to-measure unit with its measurement profile', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "QuoteLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "QuoteLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_quote_line_guard"();
CREATE TRIGGER "QuoteLine_no_truncate" BEFORE TRUNCATE ON "QuoteLine"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_refuse_truncate"();

CREATE FUNCTION "factory_quote_line_size_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  line_kind text;
  part_of uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."lineId" IS DISTINCT FROM OLD."lineId" THEN
      RAISE EXCEPTION 'sales: quote line size % never moves to another line', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT v."status"::text, l."kind"::text, v."id" INTO state, line_kind, part_of
      FROM "QuoteLine" l JOIN "QuoteVersion" v ON v."tenantId" = l."tenantId" AND v."id" = l."versionId"
      WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."lineId" FOR SHARE OF v;
  ELSE
    SELECT v."status"::text, l."kind"::text, v."id" INTO state, line_kind, part_of
      FROM "QuoteLine" l JOIN "QuoteVersion" v ON v."tenantId" = l."tenantId" AND v."id" = l."versionId"
      WHERE l."tenantId" = OLD."tenantId" AND l."id" = OLD."lineId" FOR SHARE OF v;
  END IF;
  IF state IS NOT NULL AND state <> 'DRAFT' THEN
    RAISE EXCEPTION 'sales: quote version % is %; its size quantities change only while it is DRAFT', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."quantity" < 1 OR (line_kind IS NOT NULL AND line_kind <> 'SIZE_GRID') THEN
    RAISE EXCEPTION 'sales: quote line size % has at least one piece, on a SIZE_GRID line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "QuoteLineSize_guard" BEFORE INSERT OR UPDATE OR DELETE ON "QuoteLineSize"
  FOR EACH ROW EXECUTE FUNCTION "factory_quote_line_size_guard"();
CREATE TRIGGER "QuoteLineSize_no_truncate" BEFORE TRUNCATE ON "QuoteLineSize"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_refuse_truncate"();

-- QuoteApproval (SAL-184)
--   every row  it names at least one rule; a PENDING approval has no decision time, a decided or withdrawn one has it;
--              APPROVED and REJECTED name their approver.
--   UPDATE     an UPDATE that changes nothing passes; nothing but the decision changes (status, decidedAt, decidedById,
--              decisionNote); the status moves only PENDING → APPROVED | REJECTED | WITHDRAWN; a decided approval never
--              changes.
--   DELETE     refused (the decision trail). TRUNCATE refused.
CREATE FUNCTION "factory_quote_approval_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sales: quote approval % is kept, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF OLD."status" <> 'PENDING' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'sales: quote approval % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (to_jsonb(NEW) - (kept || ARRAY['status', 'decidedAt', 'decidedById', 'decisionNote', 'version', 'updatedAt']))
       IS DISTINCT FROM
       (to_jsonb(OLD) - (kept || ARRAY['status', 'decidedAt', 'decidedById', 'decisionNote', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'sales: only the decision of quote approval % changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (OLD."status" = 'PENDING' AND NEW."status" IN ('APPROVED', 'REJECTED', 'WITHDRAWN')) THEN
      RAISE EXCEPTION 'sales: quote approval % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF cardinality(NEW."reasons") = 0 THEN
    RAISE EXCEPTION 'sales: quote approval % names at least one rule', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'PENDING') <> (NEW."decidedAt" IS NULL)
     OR (NEW."status" IN ('APPROVED', 'REJECTED') AND NEW."decidedById" IS NULL)
     OR (NEW."status" = 'PENDING' AND NEW."decidedById" IS NOT NULL) THEN
    RAISE EXCEPTION 'sales: quote approval % is % with the wrong decision time or approver', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "QuoteApproval_guard" BEFORE INSERT OR UPDATE OR DELETE ON "QuoteApproval"
  FOR EACH ROW EXECUTE FUNCTION "factory_quote_approval_guard"();
CREATE TRIGGER "QuoteApproval_no_truncate" BEFORE TRUNCATE ON "QuoteApproval"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_refuse_truncate"();

-- QuoteAcceptance: append-only (plan A1 §2.1; scripts/factory/check-append-only.mjs). The evidence that a party accepted
-- one version (SAL-157, SAL-304), so no login may change or remove one, the owner and superusers included. The runtime
-- roles have no UPDATE, DELETE or TRUNCATE grant either (the policy migration).
--   INSERT     a LINK acceptance names its link and the email check, an OFFICE one neither; it names who accepted; its
--              version is ACCEPTED (the command moves the version first), it names that version's document hash, and a
--              version that states no right of withdrawal is accepted only with that statement accepted (Codice del
--              Consumo art. 59(c)).
CREATE FUNCTION "factory_refuse_quote_acceptance_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; an acceptance is kept as it was made', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER "QuoteAcceptance_append_only" BEFORE UPDATE OR DELETE ON "QuoteAcceptance"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_quote_acceptance_change"();
CREATE TRIGGER "QuoteAcceptance_no_truncate" BEFORE TRUNCATE ON "QuoteAcceptance"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_quote_acceptance_change"();

CREATE FUNCTION "factory_quote_acceptance_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  document text;
  states_no_withdrawal boolean;
BEGIN
  IF (NEW."channel" = 'LINK') <> (NEW."linkId" IS NOT NULL) OR (NEW."channel" = 'LINK') <> (NEW."emailCheck" IS NOT NULL) THEN
    RAISE EXCEPTION 'sales: acceptance % names its link and email check exactly when it came through a link', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."signerName") = '' THEN
    RAISE EXCEPTION 'sales: acceptance % names who accepted', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT v."status"::text, v."documentSha256", v."noWithdrawal" INTO state, document, states_no_withdrawal
    FROM "QuoteVersion" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."versionId";
  IF FOUND THEN
    IF state <> 'ACCEPTED' THEN
      RAISE EXCEPTION 'sales: acceptance % is for quote version %, which is %, not ACCEPTED', NEW."id", NEW."versionId", state
        USING ERRCODE = 'check_violation';
    END IF;
    IF document IS DISTINCT FROM NEW."documentSha256" THEN
      RAISE EXCEPTION 'sales: acceptance % names another document than the one quote version % was sent with', NEW."id", NEW."versionId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF states_no_withdrawal AND NOT NEW."noWithdrawalAccepted" THEN
      RAISE EXCEPTION 'sales: quote version % states that a made-to-measure unit has no right of withdrawal; acceptance % must record that it was accepted (Codice del Consumo art. 59(c))', NEW."versionId", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "QuoteAcceptance_check" BEFORE INSERT ON "QuoteAcceptance"
  FOR EACH ROW EXECUTE FUNCTION "factory_quote_acceptance_check"();

-- An ACCEPTED version has its evidence: the transaction that moves a version to ACCEPTED adds its QuoteAcceptance row
-- (the accept link's command, or the office recording a signed copy). Checked at commit (a deferred constraint
-- trigger), so the version moves first and the evidence row, which names an ACCEPTED version, follows.
CREATE FUNCTION "factory_quote_version_accepted_has_evidence"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "QuoteAcceptance" e WHERE e."tenantId" = NEW."tenantId" AND e."versionId" = NEW."id") THEN
    RAISE EXCEPTION 'sales: quote version % is ACCEPTED without its acceptance (a QuoteAcceptance row in the same transaction)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "QuoteVersion_accepted_has_evidence" AFTER UPDATE ON "QuoteVersion"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."status" = 'ACCEPTED' AND OLD."status" <> 'ACCEPTED')
  EXECUTE FUNCTION "factory_quote_version_accepted_has_evidence"();

-- DepositRequest (SAL-195, FIN-066)
--   every row  the amount is above 0; it names its accepted version or its order (or both); paidAt is set exactly when
--              PAID.
--   INSERT     its version, when named, is ACCEPTED.
--   UPDATE     an UPDATE that changes nothing passes; only the status, paidAt, the internal note, the due date and the
--              order (named once) change: the amount, currency, kind, fiscal decision, company, party and version never
--              do (a different deposit is a new request); the status moves only OPEN → PAID | WAIVED | CANCELLED; a
--              PAID, WAIVED or CANCELLED request never changes.
--   DELETE     refused (a request is cancelled). TRUNCATE refused.
CREATE FUNCTION "factory_deposit_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sales: deposit request % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."quoteVersionId" IS NOT NULL THEN
      SELECT v."status"::text INTO state FROM "QuoteVersion" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."quoteVersionId";
      IF FOUND AND state <> 'ACCEPTED' THEN
        RAISE EXCEPTION 'sales: deposit request % is for quote version %, which is %, not ACCEPTED', NEW."id", NEW."quoteVersionId", state
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF OLD."status" <> 'OPEN' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'sales: deposit request % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (to_jsonb(NEW) - (kept || ARRAY['status', 'paidAt', 'statusNote', 'dueDate', 'orderId', 'version', 'updatedAt']))
       IS DISTINCT FROM
       (to_jsonb(OLD) - (kept || ARRAY['status', 'paidAt', 'statusNote', 'dueDate', 'orderId', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'sales: the amount, currency, kind, fiscal decision, party and version of deposit request % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."orderId" IS NOT NULL AND NEW."orderId" IS DISTINCT FROM OLD."orderId" THEN
      RAISE EXCEPTION 'sales: the order of deposit request % is named once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (OLD."status" = 'OPEN' AND NEW."status" IN ('PAID', 'WAIVED', 'CANCELLED')) THEN
      RAISE EXCEPTION 'sales: deposit request % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."amount" <= 0 THEN
    RAISE EXCEPTION 'sales: the amount of deposit request % is above 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."quoteVersionId" IS NULL AND NEW."orderId" IS NULL THEN
    RAISE EXCEPTION 'sales: deposit request % names its accepted quote version or its order', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'PAID') <> (NEW."paidAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'sales: deposit request % is % with the wrong payment time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "DepositRequest_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DepositRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_deposit_request_guard"();
CREATE TRIGGER "DepositRequest_no_truncate" BEFORE TRUNCATE ON "DepositRequest"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_refuse_truncate"();

-- SalesOrder (SAL-200, SAL-204; A1 §2.5)
--   every row  CANCELLED has a reason, no other status has one; closedAt is set exactly when CLOSED or CANCELLED.
--   INSERT     an order made from a quote version is made from an ACCEPTED version of a quote of its own company.
--   UPDATE     an UPDATE that changes nothing passes; the company, party, number, quote version, currency and creation
--              never change; originalPromiseDate is set once; CLOSED comes only from SHIPPED (the close command asks
--              whether every line is shipped, invoiced and paid), CANCELLED only from CONFIRMED, IN_PRODUCTION or READY
--              (before anything shipped); a CLOSED or CANCELLED order never changes. The other moves are the domain's
--              state machine.
--   DELETE     refused (an order is cancelled). TRUNCATE refused.
CREATE FUNCTION "factory_sales_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  state text;
  quote_company uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sales: sales order % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."quoteVersionId" IS NOT NULL THEN
      SELECT v."status"::text, q."companyId" INTO state, quote_company
        FROM "QuoteVersion" v JOIN "Quote" q ON q."tenantId" = v."tenantId" AND q."id" = v."quoteId"
        WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."quoteVersionId";
      IF FOUND AND (state <> 'ACCEPTED' OR quote_company <> NEW."companyId") THEN
        RAISE EXCEPTION 'sales: sales order % is made only from an ACCEPTED version of a quote of its own company (version % is %)', NEW."id", NEW."quoteVersionId", state
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."number", NEW."quoteVersionId", NEW."currency", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."partyId", OLD."number", OLD."quoteVersionId", OLD."currency", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'sales: the company, party, number, quote version, currency and creation of sales order % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."originalPromiseDate" IS NOT NULL AND NEW."originalPromiseDate" IS DISTINCT FROM OLD."originalPromiseDate" THEN
      RAISE EXCEPTION 'sales: the first promised date of sales order % is set once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('CLOSED', 'CANCELLED') AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'sales: sales order % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND ((NEW."status" = 'CLOSED' AND OLD."status" <> 'SHIPPED')
            OR (NEW."status" = 'CANCELLED' AND OLD."status" NOT IN ('CONFIRMED', 'IN_PRODUCTION', 'READY'))) THEN
      RAISE EXCEPTION 'sales: sales order % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."status" = 'CANCELLED') <> (coalesce(btrim(NEW."cancelReason"), '') <> '') THEN
    RAISE EXCEPTION 'sales: sales order % has a cancel reason exactly when it is CANCELLED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('CLOSED', 'CANCELLED')) <> (NEW."closedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'sales: sales order % is % with the wrong closing time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SalesOrder_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SalesOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_order_guard"();
CREATE TRIGGER "SalesOrder_no_truncate" BEFORE TRUNCATE ON "SalesOrder"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_refuse_truncate"();

-- SalesOrderLine, SalesOrderLineSize: the parts of an order (SAL-203; an amendment changes them)
--   INSERT, UPDATE, DELETE  only while the order is CONFIRMED, IN_PRODUCTION or READY: once anything shipped they are
--                           fixed (a later change is a return); a line never moves to another order, a size row to
--                           another line. An UPDATE that changes nothing passes. The order row is locked FOR SHARE, so a
--                           shipment or a close waits for the transaction that amends its lines.
--   every row               as for quote lines: a line has at least one piece; a MADE_TO_MEASURE line is exactly one
--                           unit with a measurement profile, a SIZE_GRID line has none; a size row has at least one
--                           piece and belongs to a SIZE_GRID line.
--   TRUNCATE                refused.
CREATE FUNCTION "factory_sales_order_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  part_of uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."orderId" IS DISTINCT FROM OLD."orderId" THEN
      RAISE EXCEPTION 'sales: sales order line % never moves to another order', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    part_of := NEW."orderId";
    SELECT o."status"::text INTO state FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."orderId" FOR SHARE;
  ELSE
    part_of := OLD."orderId";
    SELECT o."status"::text INTO state FROM "SalesOrder" o WHERE o."tenantId" = OLD."tenantId" AND o."id" = OLD."orderId" FOR SHARE;
  END IF;
  IF state IS NOT NULL AND state NOT IN ('CONFIRMED', 'IN_PRODUCTION', 'READY') THEN
    RAISE EXCEPTION 'sales: sales order % is %; its lines change only while it is CONFIRMED, IN_PRODUCTION or READY', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."quantity" < 1
     OR (NEW."kind" = 'MADE_TO_MEASURE') <> (NEW."measurementProfileId" IS NOT NULL)
     OR (NEW."kind" = 'MADE_TO_MEASURE' AND NEW."quantity" <> 1) THEN
    RAISE EXCEPTION 'sales: sales order line % is a size grid of at least one piece, or one made-to-measure unit with its measurement profile', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SalesOrderLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SalesOrderLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_order_line_guard"();
CREATE TRIGGER "SalesOrderLine_no_truncate" BEFORE TRUNCATE ON "SalesOrderLine"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_refuse_truncate"();

CREATE FUNCTION "factory_sales_order_line_size_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  line_kind text;
  part_of uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."lineId" IS DISTINCT FROM OLD."lineId" THEN
      RAISE EXCEPTION 'sales: sales order line size % never moves to another line', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT o."status"::text, l."kind"::text, o."id" INTO state, line_kind, part_of
      FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o."tenantId" = l."tenantId" AND o."id" = l."orderId"
      WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."lineId" FOR SHARE OF o;
  ELSE
    SELECT o."status"::text, l."kind"::text, o."id" INTO state, line_kind, part_of
      FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o."tenantId" = l."tenantId" AND o."id" = l."orderId"
      WHERE l."tenantId" = OLD."tenantId" AND l."id" = OLD."lineId" FOR SHARE OF o;
  END IF;
  IF state IS NOT NULL AND state NOT IN ('CONFIRMED', 'IN_PRODUCTION', 'READY') THEN
    RAISE EXCEPTION 'sales: sales order % is %; its size quantities change only while it is CONFIRMED, IN_PRODUCTION or READY', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."quantity" < 1 OR (line_kind IS NOT NULL AND line_kind <> 'SIZE_GRID') THEN
    RAISE EXCEPTION 'sales: sales order line size % has at least one piece, on a SIZE_GRID line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SalesOrderLineSize_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SalesOrderLineSize"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_order_line_size_guard"();
CREATE TRIGGER "SalesOrderLineSize_no_truncate" BEFORE TRUNCATE ON "SalesOrderLineSize"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_refuse_truncate"();
