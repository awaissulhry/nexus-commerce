-- Written by hand (Prisma does not model triggers), after the generated 202611011702_service_safety_w2b_schema and before
-- the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Returns, repairs, service and product safety in depth, W2b-5 schema wave 43/44 (B-W2b-291; SAL-298, SAL-336, SAL-337,
-- SAL-338, SAL-342, SAL-343, SAL-346, SAL-350, SAL-351, SAL-355, SAL-360, SAL-368, SAL-384, SAL-385, SAL-387, SAL-391,
-- SAL-393, SAL-414, SAL-415, SAL-423). apps/factory-api's modules/sales/returns-depth (B-W2b-341), returns-outcomes
-- (B-W2b-346), repairs-depth (B-W2b-342), service (B-W2b-345) and safety-reports (B-W2b-351) check all of this first and
-- answer in words; these rules are the last word, for every login, the owner included.
--
--   ReturnPolicy         a name of one line (1 to 120); 1 to 365 days to ask, at least 14 for consumers at a distance (the
--                        right of withdrawal, Codice del Consumo art. 52); 1 to 365 days for the goods or none; conditions
--                        (1 to 4000) and withdrawal words (1 to 8000, consumers at a distance only); retired once, never
--                        back; its company, channel and creation never change; one an RMA names keeps its terms (a change is
--                        a new policy); one live (not retired) policy per company and channel (a partial unique index).
--                        Never deleted.
--   ReturnFeeRule        a name of one line (1 to 120); the reason group's codes each once, at most 50, each of the reason
--                        codes' shape; PERCENT exactly with a percent above 0 and at most 100, AMOUNT exactly with an amount
--                        above 0 and its currency (ISO 4217); the order 1 to 9999; its company and creation never change;
--                        one a return line names keeps its terms (switch it off and make another). Never deleted.
--   ReturnAuthorisation  (new columns; W2a's guard as it is) the scan code of the papers in its shape
--                        (`^[A-Z0-9][A-Z0-9-]{5,39}$`), set once; the finish reason only on a CLOSED RMA; the policy and the
--                        withdrawal change only before the goods arrive (REQUESTED, AUTHORISED); a policy is named while it
--                        is live; a withdrawal only under a CONSUMER_DISTANCE policy.
--   ReturnLine           REDEFINED `factory_return_line_guard` (W2a's …_sales_w2a_guards, word for word) with: a line split
--                        after a partial receipt (SAL-350: the line cut down to what arrived, a new line split from it taking
--                        the rest, of the same order and invoice line, size, reason and price, nothing received; at commit
--                        the split lines cover the cut, ReturnLine_split_kept); credit without the goods (SAL-342:
--                        no pieces, no inspection, CREDIT_ONLY; also for a line none of whose pieces came after others
--                        arrived); the size exchange (SAL-351: the other size exactly then; a
--                        replacement line for REPLACE or SIZE_EXCHANGE); the fee (SAL-343: only with a decision, with its
--                        rule, an active rule of the RMA's company, 0 or more, NONE when the cause found is ours); the
--                        garment and lot of ours (SAL-336: never a sample made for no order, B-W2b-284's rule; the serial's
--                        batch when both are named); the dock may write the garment and lot it scans at the receipt.
--   RepairOrder          (new columns; W2a's guard as it is) how the request reached us never changes; the work wanted 1 to
--                        2000 characters.
--   RepairEstimate       inserted DRAFT for a repair that is not SHIPPED or CANCELLED, of the repair's company and customer;
--                        DRAFT → SENT | WITHDRAWN, SENT → ACCEPTED | DECLINED | WITHDRAWN, then frozen but its internal
--                        note; sent exactly with when and by whom, with one line or more, then what the customer saw (the
--                        currency, the end day, the words) never changes; the answer exactly with ACCEPTED or DECLINED (when,
--                        how; the office person exactly for an OFFICE answer; an acceptance by the end day); withdrawn
--                        exactly with when; times not in the future, the answer not before the sending; the repair,
--                        company, site, customer, revision and creation never change. Never deleted.
--   RepairEstimateLine   written (added, changed, removed) only while its estimate is DRAFT; a description (1 to 500, one
--                        line); quantity above 0; labour exactly with its minutes (1 to 100000); an item only for a part;
--                        prices and amounts 0 or more; the cost per unit and in all both or neither, 0 or more; its estimate
--                        and creation never change.
--   ServiceCase          its number (SERVICE_CASE); inserted NEW or OPEN; NEW → OPEN | CLOSED; OPEN → WAITING_CUSTOMER |
--                        WAITING_PART | RESOLVED | CLOSED; a waiting case → OPEN | the other waiting state | RESOLVED |
--                        CLOSED; RESOLVED → OPEN | CLOSED; CLOSED frozen but its internal note; the company, number, channel
--                        and creation never change; the problem (1 to 4000); serial and batch as typed (1 to 100, one line),
--                        the serial's batch when both of ours are named; a colourway with its style, a contact with its
--                        party; the guarantees end on or after delivery; the cover decided with its cover, words (1 to 2000),
--                        when and by whom (all or none): COVERED or PARTLY under the legal or the factory's guarantee, with
--                        its end day; NOT_COVERED with NONE; resolved exactly while RESOLVED (and kept when CLOSED from
--                        there) with what was done (1 to 4000); closed exactly when CLOSED, without a resolution only with
--                        the reason (1 to 2000); times not in the future. Never deleted.
--   ServiceCaseLink      a record type (a model name) and its id; a note of one line (1 to 500); added and removed only
--                        while its case is not CLOSED; never changed.
--   ProductSafetyReport  its number (SAFETY_REPORT); inserted NEW; NEW → ASSESSING | CLOSED, ASSESSING → CLOSED; CLOSED
--                        frozen but the reporter's personal data, which may be erased (blanked); the company, number,
--                        source, receive time and creation never change; a PORTAL report names its party; a contact with its
--                        party, a colourway with its style; what happened (1 to 4000); the reporter's name (1 to 200), e-mail
--                        and phone in their shapes; serial and batch as given (1 to 100, one line), the serial's batch when
--                        both of ours are named; the day it happened not after the report; seen once, with who and when,
--                        before ASSESSING; closed exactly with when, by whom and the words (1 to 2000); its service case (a
--                        SAFETY case) and its register entry (of its style when both name one) set once; times not in the
--                        future. Never deleted.
--   ProductSafetyInjury  its key `injury:<report>` (one per report); whether someone was hurt, the consent and the report
--                        never change; the words (1 to 2000) only when someone was hurt and with the consent; erased once
--                        (the words blanked with when; who optional) and never back. Never deleted. Never a search entry
--                        (SearchEntry_not_injury); no partner or floor grant, no export (the API's test).
--   AccidentLogEntry     append-only (UPDATE, DELETE, TRUNCATE refused, for every login); a revision above every earlier one
--                        of its report, from 1 (under an advisory lock per report), with the reason from the second entry
--                        of a report on; the day not in the future and not after the report; the place (1 to 300, one line);
--                        serial and batch (1 to 100, one line); the authority told exactly with when and by whom, not in the
--                        future and not before the accident's day, its reference (1 to 200) and the notice (a SENT
--                        authority notice of the company) only then.
--   PpeRegisterEntry     REDEFINED `factory_ppe_register_entry_guard` (…_recall_claims_w2b_guards' body, word for word) with
--                        one more source type, ProductSafetyReport (an entry opened from a safety report, SAL-414).
--
-- As every W2b guard: every refusal is a check_violation (SQLSTATE 23514) in words; the checks of the new tables are AFTER
-- triggers (the policies speak first), but the number guards and the refused deletes (BEFORE: the runtime roles have no
-- DELETE grant on most of these tables anyway, so these speak to the owner) and the redefined W2a and register functions
-- (their BEFORE triggers stay). The tenant of a row is left to the policies and the references, never compared here: a rule
-- that reads another row skips a row this session cannot see. An UPDATE that changes nothing passes.
--
-- The generated isolation tests copy the first seeded row of each table (a new id, unique text suffixed, unique numbers and
-- dates moved) and insert the copy: so the first rows the seed gives are ones a copy may repeat (a retired policy, a fee rule,
-- a DRAFT estimate and its line, a NEW case and its link, a NEW report, its injury (the key only starts with
-- `injury:<report>`), the accident log's second revision of a report with its reason).
--
-- USED FROM EARLIER WAVES, as they are: "factory_document_number_guard" (…_numbering_floor_documents_guards),
-- "factory_money_rome_day" (…_money_w2a_guards), "factory_recall_words_ok", "factory_recall_not_future" and
-- "factory_recall_model_name_ok" (…_recall_claims_w2b_guards), "factory_approval_code_ok" (…_approvals_w2b_guards).

CREATE FUNCTION "factory_service_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'service: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_service_never_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'service: % % is kept, never deleted (retire, switch off, withdraw, close or erase it)', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_service_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'service: the accident log is never changed or removed (% of AccidentLogEntry %); add a new revision', TG_OP, OLD."id"
    USING ERRCODE = 'check_violation';
END
$$;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['ReturnPolicy', 'ReturnFeeRule', 'RepairEstimate', 'RepairEstimateLine', 'ServiceCase', 'ServiceCaseLink',
                              'ProductSafetyReport', 'ProductSafetyInjury'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_service_refuse_truncate"()', name || '_no_truncate', name);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['ReturnPolicy', 'ReturnFeeRule', 'RepairEstimate', 'ServiceCase', 'ProductSafetyReport', 'ProductSafetyInjury'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION "factory_service_never_deleted"()', name || '_never_deleted', name);
  END LOOP;
END
$$;

-- A serial or batch number as typed or read from a label: 1 to 100 characters of one line.
CREATE FUNCTION "factory_service_label_ok"(code text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT code IS NULL OR "factory_recall_words_ok"(code, 100, false)
$$;

-- The garment and lot of ours a row names (SAL-336): what is wrong with them, or NULL. The serial's work order's batch is
-- the batch the row names, when it names both; `refuse_sample`: a garment of a sample cell made for no order line is refused
-- (B-W2b-284: it was never sold, so it does not come back on a return). Rows this session cannot see are skipped.
CREATE FUNCTION "factory_service_garment_problem"(tenant uuid, garment_serial text, garment_batch text, refuse_sample boolean)
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
  serial_batch text;
  order_line uuid;
BEGIN
  IF garment_serial IS NOT NULL THEN
    SELECT w."batchNumber", s."salesOrderLineId" INTO serial_batch, order_line
      FROM "GarmentSerial" g
      JOIN "WorkOrderSize" s ON s."tenantId" = g."tenantId" AND s."id" = g."workOrderSizeId"
      JOIN "WorkOrder" w ON w."tenantId" = g."tenantId" AND w."id" = g."workOrderId"
     WHERE g."tenantId" = tenant AND g."serial" = garment_serial;
    IF FOUND THEN
      IF refuse_sample AND order_line IS NULL THEN
        RETURN format('serial %s is a sample made for no order: it was never sold, so it does not come back on a return', garment_serial);
      END IF;
      IF garment_batch IS NOT NULL AND serial_batch IS DISTINCT FROM garment_batch THEN
        RETURN format('serial %s is of batch %s, not of batch %s', garment_serial, coalesce(serial_batch, '(none)'), garment_batch);
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- =====================================================================================================================
-- ReturnPolicy (SAL-338)
CREATE FUNCTION "factory_return_policy_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."channel", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."channel", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'returns: the company, channel and creation of return policy % never change (make a new policy)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."retiredAt" IS NOT NULL AND (NEW."retiredAt", NEW."retiredById") IS DISTINCT FROM (OLD."retiredAt", OLD."retiredById") THEN
      RAISE EXCEPTION 'returns: return policy % was retired; it stays retired', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."windowDays", NEW."goodsDueDays", NEW."freightPaidBy", NEW."conditions", NEW."withdrawalWords", NEW."effectiveFrom")
       IS DISTINCT FROM
       (OLD."windowDays", OLD."goodsDueDays", OLD."freightPaidBy", OLD."conditions", OLD."withdrawalWords", OLD."effectiveFrom")
       AND EXISTS (SELECT 1 FROM "ReturnAuthorisation" r WHERE r."tenantId" = OLD."tenantId" AND r."policyId" = OLD."id") THEN
      RAISE EXCEPTION 'returns: return policy % is named by an RMA: its terms never change (retire it and make a new policy)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."name", 120, false) OR NEW."name" IS NULL THEN
    RAISE EXCEPTION 'returns: return policy % has a name of one line, 1 to 120 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."windowDays" NOT BETWEEN 1 AND 365 OR (NEW."channel" = 'CONSUMER_DISTANCE' AND NEW."windowDays" < 14) THEN
    RAISE EXCEPTION 'returns: return policy % gives 1 to 365 days to ask, and a consumer at a distance at least 14 (Codice del Consumo art. 52)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."goodsDueDays" NOT BETWEEN 1 AND 365 THEN
    RAISE EXCEPTION 'returns: return policy % gives the goods 1 to 365 days to arrive, or no deadline', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."conditions", 4000, true) THEN
    RAISE EXCEPTION 'returns: the conditions of return policy % are 1 to 4000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."withdrawalWords" IS NOT NULL AND NEW."channel" <> 'CONSUMER_DISTANCE') OR NOT "factory_recall_words_ok"(NEW."withdrawalWords", 8000, true) THEN
    RAISE EXCEPTION 'returns: return policy % has withdrawal words (1 to 8000 characters) only for consumers at a distance', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."retiredById" IS NOT NULL AND NEW."retiredAt" IS NULL) OR NOT "factory_recall_not_future"(NEW."retiredAt") THEN
    RAISE EXCEPTION 'returns: return policy % is retired with a time not in the future (and who, when a person did it)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "ReturnPolicy_guard" AFTER INSERT OR UPDATE ON "ReturnPolicy"
  FOR EACH ROW EXECUTE FUNCTION "factory_return_policy_guard"();
-- One live policy per company and channel.
CREATE UNIQUE INDEX "ReturnPolicy_one_live" ON "ReturnPolicy" ("tenantId", "companyId", "channel") WHERE "retiredAt" IS NULL;

-- =====================================================================================================================
-- ReturnFeeRule (SAL-343)
CREATE FUNCTION "factory_return_fee_rule_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'returns: the company and creation of fee rule % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."channel", NEW."reasonCodes", NEW."kind", NEW."percent", NEW."amount", NEW."currency")
       IS DISTINCT FROM (OLD."channel", OLD."reasonCodes", OLD."kind", OLD."percent", OLD."amount", OLD."currency")
       AND EXISTS (SELECT 1 FROM "ReturnLine" l WHERE l."tenantId" = OLD."tenantId" AND l."feeRuleId" = OLD."id") THEN
      RAISE EXCEPTION 'returns: fee rule % gave a fee on a return line: its terms never change (switch it off and make another)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."name" IS NULL OR NOT "factory_recall_words_ok"(NEW."name", 120, false) THEN
    RAISE EXCEPTION 'returns: fee rule % has a name of one line, 1 to 120 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reasonCodes" IS NULL OR cardinality(NEW."reasonCodes") > 50
     OR cardinality(NEW."reasonCodes") <> cardinality(ARRAY(SELECT DISTINCT unnest(NEW."reasonCodes")))
     OR EXISTS (SELECT 1 FROM unnest(NEW."reasonCodes") AS c(code) WHERE NOT "factory_approval_code_ok"(c.code)) THEN
    RAISE EXCEPTION 'returns: fee rule % lists at most 50 reason codes, each once, each of the reason codes'' shape', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'PERCENT' AND (NEW."percent" IS NULL OR NEW."percent" <= 0 OR NEW."percent" > 100 OR NEW."amount" IS NOT NULL OR NEW."currency" IS NOT NULL))
     OR (NEW."kind" = 'AMOUNT' AND (NEW."amount" IS NULL OR NEW."amount" <= 0 OR NEW."currency" IS NULL OR NEW."currency" !~ '^[A-Z]{3}$' OR NEW."percent" IS NOT NULL)) THEN
    RAISE EXCEPTION 'returns: fee rule % is a percent above 0 and at most 100, or an amount above 0 with its currency', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sequence" NOT BETWEEN 1 AND 9999 THEN
    RAISE EXCEPTION 'returns: fee rule % has its order 1 to 9999', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "ReturnFeeRule_guard" AFTER INSERT OR UPDATE ON "ReturnFeeRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_return_fee_rule_guard"();

-- =====================================================================================================================
-- ReturnAuthorisation: the W2b-5 columns (SAL-337, SAL-338, SAL-346, SAL-360). W2a's factory_return_authorisation_guard
-- stays as it is: a final RMA never changes (these columns too), and the dock changes none of them.
CREATE FUNCTION "factory_return_authorisation_w2b_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  policy_channel text;
  policy_retired timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF NEW."scanCode" IS NOT NULL AND NEW."scanCode" !~ '^[A-Z0-9][A-Z0-9-]{5,39}$' THEN
    RAISE EXCEPTION 'returns: the scan code of RMA % is 6 to 40 capital letters, digits and dashes', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."scanCode" IS NOT NULL AND NEW."scanCode" IS DISTINCT FROM OLD."scanCode" THEN
    RAISE EXCEPTION 'returns: the scan code of RMA % is printed on its papers: set once, never changed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."finishReason" IS NOT NULL AND NEW."status" <> 'CLOSED' THEN
    RAISE EXCEPTION 'returns: RMA % has a finish reason only once it is CLOSED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."policyId", NEW."withdrawal") IS DISTINCT FROM (OLD."policyId", OLD."withdrawal")
     AND OLD."status" NOT IN ('REQUESTED', 'AUTHORISED') THEN
    RAISE EXCEPTION 'returns: the policy and the withdrawal of RMA % change only before the goods arrive', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."policyId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."policyId" IS DISTINCT FROM OLD."policyId" OR NEW."withdrawal" IS DISTINCT FROM OLD."withdrawal") THEN
    SELECT p."channel"::text, p."retiredAt" INTO policy_channel, policy_retired FROM "ReturnPolicy" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."policyId";
    IF FOUND AND (NEW."policyId" IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD."policyId" END)) AND policy_retired IS NOT NULL THEN
      RAISE EXCEPTION 'returns: RMA % names return policy %, which was retired: name the live policy', NEW."id", NEW."policyId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF FOUND AND NEW."withdrawal" AND policy_channel <> 'CONSUMER_DISTANCE' THEN
      RAISE EXCEPTION 'returns: RMA % is a consumer''s withdrawal only under a policy for consumers at a distance (Codice del Consumo art. 52)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."withdrawal" AND NEW."policyId" IS NULL THEN
    RAISE EXCEPTION 'returns: RMA % is a consumer''s withdrawal only under a policy for consumers at a distance (Codice del Consumo art. 52)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "ReturnAuthorisation_w2b_guard" AFTER INSERT OR UPDATE ON "ReturnAuthorisation"
  FOR EACH ROW EXECUTE FUNCTION "factory_return_authorisation_w2b_guard"();

-- =====================================================================================================================
-- ReturnLine (redefines …_sales_w2a_guards' "factory_return_line_guard"; the trigger stays): W2a's rules word for word, with
-- the W2b-5 columns: the dock may also write the garment and lot it scans; a line split after a partial receipt (SAL-350);
-- credit without the goods (SAL-342); the size exchange (SAL-351); the fee (SAL-343); the garment and lot of ours (SAL-336).

CREATE OR REPLACE FUNCTION "factory_return_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  later CONSTANT text[] := ARRAY['receivedQuantity', 'receivedAt', 'receiptId', 'grade', 'cause', 'conditionNote', 'inspectedAt', 'inspectedById',
                                 'disposition', 'goodsOutcome', 'decidedAt', 'decidedById', 'creditAmount', 'replacementLineId', 'version', 'updatedAt',
                                 'garmentSerial', 'garmentBatch', 'exchangeSize', 'feeRuleId', 'feeAmount', 'creditWithoutReturn'];
  dock CONSTANT text[] := ARRAY['receivedQuantity', 'receivedAt', 'receiptId', 'grade', 'cause', 'conditionNote', 'inspectedAt', 'inspectedById',
                                'disposition', 'goodsOutcome', 'decidedAt', 'decidedById', 'version', 'updatedAt', 'garmentSerial', 'garmentBatch'];
  state text;
  part_of uuid;
  sold numeric;
  taken numeric;
  billed_line uuid;
  billed_size text;
  line_kind text;
  parent record;
  rma_company uuid;
  rule_company uuid;
  rule_active boolean;
  problem text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."returnId" IS DISTINCT FROM OLD."returnId" OR NEW."partyId" IS DISTINCT FROM OLD."partyId" THEN
      RAISE EXCEPTION 'returns: RMA line % never moves to another RMA or customer', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."parentLineId" IS DISTINCT FROM OLD."parentLineId" THEN
      RAISE EXCEPTION 'returns: the line RMA line % was split from never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime' AND (to_jsonb(NEW) - (kept || dock)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || dock)) THEN
      RAISE EXCEPTION 'returns: the dock writes only what arrived, its grade and its outcome (RMA line %)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    part_of := NEW."returnId";
    SELECT r."status"::text INTO state FROM "ReturnAuthorisation" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."returnId" FOR SHARE;
  ELSE
    part_of := OLD."returnId";
    SELECT r."status"::text INTO state FROM "ReturnAuthorisation" r WHERE r."tenantId" = OLD."tenantId" AND r."id" = OLD."returnId" FOR SHARE;
  END IF;
  IF state IN ('CLOSED', 'REJECTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'returns: RMA % is %; its lines never change', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b-5 (SAL-350): once the goods arrived, a line of which only part came is split: the line keeps what arrived (its
  -- pieces cut down to its received pieces) and a new line, split from it, takes the rest, still expected (checked at commit
  -- by ReturnLine_split_kept). Nothing else of what comes back changes.
  IF state IN ('RECEIVED', 'INSPECTED')
     AND NOT (TG_OP = 'INSERT' AND NEW."parentLineId" IS NOT NULL)
     AND (TG_OP <> 'UPDATE'
          OR ((to_jsonb(NEW) - (kept || later)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || later))
              AND NOT ((to_jsonb(NEW) - (kept || later || ARRAY['quantity'])) IS NOT DISTINCT FROM (to_jsonb(OLD) - (kept || later || ARRAY['quantity']))
                       AND NEW."quantity" < OLD."quantity" AND NEW."receivedQuantity" >= 1 AND NEW."quantity" = NEW."receivedQuantity"))) THEN
    RAISE EXCEPTION 'returns: the goods of RMA % arrived; what comes back is fixed (only the receipt, inspection and decision of a line change, or a line split after a partial receipt)', part_of
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."quantity" < 1 OR NEW."receivedQuantity" < 0 OR NEW."receivedQuantity" > NEW."quantity" THEN
    RAISE EXCEPTION 'returns: RMA line % takes back 1 piece or more, and receives 0 to that many', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."salesOrderLineId" IS NULL AND NEW."invoiceLineId" IS NULL) OR (NEW."size" IS NOT NULL AND NEW."salesOrderLineId" IS NULL) THEN
    RAISE EXCEPTION 'returns: RMA line % names what was sold: an order line (with its size) and/or an invoice line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."reasonCode") = '' OR btrim(NEW."description") = '' THEN
    RAISE EXCEPTION 'returns: RMA line % has a reason and a description', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."unitPrice" < 0 OR NEW."creditAmount" < 0 OR NEW."discountPct" <= 0 OR NEW."discountPct" >= 100 THEN
    RAISE EXCEPTION 'returns: RMA line % has a price and a credit of 0 or more and a discount above 0 and below 100 percent, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."receivedQuantity" > 0) <> (NEW."receivedAt" IS NOT NULL) OR (NEW."receiptId" IS NOT NULL AND NEW."receivedQuantity" = 0) THEN
    RAISE EXCEPTION 'returns: the received pieces of RMA line % have their time (and receipt), and only received pieces do', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."grade" IS NULL) <> (NEW."inspectedAt" IS NULL) OR (NEW."inspectedAt" IS NULL) <> (NEW."inspectedById" IS NULL)
     OR ((NEW."grade" IS NOT NULL OR NEW."cause" IS NOT NULL OR NEW."conditionNote" IS NOT NULL) AND NEW."receivedQuantity" = 0) THEN
    RAISE EXCEPTION 'returns: RMA line % is graded with the inspection''s time and inspector, and only once pieces arrived', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."disposition" IS NULL) <> (NEW."decidedAt" IS NULL) OR (NEW."decidedAt" IS NULL) <> (NEW."decidedById" IS NULL)
     OR (NEW."disposition" IS NOT NULL AND NEW."grade" IS NULL AND NOT NEW."creditWithoutReturn")
     OR (NEW."goodsOutcome" IS NOT NULL AND NEW."disposition" IS NULL)
     OR (NEW."replacementLineId" IS NOT NULL AND (NEW."disposition" IS NULL OR NEW."disposition" NOT IN ('REPLACE', 'SIZE_EXCHANGE'))) THEN
    RAISE EXCEPTION 'returns: RMA line % is decided with its time and who, after its inspection (an outcome only with a disposition, a replacement line only to REPLACE or SIZE_EXCHANGE)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- W2b-5 (SAL-342): credited without the goods coming back: no pieces arrive, no inspection, the decision CREDIT_ONLY.
  IF NEW."creditWithoutReturn"
     AND (NEW."receivedQuantity" > 0 OR NEW."grade" IS NOT NULL OR NEW."goodsOutcome" IS NOT NULL
          OR (NEW."disposition" IS NOT NULL AND NEW."disposition" <> 'CREDIT_ONLY')) THEN
    RAISE EXCEPTION 'returns: RMA line % is credited without the goods coming back: no pieces arrive, it is not inspected, and its decision is CREDIT_ONLY', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b-5 (SAL-351): a size exchange names the other size, and only a size exchange does.
  IF coalesce(NEW."disposition"::text = 'SIZE_EXCHANGE', false) <> (NEW."exchangeSize" IS NOT NULL)
     OR (NEW."exchangeSize" IS NOT NULL AND (btrim(NEW."exchangeSize") = '' OR char_length(NEW."exchangeSize") > 20 OR NEW."exchangeSize" IS NOT DISTINCT FROM NEW."size")) THEN
    RAISE EXCEPTION 'returns: RMA line % names the size it is exchanged for exactly when it is a SIZE_EXCHANGE, and another size than its own', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b-5 (SAL-343): a fee only with a decision, with the rule it came from, 0 or more; never when the cause found is ours.
  IF NEW."feeAmount" < 0
     OR ((NEW."feeRuleId" IS NOT NULL OR NEW."feeAmount" IS NOT NULL) AND NEW."disposition" IS NULL)
     OR (NEW."feeRuleId" IS NOT NULL AND NEW."feeAmount" IS NULL) THEN
    RAISE EXCEPTION 'returns: RMA line % has a fee of 0 or more only once it is decided, with the rule it came from', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."feeAmount" > 0 AND NEW."cause" = 'OUR_DEFECT' THEN
    RAISE EXCEPTION 'returns: RMA line % has a fee while the cause found is ours: the fee is dropped when the cause is ours', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."feeRuleId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."feeRuleId" IS DISTINCT FROM OLD."feeRuleId") THEN
    SELECT r."companyId" INTO rma_company FROM "ReturnAuthorisation" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."returnId";
    SELECT f."companyId", f."active" INTO rule_company, rule_active FROM "ReturnFeeRule" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."feeRuleId";
    IF FOUND AND (rule_company IS DISTINCT FROM rma_company OR NOT rule_active) THEN
      RAISE EXCEPTION 'returns: RMA line % names fee rule %, which is not an active rule of the RMA''s company', NEW."id", NEW."feeRuleId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- W2b-5 (SAL-336): the garment and lot of ours it is (never a sample made for no order: B-W2b-284's rule).
  IF (NEW."garmentSerial" IS NOT NULL OR NEW."garmentBatch" IS NOT NULL)
     AND (TG_OP = 'INSERT' OR (NEW."garmentSerial", NEW."garmentBatch") IS DISTINCT FROM (OLD."garmentSerial", OLD."garmentBatch")) THEN
    problem := "factory_service_garment_problem"(NEW."tenantId", NEW."garmentSerial", NEW."garmentBatch", true);
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'returns: RMA line %: %', NEW."id", problem
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- W2b-5 (SAL-350): a line split from another: a line of the same RMA (the reference), never itself, taking back what
  -- its line took back (what was sold, the reason, the price) after part of it arrived; it starts with nothing received and
  -- no decision.
  IF TG_OP = 'INSERT' AND NEW."parentLineId" IS NOT NULL THEN
    SELECT l."salesOrderLineId", l."size", l."invoiceLineId", l."reasonCode", l."unitPrice", l."discountPct", l."receivedQuantity", l."creditWithoutReturn"
      INTO parent FROM "ReturnLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."parentLineId";
    IF NEW."parentLineId" = NEW."id"
       OR (FOUND AND ((NEW."salesOrderLineId", NEW."size", NEW."invoiceLineId", NEW."reasonCode", NEW."unitPrice", NEW."discountPct")
                      IS DISTINCT FROM (parent."salesOrderLineId", parent."size", parent."invoiceLineId", parent."reasonCode", parent."unitPrice", parent."discountPct")
                      OR parent."receivedQuantity" < 1 OR parent."creditWithoutReturn"))
       OR NEW."receivedQuantity" <> 0 OR NEW."grade" IS NOT NULL OR NEW."disposition" IS NOT NULL OR NEW."creditWithoutReturn" THEN
      RAISE EXCEPTION 'returns: RMA line % is split from line %: the rest of a line of which part arrived, with its order and invoice line, size, reason and price, nothing received and no decision yet', NEW."id", NEW."parentLineId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR (NEW."quantity", NEW."salesOrderLineId", NEW."size", NEW."invoiceLineId") IS DISTINCT FROM (OLD."quantity", OLD."salesOrderLineId", OLD."size", OLD."invoiceLineId") THEN
    IF NEW."invoiceLineId" IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.return-invoiced', NEW."tenantId", NEW."invoiceLineId"), 0));
      SELECT i."quantity", i."salesOrderLineId", i."size" INTO sold, billed_line, billed_size
        FROM "InvoiceLine" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."invoiceLineId";
      IF FOUND THEN
        IF NEW."salesOrderLineId" IS NOT NULL
           AND (billed_line IS DISTINCT FROM NEW."salesOrderLineId" OR (billed_size IS NOT NULL AND billed_size IS DISTINCT FROM NEW."size")) THEN
          RAISE EXCEPTION 'returns: RMA line % names invoice line %, which does not bill that order line and size', NEW."id", NEW."invoiceLineId"
            USING ERRCODE = 'check_violation';
        END IF;
        SELECT coalesce(sum(CASE WHEN r."status" = 'CLOSED' THEN l."receivedQuantity" ELSE l."quantity" END), 0) INTO taken
          FROM "ReturnLine" l JOIN "ReturnAuthorisation" r ON r."tenantId" = l."tenantId" AND r."id" = l."returnId"
          WHERE l."tenantId" = NEW."tenantId" AND l."invoiceLineId" = NEW."invoiceLineId" AND l."id" <> NEW."id" AND r."status" NOT IN ('REJECTED', 'CANCELLED');
        IF taken + NEW."quantity" > sold THEN
          RAISE EXCEPTION 'returns: RMA line % takes back % pieces of invoice line %, which billed %, % of them already on other returns', NEW."id", NEW."quantity", NEW."invoiceLineId", sold, taken
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
    IF NEW."salesOrderLineId" IS NOT NULL THEN
      SELECT l."kind"::text INTO line_kind FROM "SalesOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."salesOrderLineId";
      IF FOUND THEN
        IF line_kind = 'SIZE_GRID' AND NEW."size" IS NULL THEN
          RAISE EXCEPTION 'returns: RMA line % names a size-grid order line without its size', NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.return-shipped', NEW."tenantId", NEW."salesOrderLineId", coalesce(NEW."size", '')), 0));
        SELECT coalesce(sum(sl."quantity"), 0) INTO sold
          FROM "ShipmentLine" sl JOIN "Shipment" s ON s."tenantId" = sl."tenantId" AND s."id" = sl."shipmentId"
          WHERE sl."tenantId" = NEW."tenantId" AND sl."salesOrderLineId" = NEW."salesOrderLineId"
            AND (NEW."size" IS NULL OR sl."size" = NEW."size") AND s."status" IN ('SHIPPED', 'DELIVERED');
        SELECT coalesce(sum(CASE WHEN r."status" = 'CLOSED' THEN l."receivedQuantity" ELSE l."quantity" END), 0) INTO taken
          FROM "ReturnLine" l JOIN "ReturnAuthorisation" r ON r."tenantId" = l."tenantId" AND r."id" = l."returnId"
          WHERE l."tenantId" = NEW."tenantId" AND l."salesOrderLineId" = NEW."salesOrderLineId" AND l."size" IS NOT DISTINCT FROM NEW."size"
            AND l."id" <> NEW."id" AND r."status" NOT IN ('REJECTED', 'CANCELLED');
        IF taken + NEW."quantity" > sold THEN
          RAISE EXCEPTION 'returns: RMA line % takes back % pieces of order line % (size %), of which % shipped, % of them already on other returns', NEW."id", NEW."quantity", NEW."salesOrderLineId", coalesce(NEW."size", '-'), sold, taken
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- A line cut down after a partial receipt (SAL-350) has its split lines at commit: together they take back at least the
-- pieces cut (a deferred constraint trigger, so the command cuts the line first and adds the split line after it: the sold
-- pieces are counted line by line).
CREATE FUNCTION "factory_return_line_split_kept"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rest bigint;
BEGIN
  SELECT coalesce(sum(l."quantity"), 0) INTO rest FROM "ReturnLine" l WHERE l."tenantId" = NEW."tenantId" AND l."parentLineId" = NEW."id";
  IF rest < OLD."quantity" - NEW."quantity" THEN
    RAISE EXCEPTION 'returns: RMA line % was cut from % to % pieces after a partial receipt, but the lines split from it take back only %: the rest goes on a new line split from it, in the same transaction', NEW."id", OLD."quantity", NEW."quantity", rest
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "ReturnLine_split_kept" AFTER UPDATE ON "ReturnLine"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."quantity" < OLD."quantity" AND NEW."receivedQuantity" >= 1)
  EXECUTE FUNCTION "factory_return_line_split_kept"();

-- =====================================================================================================================
-- RepairOrder: the W2b-5 columns (SAL-384, SAL-391, SAL-393). W2a's factory_repair_order_guard stays as it is (a SHIPPED or
-- CANCELLED repair never changes, these columns too).
CREATE FUNCTION "factory_repair_order_w2b_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF NEW."channel" IS DISTINCT FROM OLD."channel" THEN
      RAISE EXCEPTION 'returns: how the request of repair order % reached us never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."workWanted", 2000, true) THEN
    RAISE EXCEPTION 'returns: the work wanted on repair order % is 1 to 2000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "RepairOrder_w2b_guard" AFTER INSERT OR UPDATE ON "RepairOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_repair_order_w2b_guard"();

-- =====================================================================================================================
-- RepairEstimate (SAL-387)
CREATE FUNCTION "factory_repair_estimate_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'internalNote', 'version', 'updatedAt'];
  repair_company uuid;
  repair_party uuid;
  repair_stage text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."sentAt" IS NOT NULL OR NEW."answeredAt" IS NOT NULL OR NEW."withdrawnAt" IS NOT NULL THEN
      RAISE EXCEPTION 'returns: repair estimate % starts as a DRAFT, not sent, answered or withdrawn', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT o."companyId", o."partyId", o."stage"::text INTO repair_company, repair_party, repair_stage
      FROM "RepairOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."repairId" FOR SHARE;
    IF FOUND AND (repair_company IS DISTINCT FROM NEW."companyId" OR repair_party IS DISTINCT FROM NEW."partyId") THEN
      RAISE EXCEPTION 'returns: repair estimate % is of its repair''s company and customer', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF FOUND AND repair_stage IN ('SHIPPED', 'CANCELLED') THEN
      RAISE EXCEPTION 'returns: repair order % is %: it takes no new estimate', NEW."repairId", repair_stage
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."siteId", NEW."partyId", NEW."repairId", NEW."revision", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."siteId", OLD."partyId", OLD."repairId", OLD."revision", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'returns: the repair, company, customer, revision and creation of repair estimate % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('ACCEPTED', 'DECLINED', 'WITHDRAWN') AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'returns: repair estimate % is %; it never changes (a changed estimate is a new revision)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('SENT', 'WITHDRAWN'))
                OR (OLD."status" = 'SENT' AND NEW."status" IN ('ACCEPTED', 'DECLINED', 'WITHDRAWN'))) THEN
      RAISE EXCEPTION 'returns: repair estimate % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT'
       AND ((NEW."currency", NEW."validUntil", NEW."customerNote", NEW."sentAt", NEW."sentById")
            IS DISTINCT FROM (OLD."currency", OLD."validUntil", OLD."customerNote", OLD."sentAt", OLD."sentById")) THEN
      RAISE EXCEPTION 'returns: repair estimate % was sent: what the customer saw never changes (a changed estimate is a new revision)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'SENT' AND OLD."status" = 'DRAFT'
       AND NOT EXISTS (SELECT 1 FROM "RepairEstimateLine" l WHERE l."tenantId" = NEW."tenantId" AND l."estimateId" = NEW."id") THEN
      RAISE EXCEPTION 'returns: repair estimate % is sent with one line or more', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."revision" < 1 OR NEW."currency" !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'returns: repair estimate % has a revision from 1 and an ISO 4217 currency', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."customerNote", 2000, true) OR NOT "factory_recall_words_ok"(NEW."internalNote", 4000, true) THEN
    RAISE EXCEPTION 'returns: the words of repair estimate % are 1 to 2000 characters to the customer, 1 to 4000 for the office', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."sentAt" IS NULL) <> (NEW."sentById" IS NULL)
     OR (NEW."status" IN ('SENT', 'ACCEPTED', 'DECLINED') AND NEW."sentAt" IS NULL)
     OR (NEW."status" = 'DRAFT' AND NEW."sentAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'returns: repair estimate % is % with the wrong sending: sent with when and by whom, from SENT on', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('ACCEPTED', 'DECLINED')) <> (NEW."answeredAt" IS NOT NULL)
     OR (NEW."answeredAt" IS NULL) <> (NEW."answeredVia" IS NULL)
     OR coalesce(NEW."answeredVia"::text = 'OFFICE', false) <> (NEW."recordedById" IS NOT NULL)
     OR (NEW."answeredByName" IS NOT NULL AND (NEW."answeredAt" IS NULL OR NOT "factory_recall_words_ok"(NEW."answeredByName", 200, false)))
     OR (NEW."declineReason" IS NOT NULL AND (NEW."status" <> 'DECLINED' OR NOT "factory_recall_words_ok"(NEW."declineReason", 2000, true))) THEN
    RAISE EXCEPTION 'returns: repair estimate % has the customer''s answer exactly when ACCEPTED or DECLINED: when and how (an OFFICE answer with who recorded it), the name they gave (1 to 200), why they declined (1 to 2000)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'WITHDRAWN') <> (NEW."withdrawnAt" IS NOT NULL) OR (NEW."withdrawnById" IS NOT NULL AND NEW."withdrawnAt" IS NULL) THEN
    RAISE EXCEPTION 'returns: repair estimate % has its withdrawal time exactly when it is WITHDRAWN', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ("factory_recall_not_future"(NEW."sentAt") AND "factory_recall_not_future"(NEW."answeredAt") AND "factory_recall_not_future"(NEW."withdrawnAt"))
     OR NEW."answeredAt" < NEW."sentAt" THEN
    RAISE EXCEPTION 'returns: repair estimate % is sent, answered and withdrawn at times not in the future, the answer not before the sending', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'ACCEPTED' AND NEW."validUntil" IS NOT NULL AND "factory_money_rome_day"(NEW."answeredAt") > NEW."validUntil" THEN
    RAISE EXCEPTION 'returns: repair estimate % stood until %: it is accepted by then (send a new revision)', NEW."id", NEW."validUntil"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "RepairEstimate_guard" AFTER INSERT OR UPDATE ON "RepairEstimate"
  FOR EACH ROW EXECUTE FUNCTION "factory_repair_estimate_guard"();

-- =====================================================================================================================
-- RepairEstimateLine (SAL-387)
CREATE FUNCTION "factory_repair_estimate_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  estimate_status text;
  row_estimate uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."estimateId", NEW."partyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."estimateId", OLD."partyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'returns: estimate line % never moves to another estimate; its creation never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    row_estimate := OLD."estimateId";
    SELECT e."status"::text INTO estimate_status FROM "RepairEstimate" e WHERE e."tenantId" = OLD."tenantId" AND e."id" = row_estimate FOR SHARE;
  ELSE
    row_estimate := NEW."estimateId";
    SELECT e."status"::text INTO estimate_status FROM "RepairEstimate" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = row_estimate FOR SHARE;
  END IF;
  IF FOUND AND estimate_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'returns: repair estimate % is %: its lines change only while it is a DRAFT', row_estimate, estimate_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;
  IF NEW."description" IS NULL OR NOT "factory_recall_words_ok"(NEW."description", 500, false) OR NEW."quantity" <= 0 THEN
    RAISE EXCEPTION 'returns: estimate line % has a description of one line (1 to 500 characters) and a quantity above 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'LABOUR') <> (NEW."minutes" IS NOT NULL) OR NEW."minutes" NOT BETWEEN 1 AND 100000
     OR (NEW."itemId" IS NOT NULL AND NEW."kind" <> 'PART') THEN
    RAISE EXCEPTION 'returns: estimate line % is labour with its minutes (1 to 100000), or a part (with its item when it is ours)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."unitPrice" < 0 OR NEW."amount" < 0 OR (NEW."unitCost" IS NULL) <> (NEW."costAmount" IS NULL) OR NEW."unitCost" < 0 OR NEW."costAmount" < 0 THEN
    RAISE EXCEPTION 'returns: estimate line % has a price and a total of 0 or more, and its cost per unit and in all both or neither, 0 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "RepairEstimateLine_guard" AFTER INSERT OR UPDATE OR DELETE ON "RepairEstimateLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_repair_estimate_line_guard"();

-- =====================================================================================================================
-- ServiceCase (SAL-368, SAL-436)
CREATE TRIGGER "ServiceCase_number" BEFORE INSERT OR UPDATE ON "ServiceCase"
  FOR EACH ROW EXECUTE FUNCTION "factory_document_number_guard"('service case', 'SERVICE_CASE');

CREATE FUNCTION "factory_service_case_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'internalNote', 'version', 'updatedAt'];
  problem text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('NEW', 'OPEN') THEN
      RAISE EXCEPTION 'service: case % starts NEW or OPEN, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."number", NEW."channel", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."number", OLD."channel", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'service: the company, number, channel and creation of case % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CLOSED' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'service: case % is CLOSED; it never changes (open a new case)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'NEW' AND NEW."status" IN ('OPEN', 'CLOSED'))
                OR (OLD."status" = 'OPEN' AND NEW."status" IN ('WAITING_CUSTOMER', 'WAITING_PART', 'RESOLVED', 'CLOSED'))
                OR (OLD."status" IN ('WAITING_CUSTOMER', 'WAITING_PART') AND NEW."status" IN ('OPEN', 'WAITING_CUSTOMER', 'WAITING_PART', 'RESOLVED', 'CLOSED'))
                OR (OLD."status" = 'RESOLVED' AND NEW."status" IN ('OPEN', 'CLOSED'))) THEN
      RAISE EXCEPTION 'service: case % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."problem" IS NULL OR NOT "factory_recall_words_ok"(NEW."problem", 4000, true) THEN
    RAISE EXCEPTION 'service: case % says what the customer reports in 1 to 4000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ("factory_service_label_ok"(NEW."serial") AND "factory_service_label_ok"(NEW."batchNumber") AND "factory_recall_words_ok"(NEW."size", 20, false)) THEN
    RAISE EXCEPTION 'service: case % names a serial and a batch of one line (1 to 100 characters) and a size of 1 to 20', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."colourwayId" IS NOT NULL AND NEW."styleId" IS NULL) OR (NEW."contactId" IS NOT NULL AND NEW."partyId" IS NULL) THEN
    RAISE EXCEPTION 'service: case % names a colourway with its style and a contact with their customer', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."garmentSerial" IS NOT NULL AND NEW."garmentBatch" IS NOT NULL)
     AND (TG_OP = 'INSERT' OR (NEW."garmentSerial", NEW."garmentBatch") IS DISTINCT FROM (OLD."garmentSerial", OLD."garmentBatch")) THEN
    problem := "factory_service_garment_problem"(NEW."tenantId", NEW."garmentSerial", NEW."garmentBatch", false);
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'service: case %: %', NEW."id", problem
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."legalGuaranteeEndsOn" < NEW."deliveredOn" OR NEW."factoryGuaranteeEndsOn" < NEW."deliveredOn" THEN
    RAISE EXCEPTION 'service: the guarantees of case % end on or after the day the garment was delivered', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- The cover (SAL-368): decided with its cover, its words, when and by whom, all or none.
  IF (NEW."coverDecision" IS NULL) <> (NEW."cover" IS NULL) OR (NEW."coverDecision" IS NULL) <> (NEW."coverNote" IS NULL)
     OR (NEW."coverDecision" IS NULL) <> (NEW."coverDecidedAt" IS NULL) OR (NEW."coverDecision" IS NULL) <> (NEW."coverDecidedById" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."coverNote", 2000, true) OR NOT "factory_recall_not_future"(NEW."coverDecidedAt") THEN
    RAISE EXCEPTION 'service: the cover of case % is decided with the guarantee it falls under, why in words (1 to 2000), when and by whom, or not at all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."coverDecision" IN ('COVERED', 'PARTLY') AND NEW."cover" NOT IN ('LEGAL_GUARANTEE', 'FACTORY_GUARANTEE'))
     OR (NEW."coverDecision" = 'NOT_COVERED' AND NEW."cover" <> 'NONE')
     OR (NEW."cover" = 'LEGAL_GUARANTEE' AND NEW."legalGuaranteeEndsOn" IS NULL)
     OR (NEW."cover" = 'FACTORY_GUARANTEE' AND NEW."factoryGuaranteeEndsOn" IS NULL) THEN
    RAISE EXCEPTION 'service: case % is covered under the legal or the factory''s guarantee, with its last day, or not covered (NONE)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- Resolved and closed.
  IF (NEW."resolvedAt" IS NULL) <> (NEW."resolution" IS NULL)
     OR (NEW."status" = 'RESOLVED' AND NEW."resolvedAt" IS NULL)
     OR (NEW."status" IN ('NEW', 'OPEN', 'WAITING_CUSTOMER', 'WAITING_PART') AND NEW."resolvedAt" IS NOT NULL)
     OR NOT "factory_recall_words_ok"(NEW."resolution", 4000, true) THEN
    RAISE EXCEPTION 'service: case % is resolved with when and what was done (1 to 4000 characters) while RESOLVED, and kept when it closes from there', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL) OR (NEW."closedById" IS NOT NULL AND NEW."closedAt" IS NULL)
     OR (NEW."status" = 'CLOSED' AND NEW."resolvedAt" IS NULL AND NEW."closeReason" IS NULL)
     OR (NEW."closeReason" IS NOT NULL AND (NEW."closedAt" IS NULL OR NOT "factory_recall_words_ok"(NEW."closeReason", 2000, true))) THEN
    RAISE EXCEPTION 'service: case % has its closing time exactly when CLOSED, and closed without a resolution the reason in words (1 to 2000)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ("factory_recall_not_future"(NEW."resolvedAt") AND "factory_recall_not_future"(NEW."closedAt")) OR NEW."closedAt" < NEW."resolvedAt" THEN
    RAISE EXCEPTION 'service: case % is resolved and closed at times not in the future, closed not before it was resolved', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."internalNote", 4000, true) THEN
    RAISE EXCEPTION 'service: the internal note of case % is 1 to 4000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "ServiceCase_guard" AFTER INSERT OR UPDATE ON "ServiceCase"
  FOR EACH ROW EXECUTE FUNCTION "factory_service_case_guard"();

-- =====================================================================================================================
-- ServiceCaseLink (SAL-368): added and removed while its case is open, never changed.
CREATE FUNCTION "factory_service_case_link_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  case_status text;
  row_case uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'service: case link % is never changed (remove it and link again)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    row_case := OLD."caseId";
    SELECT c."status"::text INTO case_status FROM "ServiceCase" c WHERE c."tenantId" = OLD."tenantId" AND c."id" = row_case FOR SHARE;
  ELSE
    row_case := NEW."caseId";
    SELECT c."status"::text INTO case_status FROM "ServiceCase" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = row_case FOR SHARE;
  END IF;
  IF FOUND AND case_status = 'CLOSED' THEN
    RAISE EXCEPTION 'service: case % is CLOSED: its links never change', row_case
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;
  IF NOT "factory_recall_model_name_ok"(NEW."recordType") OR NOT "factory_recall_words_ok"(NEW."note", 500, false) THEN
    RAISE EXCEPTION 'service: case link % names a record by its model name and id, with a note of one line (1 to 500 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "ServiceCaseLink_guard" AFTER INSERT OR UPDATE OR DELETE ON "ServiceCaseLink"
  FOR EACH ROW EXECUTE FUNCTION "factory_service_case_link_guard"();

-- =====================================================================================================================
-- ProductSafetyReport (SAL-414)
CREATE TRIGGER "ProductSafetyReport_number" BEFORE INSERT OR UPDATE ON "ProductSafetyReport"
  FOR EACH ROW EXECUTE FUNCTION "factory_document_number_guard"('safety report', 'SAFETY_REPORT');

CREATE FUNCTION "factory_product_safety_report_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'version', 'updatedAt', 'reporterName', 'reporterEmail', 'reporterPhone'];
  problem text;
  case_kind text;
  entry_style uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'NEW' OR NEW."seenAt" IS NOT NULL OR NEW."closedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'service: safety report % starts NEW, not seen or closed', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."number", NEW."source", NEW."receivedAt", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."number", OLD."source", OLD."receivedAt", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'service: the company, number, source, receive time and creation of safety report % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CLOSED'
       AND ((to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept)
            OR (NEW."reporterName" IS NOT NULL AND NEW."reporterName" IS DISTINCT FROM OLD."reporterName")
            OR (NEW."reporterEmail" IS NOT NULL AND NEW."reporterEmail" IS DISTINCT FROM OLD."reporterEmail")
            OR (NEW."reporterPhone" IS NOT NULL AND NEW."reporterPhone" IS DISTINCT FROM OLD."reporterPhone")) THEN
      RAISE EXCEPTION 'service: safety report % is CLOSED; it never changes but for the reporter''s data erased on request', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'NEW' AND NEW."status" IN ('ASSESSING', 'CLOSED')) OR (OLD."status" = 'ASSESSING' AND NEW."status" = 'CLOSED')) THEN
      RAISE EXCEPTION 'service: safety report % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."seenAt" IS NOT NULL AND (NEW."seenAt", NEW."seenById") IS DISTINCT FROM (OLD."seenAt", OLD."seenById"))
       OR (OLD."serviceCaseId" IS NOT NULL AND NEW."serviceCaseId" IS DISTINCT FROM OLD."serviceCaseId")
       OR (OLD."registerEntryId" IS NOT NULL AND NEW."registerEntryId" IS DISTINCT FROM OLD."registerEntryId") THEN
      RAISE EXCEPTION 'service: who saw safety report % first, its service case and its register entry are set once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."whatHappened" IS NULL OR NOT "factory_recall_words_ok"(NEW."whatHappened", 4000, true) THEN
    RAISE EXCEPTION 'service: safety report % says what happened in 1 to 4000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."source" = 'PORTAL' AND NEW."partyId" IS NULL) OR (NEW."contactId" IS NOT NULL AND NEW."partyId" IS NULL)
     OR (NEW."colourwayId" IS NOT NULL AND NEW."styleId" IS NULL) THEN
    RAISE EXCEPTION 'service: safety report % names its customer when it came through the portal, a contact with their customer and a colourway with its style', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."reporterName", 200, false)
     OR (NEW."reporterEmail" IS NOT NULL AND (char_length(NEW."reporterEmail") > 254 OR NEW."reporterEmail" !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'))
     OR (NEW."reporterPhone" IS NOT NULL AND NEW."reporterPhone" !~ '^\+?[0-9][0-9 ()./-]{4,39}$') THEN
    RAISE EXCEPTION 'service: safety report % names its reporter (1 to 200 characters), an e-mail address and a phone number in their shapes', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ("factory_service_label_ok"(NEW."serial") AND "factory_service_label_ok"(NEW."batchNumber") AND "factory_recall_words_ok"(NEW."size", 20, false)) THEN
    RAISE EXCEPTION 'service: safety report % names a serial and a batch of one line (1 to 100 characters) and a size of 1 to 20', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."garmentSerial" IS NOT NULL AND NEW."garmentBatch" IS NOT NULL)
     AND (TG_OP = 'INSERT' OR (NEW."garmentSerial", NEW."garmentBatch") IS DISTINCT FROM (OLD."garmentSerial", OLD."garmentBatch")) THEN
    problem := "factory_service_garment_problem"(NEW."tenantId", NEW."garmentSerial", NEW."garmentBatch", false);
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'service: safety report %: %', NEW."id", problem
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_recall_not_future"(NEW."receivedAt") OR NEW."occurredOn" > "factory_money_rome_day"(NEW."receivedAt") THEN
    RAISE EXCEPTION 'service: safety report % reached us at a time not in the future, and what it tells happened by then', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."seenAt" IS NULL) <> (NEW."seenById" IS NULL) OR NOT "factory_recall_not_future"(NEW."seenAt")
     OR (NEW."status" = 'ASSESSING' AND NEW."seenAt" IS NULL) THEN
    RAISE EXCEPTION 'service: safety report % is seen with when and by whom (not in the future), before quality assesses it', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL) OR (NEW."status" = 'CLOSED') <> (NEW."closedById" IS NOT NULL)
     OR (NEW."status" = 'CLOSED') <> (NEW."closeNote" IS NOT NULL)
     OR NOT "factory_recall_words_ok"(NEW."closeNote", 2000, true) OR NOT "factory_recall_not_future"(NEW."closedAt") THEN
    RAISE EXCEPTION 'service: safety report % is closed exactly with when, by whom and the words (1 to 2000 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."serviceCaseId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."serviceCaseId" IS DISTINCT FROM OLD."serviceCaseId") THEN
    SELECT c."kind"::text INTO case_kind FROM "ServiceCase" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."serviceCaseId";
    IF FOUND AND case_kind <> 'SAFETY' THEN
      RAISE EXCEPTION 'service: safety report % opens a SAFETY service case, not a % one', NEW."id", case_kind
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."registerEntryId" IS NOT NULL AND NEW."styleId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR (NEW."registerEntryId", NEW."styleId") IS DISTINCT FROM (OLD."registerEntryId", OLD."styleId")) THEN
    SELECT r."styleId" INTO entry_style FROM "PpeRegisterEntry" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."registerEntryId";
    IF FOUND AND entry_style IS DISTINCT FROM NEW."styleId" THEN
      RAISE EXCEPTION 'service: safety report % is filed in a register entry of its own style', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "ProductSafetyReport_guard" AFTER INSERT OR UPDATE ON "ProductSafetyReport"
  FOR EACH ROW EXECUTE FUNCTION "factory_product_safety_report_guard"();

-- =====================================================================================================================
-- ProductSafetyInjury (SAL-415; GDPR art. 9): one per report, the words only with the consent, erased once.
CREATE FUNCTION "factory_product_safety_injury_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."erasedAt" IS NOT NULL OR NEW."erasedById" IS NOT NULL THEN
      RAISE EXCEPTION 'service: injury % starts not erased', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."reportId", NEW."key", NEW."injured", NEW."consentAt", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."reportId", OLD."key", OLD."injured", OLD."consentAt", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'service: the report, whether someone was hurt, the consent and the creation of injury % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."injuryWords" IS DISTINCT FROM OLD."injuryWords" AND (NEW."injuryWords" IS NOT NULL OR NEW."erasedAt" IS NULL) THEN
      RAISE EXCEPTION 'service: the words of injury % never change; they are only erased (with when)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."erasedAt" IS NOT NULL AND (NEW."erasedAt", NEW."erasedById") IS DISTINCT FROM (OLD."erasedAt", OLD."erasedById") THEN
      RAISE EXCEPTION 'service: injury % was erased once; it stays erased', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF position(('injury:' || NEW."reportId"::text) IN NEW."key") <> 1 THEN
    RAISE EXCEPTION 'service: injury % has the key injury:<its report> (one per report)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."injuryWords" IS NOT NULL AND (NOT NEW."injured" OR NEW."consentAt" IS NULL OR NOT "factory_recall_words_ok"(NEW."injuryWords", 2000, true)) THEN
    RAISE EXCEPTION 'service: injury % keeps words (1 to 2000 characters) only when someone was hurt and with the explicit consent (GDPR art. 9)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."erasedAt" IS NOT NULL AND NEW."injuryWords" IS NOT NULL) OR (NEW."erasedById" IS NOT NULL AND NEW."erasedAt" IS NULL)
     OR NOT ("factory_recall_not_future"(NEW."erasedAt") AND "factory_recall_not_future"(NEW."consentAt")) THEN
    RAISE EXCEPTION 'service: injury % is erased with its words blanked, at a time not in the future; the consent is not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "ProductSafetyInjury_guard" AFTER INSERT OR UPDATE ON "ProductSafetyInjury"
  FOR EACH ROW EXECUTE FUNCTION "factory_product_safety_injury_guard"();

-- An injury is never indexed for search (the search entries are read by every office role with the view permission).
CREATE FUNCTION "factory_search_entry_not_injury"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."recordType" = 'ProductSafetyInjury' THEN
    RAISE EXCEPTION 'search: an injury of a safety report is special-category data and is never indexed (record %)', NEW."recordId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "SearchEntry_not_injury" BEFORE INSERT OR UPDATE ON "SearchEntry"
  FOR EACH ROW EXECUTE FUNCTION "factory_search_entry_not_injury"();

-- =====================================================================================================================
-- AccidentLogEntry (SAL-423; GPSR art. 20): append-only, revisions per report.
CREATE TRIGGER "AccidentLogEntry_append_only" BEFORE UPDATE OR DELETE ON "AccidentLogEntry"
  FOR EACH ROW EXECUTE FUNCTION "factory_service_append_only"();
CREATE TRIGGER "AccidentLogEntry_no_truncate" BEFORE TRUNCATE ON "AccidentLogEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_service_append_only"();

CREATE FUNCTION "factory_accident_log_entry_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest integer;
  report_received timestamptz;
  notice_company uuid;
  notice_status text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.accident-log', NEW."tenantId", NEW."reportId"), 0));
  SELECT max(e."revision") INTO latest FROM "AccidentLogEntry" e
   WHERE e."tenantId" = NEW."tenantId" AND e."reportId" = NEW."reportId" AND e."id" <> NEW."id";
  IF NEW."revision" < 1 OR NEW."revision" <= coalesce(latest, 0) THEN
    RAISE EXCEPTION 'service: accident log entry % of report % is revision %, above every earlier one (%)', NEW."id", NEW."reportId", NEW."revision", coalesce(latest, 0)
      USING ERRCODE = 'check_violation';
  END IF;
  IF latest IS NOT NULL AND NEW."note" IS NULL THEN
    RAISE EXCEPTION 'service: accident log entry % corrects or completes an earlier one of its report: say why', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."note", 2000, true) OR NEW."place" IS NULL OR NOT "factory_recall_words_ok"(NEW."place", 300, false)
     OR NOT ("factory_service_label_ok"(NEW."serial") AND "factory_service_label_ok"(NEW."batchNumber")) THEN
    RAISE EXCEPTION 'service: accident log entry % has its place (one line, 1 to 300 characters), a serial and a batch of one line (1 to 100) and its reason (1 to 2000)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT r."receivedAt" INTO report_received FROM "ProductSafetyReport" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."reportId";
  IF NEW."occurredOn" > "factory_money_rome_day"(now()) OR (FOUND AND NEW."occurredOn" > "factory_money_rome_day"(report_received)) THEN
    RAISE EXCEPTION 'service: the accident of log entry % happened on a day not in the future and not after its report', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."authorityToldAt" IS NULL) <> (NEW."authorityToldById" IS NULL)
     OR ((NEW."authorityReference" IS NOT NULL OR NEW."authorityNoticeId" IS NOT NULL) AND NEW."authorityToldAt" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."authorityReference", 200, false)
     OR NOT "factory_recall_not_future"(NEW."authorityToldAt")
     OR "factory_money_rome_day"(NEW."authorityToldAt") < NEW."occurredOn" THEN
    RAISE EXCEPTION 'service: accident log entry % tells the authority with when and by whom (not in the future, not before the accident), and only then its reference (1 to 200) and notice', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."authorityNoticeId" IS NOT NULL THEN
    SELECT n."companyId", n."status"::text INTO notice_company, notice_status FROM "AuthorityNotice" n WHERE n."tenantId" = NEW."tenantId" AND n."id" = NEW."authorityNoticeId";
    IF NOT FOUND OR notice_company IS DISTINCT FROM NEW."companyId" OR notice_status <> 'SENT' THEN
      RAISE EXCEPTION 'service: accident log entry % names authority notice %, which is not a SENT notice of its company', NEW."id", NEW."authorityNoticeId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "AccidentLogEntry_check" AFTER INSERT ON "AccidentLogEntry"
  FOR EACH ROW EXECUTE FUNCTION "factory_accident_log_entry_check"();

-- =====================================================================================================================
-- PpeRegisterEntry (redefines …_recall_claims_w2b_guards' "factory_ppe_register_entry_guard"; the trigger stays): its rules
-- word for word, with one more source type, ProductSafetyReport (an entry opened from a product-safety report, SAL-414).

CREATE OR REPLACE FUNCTION "factory_ppe_register_entry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  wanted integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: PPE register entry % is kept (closed), never deleted (Reg. 2016/425 art. 8(4))', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'quality: PPE register entry % starts OPEN, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."reference", NEW."kind", NEW."reportedAt", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."reference", OLD."kind", OLD."reportedAt", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the company, reference, kind, report time and creation of PPE register entry % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CLOSED' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'quality: PPE register entry % is CLOSED; it never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."reference") = '' OR btrim(NEW."description") = '' THEN
    RAISE EXCEPTION 'quality: PPE register entry % has a reference and a description', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL) OR (NEW."status" = 'CLOSED') <> (NEW."closedById" IS NOT NULL)
     OR (NEW."status" = 'CLOSED') <> (NEW."closeReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'quality: PPE register entry % is % with the wrong closing: a closed entry has its time, who closed it and why', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The source, the authority's reference, the corrective action done.
  IF (NEW."sourceType" IS NULL) <> (NEW."sourceId" IS NULL)
     OR (NEW."sourceType" IS NOT NULL AND NEW."sourceType" NOT IN ('QualityReleaseReversal', 'QualityRelease', 'Inspection', 'Shipment', 'LabResult', 'Complaint', 'Nonconformance', 'ReturnAuthorisation', 'AuthorityRequest', 'ProductSafetyReport')) THEN
    RAISE EXCEPTION 'quality: PPE register entry % names its source as a known record type and an id, or not at all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."authorityReference" IS NOT NULL AND NEW."authorityNotifiedAt" IS NULL THEN
    RAISE EXCEPTION 'quality: PPE register entry % has an authority reference without the date the authority was told', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."actionCompletedAt" IS NOT NULL AND btrim(coalesce(NEW."actionTaken", '')) = '' THEN
    RAISE EXCEPTION 'quality: PPE register entry % marks a corrective action done without the action', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The id lists: rows of the entry's tenant and company (work orders also of its style).
  wanted := cardinality(ARRAY(SELECT DISTINCT unnest(coalesce(NEW."lotIds", '{}'::uuid[]))));
  IF wanted > 0 AND (SELECT count(*) FROM "Lot" l WHERE l."tenantId" = NEW."tenantId" AND l."companyId" = NEW."companyId" AND l."id" = ANY(NEW."lotIds")) <> wanted THEN
    RAISE EXCEPTION 'quality: PPE register entry % names a material lot that is not of its company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  wanted := cardinality(ARRAY(SELECT DISTINCT unnest(coalesce(NEW."workOrderIds", '{}'::uuid[]))));
  IF wanted > 0 AND (SELECT count(*) FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."companyId" = NEW."companyId" AND w."styleId" = NEW."styleId" AND w."id" = ANY(NEW."workOrderIds")) <> wanted THEN
    RAISE EXCEPTION 'quality: PPE register entry % names a work order that is not of its company and style', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  wanted := cardinality(ARRAY(SELECT DISTINCT unnest(coalesce(NEW."shipmentIds", '{}'::uuid[]))));
  IF wanted > 0 AND (SELECT count(*) FROM "Shipment" s WHERE s."tenantId" = NEW."tenantId" AND s."companyId" = NEW."companyId" AND s."id" = ANY(NEW."shipmentIds")) <> wanted THEN
    RAISE EXCEPTION 'quality: PPE register entry % names a shipment that is not of its company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- OPEN → CLOSED: its duties met.
  IF TG_OP = 'UPDATE' AND OLD."status" = 'OPEN' AND NEW."status" = 'CLOSED' THEN
    IF btrim(NEW."closeReason") = '' THEN
      RAISE EXCEPTION 'quality: PPE register entry % closes with a reason', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."risk" = 'ASSESSING' THEN
      RAISE EXCEPTION 'quality: PPE register entry % closes once its risk is decided (yes or no)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF btrim(coalesce(NEW."actionTaken", '')) = '' OR NEW."actionCompletedAt" IS NULL THEN
      RAISE EXCEPTION 'quality: PPE register entry % closes once its corrective action is written and done (Reg. 2016/425 art. 8(8))', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."risk" = 'YES' AND (NEW."authorityNotifiedAt" IS NULL OR btrim(coalesce(NEW."authorityReference", '')) = '') THEN
      RAISE EXCEPTION 'quality: PPE register entry % may present a risk: it closes once the authorities were told, with the date and their reference (Reg. 2016/425 art. 8(8))', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."distributorsInformedAt" IS NULL AND EXISTS (
      SELECT 1
      FROM "ShipmentLine" sl
      JOIN "Shipment" s ON s."tenantId" = sl."tenantId" AND s."id" = sl."shipmentId"
      JOIN "WorkOrder" w ON w."tenantId" = sl."tenantId" AND w."id" = sl."workOrderId"
      WHERE sl."tenantId" = NEW."tenantId"
        AND s."companyId" = NEW."companyId"
        AND s."status" IN ('SHIPPED', 'DELIVERED')
        AND w."companyId" = NEW."companyId"
        AND w."styleId" = NEW."styleId"
        AND (
          w."id" = ANY(coalesce(NEW."workOrderIds", '{}'::uuid[]))
          OR w."batchNumber" = ANY(coalesce(NEW."batchNumbers", '{}'::text[]))
          OR s."id" = ANY(coalesce(NEW."shipmentIds", '{}'::uuid[]))
          OR EXISTS (
            SELECT 1 FROM "StockMove" m
            WHERE m."tenantId" = NEW."tenantId" AND m."companyId" = NEW."companyId" AND m."workOrderId" = w."id"
              AND m."lotId" = ANY(coalesce(NEW."lotIds", '{}'::uuid[])) AND m."reason" = 'ISSUE' AND m."reversalOfId" IS NULL
              AND NOT EXISTS (SELECT 1 FROM "StockMove" r WHERE r."tenantId" = m."tenantId" AND r."siteId" = m."siteId" AND r."reversalOfId" = m."id")
          )
          OR EXISTS (
            SELECT 1 FROM "GarmentSerial" g
            WHERE g."tenantId" = sl."tenantId" AND g."shipmentLineId" = sl."id" AND g."serial" = ANY(coalesce(NEW."serials", '{}'::text[]))
          )
        )
    ) THEN
      RAISE EXCEPTION 'quality: garments PPE register entry % concerns left for customers: it closes once the distributors were informed (Reg. 2016/425 art. 8(4))', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
