-- Written by hand (Prisma does not model triggers), after the generated 202610282500_print_printers and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Printing (plan A1 §3.9; GAP-007). apps/factory-api's platform/print checks all of this first; these rules hold for
-- every login, the owner included. The tenant, company and site of a row are held by the policies and by the
-- references (a job's printer reference includes them), not here.
--
-- Printer
--   every row  a LABEL_ZPL printer has its resolution and label stock; an A4_PDF printer has none of them.
--   UPDATE     the kind never changes (a queued job was made for it): a different printer is a new row.
--   DELETE     refused: a printer is archived (status ARCHIVED). TRUNCATE refused.
CREATE FUNCTION "factory_printer_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'print: TRUNCATE on "%" is refused', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'print: printer % is never deleted; archive it', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."kind" = 'LABEL_ZPL') <> (NEW."dpi" IS NOT NULL AND NEW."labelWidthMm" IS NOT NULL AND NEW."labelHeightMm" IS NOT NULL)
     OR (NEW."kind" = 'A4_PDF' AND (NEW."dpi" IS NOT NULL OR NEW."labelWidthMm" IS NOT NULL OR NEW."labelHeightMm" IS NOT NULL)) THEN
    RAISE EXCEPTION 'print: printer % has its resolution and label stock exactly when it is a label printer', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."kind" <> OLD."kind" THEN
    RAISE EXCEPTION 'print: the kind of printer % never changes; add a new printer', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Printer_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Printer"
  FOR EACH ROW EXECUTE FUNCTION "factory_printer_guard"();
CREATE TRIGGER "Printer_no_truncate" BEFORE TRUNCATE ON "Printer"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_printer_guard"();

-- PrintJob
--   every row  a ZPL job holds its ZPL, its label kind and scannable id, and no file; a PDF job holds its file and no
--              ZPL; 1 to 500 copies; attempts never below 0; SENT has sentAt, PRINTED printedAt, FAILED failedAt.
--   UPDATE     what was asked never changes: printer, record, payload, ZPL, file, copies, who asked, creation (a new
--              request is a new job); the status moves only QUEUED → SENT | FAILED, SENT → PRINTED | FAILED and
--              FAILED → QUEUED (sent again); a PRINTED job changes no more.
--   DELETE     refused: a job keeps its row (the print history of a record). TRUNCATE refused.
CREATE FUNCTION "factory_print_job_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'print: TRUNCATE on "%" is refused', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'print: print job % is never deleted', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF (NEW."payloadKind" = 'ZPL' AND (NEW."zpl" IS NULL OR NEW."labelKind" IS NULL OR NEW."scanId" IS NULL OR NEW."fileId" IS NOT NULL))
     OR (NEW."payloadKind" = 'PDF' AND (NEW."fileId" IS NULL OR NEW."zpl" IS NOT NULL)) THEN
    RAISE EXCEPTION 'print: job % holds ZPL (with its label) or a PDF file, as its payload kind says', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."copies" < 1 OR NEW."copies" > 500 OR NEW."attempts" < 0 THEN
    RAISE EXCEPTION 'print: job % asks 1 to 500 copies and counts its tries from 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'SENT' AND NEW."sentAt" IS NULL)
     OR (NEW."status" = 'PRINTED' AND NEW."printedAt" IS NULL)
     OR (NEW."status" = 'FAILED' AND NEW."failedAt" IS NULL) THEN
    RAISE EXCEPTION 'print: job % is % without its time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF (NEW."id", NEW."companyId", NEW."printerId", NEW."recordType", NEW."recordId", NEW."payloadKind", NEW."labelKind",
      NEW."scanId", NEW."zpl", NEW."fileId", NEW."copies", NEW."requestedById", NEW."deviceId", NEW."createdAt",
      NEW."createdById")
     IS DISTINCT FROM
     (OLD."id", OLD."companyId", OLD."printerId", OLD."recordType", OLD."recordId", OLD."payloadKind", OLD."labelKind",
      OLD."scanId", OLD."zpl", OLD."fileId", OLD."copies", OLD."requestedById", OLD."deviceId", OLD."createdAt",
      OLD."createdById") THEN
    RAISE EXCEPTION 'print: what job % asked never changes; a new request is a new job', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status"
     AND NOT ((OLD."status" = 'QUEUED' AND NEW."status" IN ('SENT', 'FAILED'))
              OR (OLD."status" = 'SENT' AND NEW."status" IN ('PRINTED', 'FAILED'))
              OR (OLD."status" = 'FAILED' AND NEW."status" = 'QUEUED')) THEN
    RAISE EXCEPTION 'print: job % cannot move from % to %', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'PRINTED'
     AND (NEW."status", NEW."attempts", NEW."lastError", NEW."relayJobId", NEW."sentAt", NEW."printedAt", NEW."failedAt")
         IS DISTINCT FROM
         (OLD."status", OLD."attempts", OLD."lastError", OLD."relayJobId", OLD."sentAt", OLD."printedAt", OLD."failedAt") THEN
    RAISE EXCEPTION 'print: job % is printed; it changes no more', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PrintJob_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PrintJob"
  FOR EACH ROW EXECUTE FUNCTION "factory_print_job_guard"();
CREATE TRIGGER "PrintJob_no_truncate" BEFORE TRUNCATE ON "PrintJob"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_print_job_guard"();
