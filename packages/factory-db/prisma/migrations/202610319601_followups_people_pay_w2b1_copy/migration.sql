-- Written by hand (B-W2b-89; data only, no schema change), after the policy migration of the latest schema step and before a
-- regenerated policy migration (check-policy-parity wants a policy migration last). When the migrations are renumbered, keep
-- this file as it is under its new timestamp.

-- The W2b-1 follow-ups for people and pay, their readers (B-W2b-89): B-W2b-75 (…_followups_people_pay_w2b1_schema) added the
-- columns and filled no row; until now B-W2b-54 kept three facts in JSON. This file moves them once, and every reader reads
-- the columns from here on:
--
--   PayrollExport.checks, the CARRIED row     → PayrollExport.correctionsCarried; the row leaves `checks`
--   PayrollExportLayout.definition.confirmation → confirmedOn, confirmedByName (a typed name of someone outside Nexus, so
--                                                 never confirmedById); the key leaves `definition`
--   PayrollExportLayout.definition.companyCode  → Company.payrollCode, where the company has none; the key leaves `definition`
--
-- An export's `layoutSnapshot` is the layout AS USED and keeps both keys inside its `definition`, as before: nothing to move.
-- Re-running this file changes nothing (each step finds no row left to move). The file is one script, so one transaction:
-- a failure leaves every row, and the export guard, as they were.

-- 1. What an export carried. An EXPORTED export never changes for any login (PayrollExport_guard), so the guard is off for
--    this one statement: it moves the same ids, and nothing else of the row changes (status, number, values, version).
ALTER TABLE "PayrollExport" DISABLE TRIGGER "PayrollExport_guard";
UPDATE "PayrollExport" e
   SET "correctionsCarried" = ARRAY(
         SELECT DISTINCT x.id::uuid FROM jsonb_array_elements(e."checks") AS t(c), jsonb_array_elements_text(CASE WHEN jsonb_typeof(c -> 'corrections') = 'array' THEN c -> 'corrections' ELSE '[]'::jsonb END) AS x(id)
          WHERE c ->> 'code' = 'CARRIED' ORDER BY 1),
       "checks" = COALESCE((SELECT jsonb_agg(c ORDER BY n) FROM jsonb_array_elements(e."checks") WITH ORDINALITY AS t(c, n) WHERE c ->> 'code' IS DISTINCT FROM 'CARRIED'), '[]'::jsonb)
 WHERE jsonb_typeof(e."checks") = 'array' AND e."checks" @> '[{"code":"CARRIED"}]';
ALTER TABLE "PayrollExport" ENABLE TRIGGER "PayrollExport_guard";

-- 2. The consultant's confirmation of a layout: the day and the name typed (the layout's guard asks them together).
UPDATE "PayrollExportLayout"
   SET "confirmedOn" = ("definition" #>> '{confirmation,on}')::date,
       "confirmedByName" = btrim("definition" #>> '{confirmation,by}')
 WHERE "confirmedOn" IS NULL
   AND ("definition" #>> '{confirmation,on}') ~ '^\d{4}-\d{2}-\d{2}$'
   AND btrim(COALESCE("definition" #>> '{confirmation,by}', '')) <> '';

-- 3. The company's payroll code, where it has none: its layouts' code; where they differ, the most recently changed ACTIVE
--    layout's (else the most recently changed one's). At most 20 characters, as Company_payroll_code_guard asks.
UPDATE "Company" c
   SET "payrollCode" = x.code
  FROM (
    SELECT DISTINCT ON (l."tenantId", l."companyId") l."tenantId", l."companyId", btrim(l."definition" ->> 'companyCode') AS code
      FROM "PayrollExportLayout" l
     WHERE btrim(COALESCE(l."definition" ->> 'companyCode', '')) <> '' AND char_length(btrim(l."definition" ->> 'companyCode')) <= 20
     ORDER BY l."tenantId", l."companyId", (l."status" = 'ACTIVE') DESC, l."updatedAt" DESC, l."id"
  ) x
 WHERE c."tenantId" = x."tenantId" AND c."id" = x."companyId" AND c."payrollCode" IS NULL;

-- 4. Both keys leave every layout's definition: the columns above hold them now.
UPDATE "PayrollExportLayout"
   SET "definition" = "definition" - 'confirmation' - 'companyCode'
 WHERE "definition" ?| ARRAY['confirmation', 'companyCode'];
