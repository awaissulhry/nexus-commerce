-- Written by hand (Prisma does not model triggers or partial indexes), after the generated
-- 202610318902_portal_identity_w2b_schema and before the policy migration. When the migrations are renumbered, keep this
-- file as it is under its new timestamp.

-- Portal identity (W2b schema wave 17/22, B-W2b-152; PLT-006, PLT-021, PLT-022, PLT-050, PLT-228, SAL-064; Owner answers
-- C1, C3; A1 §3.10; GATE-PRIVACY): partner users on User, partner sessions and invitations, the PARTNER role audience,
-- sign-in codes, portal settings per party, the portal terms' acknowledgements, company branding.
-- apps/factory-api's portal steps check all of this first; these rules hold for every login, the owner included.
-- The tenant of a row is held by the policies (USING and WITH CHECK) and by the references, not here: the triggers leave
-- "tenantId" to them and never compare it. Every refusal is a check_violation (SQLSTATE 23514). A rule that reads another
-- row skips a row this session cannot see (another tenant's): the policies or the references refuse that write anyway.
-- A trigger reads only tables the role that fires it may read (every table here is written by factory_runtime only).
--
-- No earlier function is redefined: every trigger here is new, on User, Session, Invitation, Role and RoleAssignment
-- (none had one but Role's "Role_require_mfa_since", untouched) and on the new tables. PartnerNoticeAck's append-only
-- triggers run privacy's "factory_refuse_privacy_ledger_change" (202610284901_privacy_guards), unchanged.

CREATE FUNCTION "factory_portal_identity_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'portal: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- User: the audience of a person (PLT-021, PLT-022; Owner answer C3)
--   UPDATE     an UPDATE that changes nothing passes; the audience never changes; a partner person's party never changes
--              (a person of another organisation is another account).
--   OFFICE     no party, no partner kind, no end of access (an office person's access ends with their role assignments).
--   PARTNER    a party and a partner kind; never a password (no hash, no change date, no forced change: e-mail codes only);
--              a GUEST has an end of access; the kind fits the party's roles when it is set or changed: CUSTOMER a
--              customer or a brand, SUPPLIER a supplier, SUBCONTRACTOR a subcontractor, GUEST a consultant (B-W2b-75).
--   The party's later role changes are not followed here (the API's sign-in reads the party as it is).
CREATE FUNCTION "factory_user_audience_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  party_roles text[];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."audience" IS DISTINCT FROM OLD."audience" THEN
      RAISE EXCEPTION 'portal: the audience of person % never changes (an office person and a partner person are two accounts)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."partyId" IS NOT NULL AND NEW."partyId" IS DISTINCT FROM OLD."partyId" THEN
      RAISE EXCEPTION 'portal: partner person % stays with party %; a person of another organisation is another account', OLD."id", OLD."partyId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."audience" = 'OFFICE' THEN
    IF NEW."partyId" IS NOT NULL OR NEW."partnerKind" IS NOT NULL OR NEW."accessUntil" IS NOT NULL THEN
      RAISE EXCEPTION 'portal: office person % has no party, partner kind or end of access (an office person''s access ends with their role assignments)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."partyId" IS NULL OR NEW."partnerKind" IS NULL THEN
    RAISE EXCEPTION 'portal: partner person % names their party and their partner kind', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."passwordHash" IS NOT NULL OR NEW."passwordChangedAt" IS NOT NULL OR NEW."mustChangePassword" THEN
    RAISE EXCEPTION 'portal: partner person % signs in with an e-mail code only, never a password (Owner answer C3)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."partnerKind" = 'GUEST' AND NEW."accessUntil" IS NULL THEN
    RAISE EXCEPTION 'portal: guest % has an end of access (a guest login ends on a date, PLT-022)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."partnerKind" IS DISTINCT FROM OLD."partnerKind" THEN
    SELECT p."roles"::text[] INTO party_roles FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
    IF FOUND AND NOT (
         (NEW."partnerKind" = 'CUSTOMER' AND party_roles && ARRAY['CUSTOMER', 'BRAND']::text[])
      OR (NEW."partnerKind" = 'SUPPLIER' AND 'SUPPLIER' = ANY (party_roles))
      OR (NEW."partnerKind" = 'SUBCONTRACTOR' AND 'SUBCONTRACTOR' = ANY (party_roles))
      OR (NEW."partnerKind" = 'GUEST' AND 'CONSULTANT' = ANY (party_roles))) THEN
      RAISE EXCEPTION 'portal: partner person % cannot use the % portal of party % (roles %): a customer portal needs a customer or a brand, a supplier portal a supplier, a workshop portal a subcontractor, a guest login a consultant', NEW."id", NEW."partnerKind", NEW."partyId", party_roles
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "User_audience_guard" BEFORE INSERT OR UPDATE OF "audience", "partyId", "partnerKind", "accessUntil", "passwordHash", "passwordChangedAt", "mustChangePassword" ON "User"
  FOR EACH ROW EXECUTE FUNCTION "factory_user_audience_guard"();

-- ---------------------------------------------------------------------------------------------------------------------
-- Session: office and partner sessions (A1 §3.10; design portal.frame, the office preview)
--   UPDATE     an UPDATE that changes nothing passes; the person, audience, party and preview never change.
--   OFFICE     no party, no preview; its person is an office person (checked when it is made).
--   PARTNER    bound to one party; 30 minutes after its last use and 12 hours after sign-in at the latest, never past
--              its absolute end. Either its person is a partner person of that party, or it is an office preview: the
--              party previewed is its party and the office person previewing is its person (both or neither).
CREATE FUNCTION "factory_session_audience_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  person record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."userId", NEW."audience", NEW."partyId", NEW."previewOfPartyId", NEW."previewById") IS DISTINCT FROM (OLD."id", OLD."userId", OLD."audience", OLD."partyId", OLD."previewOfPartyId", OLD."previewById") THEN
      RAISE EXCEPTION 'portal: the person, audience, party and preview of session % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."audience" = 'OFFICE' THEN
    IF NEW."partyId" IS NOT NULL OR NEW."previewOfPartyId" IS NOT NULL OR NEW."previewById" IS NOT NULL THEN
      RAISE EXCEPTION 'portal: office session % has no party and previews nothing', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."partyId" IS NULL THEN
      RAISE EXCEPTION 'portal: partner session % is bound to one party', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."previewOfPartyId" IS NULL) <> (NEW."previewById" IS NULL)
       OR (NEW."previewOfPartyId" IS NOT NULL AND (NEW."previewOfPartyId" <> NEW."partyId" OR NEW."previewById" <> NEW."userId")) THEN
      RAISE EXCEPTION 'portal: an office preview session % names the party it shows (its own party) and the office person previewing (its own person), both or neither', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."absoluteExpiresAt" > NEW."createdAt" + interval '12 hours'
       OR NEW."idleExpiresAt" > NEW."lastSeenAt" + interval '30 minutes'
       OR NEW."idleExpiresAt" > NEW."absoluteExpiresAt" THEN
      RAISE EXCEPTION 'portal: partner session % ends 30 minutes after its last use and 12 hours after sign-in at the latest (A1 §3.10)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- The person and their audience never change, so they are checked when the session is made.
  IF TG_OP = 'INSERT' THEN
    SELECT u."audience"::text AS audience, u."partyId" AS party INTO person FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."userId";
    IF FOUND THEN
      IF NEW."audience" = 'OFFICE' AND person.audience <> 'OFFICE' THEN
        RAISE EXCEPTION 'portal: partner person % signs in to the portal of their party, never to the Office (session %)', NEW."userId", NEW."id"
          USING ERRCODE = 'check_violation';
      ELSIF NEW."audience" = 'PARTNER' AND NEW."previewById" IS NULL AND (person.audience <> 'PARTNER' OR person.party IS DISTINCT FROM NEW."partyId") THEN
        RAISE EXCEPTION 'portal: partner session % is bound to the party of its person (%)', NEW."id", NEW."userId"
          USING ERRCODE = 'check_violation';
      ELSIF NEW."previewById" IS NOT NULL AND person.audience <> 'OFFICE' THEN
        RAISE EXCEPTION 'portal: only an office person previews a partner''s portal (session %)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Session_audience_guard" BEFORE INSERT OR UPDATE ON "Session"
  FOR EACH ROW EXECUTE FUNCTION "factory_session_audience_guard"();

-- ---------------------------------------------------------------------------------------------------------------------
-- Invitation: office and partner invitations (PLT-006, SAL-059)
--   UPDATE     an UPDATE that changes nothing passes; the person, audience and party never change; the roles and the end
--              of access change only while it is open (neither accepted nor revoked).
--   OFFICE     no party, no partner role, no end of access.
--   PARTNER    a party; at least one partner role key (lower case, dotted: role keys), each once; an end of access, if
--              any, after it was made.
--   INSERT     the person's audience and party are the invitation's.
CREATE FUNCTION "factory_invitation_audience_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  person record;
  role_keys text[] := coalesce(NEW."partnerRoleKeys", ARRAY[]::text[]);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."userId", NEW."audience", NEW."partyId") IS DISTINCT FROM (OLD."id", OLD."userId", OLD."audience", OLD."partyId") THEN
      RAISE EXCEPTION 'portal: the person, audience and party of invitation % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."partnerRoleKeys", NEW."accessUntil") IS DISTINCT FROM (OLD."partnerRoleKeys", OLD."accessUntil") AND (OLD."acceptedAt" IS NOT NULL OR OLD."revokedAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'portal: the roles and the end of access of invitation % change only while it is open', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."audience" = 'OFFICE' THEN
    IF NEW."partyId" IS NOT NULL OR cardinality(role_keys) > 0 OR NEW."accessUntil" IS NOT NULL THEN
      RAISE EXCEPTION 'portal: office invitation % names no party, no partner role and no end of access', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."partyId" IS NULL OR cardinality(role_keys) = 0 THEN
      RAISE EXCEPTION 'portal: partner invitation % names the party and at least one partner role', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(role_keys) k WHERE k IS NULL OR k !~ '^[a-z][a-z0-9_.-]*$')
       OR cardinality(role_keys) <> (SELECT count(DISTINCT k) FROM unnest(role_keys) k) THEN
      RAISE EXCEPTION 'portal: partner invitation % names its partner roles by their keys, each once', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."accessUntil" IS NOT NULL AND NEW."accessUntil" <= NEW."createdAt" THEN
      RAISE EXCEPTION 'portal: the end of access of partner invitation % comes after it was made', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT u."audience"::text AS audience, u."partyId" AS party INTO person FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."userId";
    IF FOUND AND (person.audience <> NEW."audience"::text OR person.party IS DISTINCT FROM NEW."partyId") THEN
      RAISE EXCEPTION 'portal: invitation % is for a person of its own audience and party; person % is a % person', NEW."id", NEW."userId", person.audience
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Invitation_audience_guard" BEFORE INSERT OR UPDATE ON "Invitation"
  FOR EACH ROW EXECUTE FUNCTION "factory_invitation_audience_guard"();

-- ---------------------------------------------------------------------------------------------------------------------
-- Role: the PARTNER audience (SAL-060, SCM-092; the partner wall, PLT-007)
--   a partner role holds at most the price grain (never cost, margin, wages or pay); which permissions are partner
--   permissions is the API's (factory-domain's catalogue). A role's audience never changes to or from PARTNER (an
--   assignment is checked against it when it is made).
CREATE FUNCTION "factory_role_partner_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."audience" IS DISTINCT FROM OLD."audience" AND 'PARTNER' IN (NEW."audience"::text, OLD."audience"::text) THEN
    RAISE EXCEPTION 'portal: role % keeps its audience: a partner role never becomes an office or floor role, nor the other way', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."audience" = 'PARTNER' AND NOT (coalesce(NEW."grains", ARRAY[]::text[]) <@ ARRAY['price']::text[]) THEN
    RAISE EXCEPTION 'portal: partner role % holds at most the price grain, never cost, margin, wages or pay (it holds %)', NEW."id", NEW."grains"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Role_partner_guard" BEFORE INSERT OR UPDATE OF "audience", "grains" ON "Role"
  FOR EACH ROW EXECUTE FUNCTION "factory_role_partner_guard"();

-- ---------------------------------------------------------------------------------------------------------------------
-- RoleAssignment: a partner person's roles (PLT-006)
--   a PARTNER role goes only to a partner person and a partner person holds only PARTNER roles; a partner person's
--   assignment is bound to exactly their own party (partyIds = [their party]) with no site limit. Checked when the
--   person, the role, the parties or the sites are set; the person's party and the role's audience never change.
CREATE FUNCTION "factory_role_assignment_audience_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  person record;
  role_audience text;
BEGIN
  SELECT u."audience"::text AS audience, u."partyId" AS party INTO person FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."userId";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  SELECT r."audience"::text INTO role_audience FROM "Role" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."roleId";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF (role_audience = 'PARTNER') <> (person.audience = 'PARTNER') THEN
    RAISE EXCEPTION 'portal: a partner role goes only to a partner person, and a partner person holds only partner roles (assignment %: a % role, a % person)', NEW."id", role_audience, person.audience
      USING ERRCODE = 'check_violation';
  END IF;
  IF person.audience = 'PARTNER' AND (NEW."partyIds" IS DISTINCT FROM ARRAY[person.party]::uuid[] OR coalesce(cardinality(NEW."siteIds"), 0) > 0) THEN
    RAISE EXCEPTION 'portal: assignment % of partner person % is bound to their own party % (that party only, no site limit)', NEW."id", NEW."userId", person.party
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RoleAssignment_audience_guard" BEFORE INSERT OR UPDATE OF "userId", "roleId", "partyIds", "siteIds" ON "RoleAssignment"
  FOR EACH ROW EXECUTE FUNCTION "factory_role_assignment_audience_guard"();

-- ---------------------------------------------------------------------------------------------------------------------
-- PortalSignInCode (PLT-050; Owner answer C3; design portal.signin code-step)
--   every row  0 to 5 tries; expires after it was made and at most 15 minutes after; the code stored as a hash (at least
--              32 characters, never digits only); a SIGN_IN code with the hash of its e-mail link, a STEP_UP code
--              without; used at most once, after it was made, while neither replaced nor tried out; replaced after it was
--              made.
--   INSERT     for a partner person (office people sign in with a password and two-factor).
--   UPDATE     an UPDATE that changes nothing passes; the person, purpose, hashes, times and address never change; the
--              tries count up only; used and replaced are set once and never cleared. A dead code (used, replaced, tried
--              out, or past its expiry) never opens again: neither its tries nor its use move; it may only be replaced
--              (revokedAt) if it was never used, so a newer code can take the live place.
--   One live code per person and purpose: the partial unique index below (live = unused, not replaced, under 5 tries;
--   an expired one is replaced by the API before a new one is made). DELETE passes (the purge job removes dead codes).
CREATE FUNCTION "factory_portal_sign_in_code_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  person_audience text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."userId", NEW."purpose", NEW."codeHash", NEW."linkTokenHash", NEW."createdAt", NEW."expiresAt", NEW."ipHash") IS DISTINCT FROM (OLD."id", OLD."userId", OLD."purpose", OLD."codeHash", OLD."linkTokenHash", OLD."createdAt", OLD."expiresAt", OLD."ipHash") THEN
      RAISE EXCEPTION 'portal: code % keeps its person, purpose, hashes, times and address', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."tries" < OLD."tries"
       OR (OLD."usedAt" IS NOT NULL AND NEW."usedAt" IS DISTINCT FROM OLD."usedAt")
       OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt") THEN
      RAISE EXCEPTION 'portal: code % counts its tries up only, and is used or replaced once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."usedAt" IS NOT NULL OR OLD."revokedAt" IS NOT NULL OR OLD."tries" >= 5 OR OLD."expiresAt" <= now())
       AND (NEW."tries", NEW."usedAt") IS DISTINCT FROM (OLD."tries", OLD."usedAt") THEN
      RAISE EXCEPTION 'portal: code % is used, replaced, tried out or expired; it never opens again (ask for a new code)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."tries" NOT BETWEEN 0 AND 5 OR NEW."expiresAt" <= NEW."createdAt" OR NEW."expiresAt" > NEW."createdAt" + interval '15 minutes' THEN
    RAISE EXCEPTION 'portal: code % lives at most 15 minutes and allows 5 tries', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF length(NEW."codeHash") < 32 OR NEW."codeHash" ~ '^[[:space:]]*[0-9]+[[:space:]]*$' THEN
    RAISE EXCEPTION 'portal: code % is stored as a hash (an HMAC with the server''s secret), never the digits themselves', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."purpose" = 'SIGN_IN') <> (NEW."linkTokenHash" IS NOT NULL) THEN
    RAISE EXCEPTION 'portal: a sign-in code comes with the hash of its e-mail link, a step-up code without one (code %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."usedAt" IS NOT NULL AND (NEW."usedAt" < NEW."createdAt" OR NEW."revokedAt" IS NOT NULL OR NEW."tries" >= 5))
     OR NEW."revokedAt" < NEW."createdAt" THEN
    RAISE EXCEPTION 'portal: code % is used once, after it was made, while neither replaced nor tried out; replaced after it was made', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT u."audience"::text INTO person_audience FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."userId";
    IF FOUND AND person_audience <> 'PARTNER' THEN
      RAISE EXCEPTION 'portal: codes are for partner people; office person % signs in with a password and two-factor (code %)', NEW."userId", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PortalSignInCode_guard" BEFORE INSERT OR UPDATE ON "PortalSignInCode"
  FOR EACH ROW EXECUTE FUNCTION "factory_portal_sign_in_code_guard"();

CREATE UNIQUE INDEX "PortalSignInCode_one_live" ON "PortalSignInCode" ("tenantId", "userId", "purpose")
  WHERE "usedAt" IS NULL AND "revokedAt" IS NULL AND "tries" < 5;

-- ---------------------------------------------------------------------------------------------------------------------
-- PortalSettings (PLT-006; Owner answer C1)
--   UPDATE     an UPDATE that changes nothing passes; the party and the creation never change.
--   every row  at most 1 to 1000 people, or no limit; the allowed partner roles by their keys, each once (a list, maybe
--              empty); production progress shared only with a customer or a brand (checked when it is switched on).
--   DELETE     refused (switch the portal off instead). TRUNCATE refused.
CREATE FUNCTION "factory_portal_settings_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  party_roles text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'portal: the portal settings % are changed, never deleted (switch the portal off)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."partyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."partyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'portal: the party and creation of the portal settings % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."maxUsers" IS NOT NULL AND NEW."maxUsers" NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'portal: the portal settings % hold 1 to 1000 people, or no limit, not %', NEW."id", NEW."maxUsers"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."allowedRoleKeys" IS NULL
     OR EXISTS (SELECT 1 FROM unnest(NEW."allowedRoleKeys") k WHERE k IS NULL OR k !~ '^[a-z][a-z0-9_.-]*$')
     OR cardinality(NEW."allowedRoleKeys") <> (SELECT count(DISTINCT k) FROM unnest(NEW."allowedRoleKeys") k) THEN
    RAISE EXCEPTION 'portal: the portal settings % name the allowed partner roles by their keys, each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."progressShared" AND (TG_OP = 'INSERT' OR NOT OLD."progressShared") THEN
    SELECT p."roles"::text[] INTO party_roles FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
    IF FOUND AND NOT (party_roles && ARRAY['CUSTOMER', 'BRAND']::text[]) THEN
      RAISE EXCEPTION 'portal: production progress is shared only with a customer or a brand (Owner answer C1); party % is %', NEW."partyId", party_roles
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PortalSettings_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PortalSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_portal_settings_guard"();
CREATE TRIGGER "PortalSettings_no_truncate" BEFORE TRUNCATE ON "PortalSettings"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_portal_identity_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- CompanyBranding (PLT-228, SAL-064; design admin.documents › Branding)
--   UPDATE     an UPDATE that changes nothing passes; the company and the creation never change.
--   every row  the accent `#rrggbb` in lower case; the sender name 1 to 80 characters, no control characters and no angle
--              brackets (it goes into a mail header); the portal label 1 to 60 characters, no control characters; a logo
--              for dark only beside a light one; each logo, when it is set or changed, a picture (PHOTO) of the company.
--   DELETE     refused (clear its fields: the DS colours come back). TRUNCATE refused.
CREATE FUNCTION "factory_company_branding_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  logo record;
  file_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'portal: the branding % is changed, never deleted (clear its fields)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'portal: the company and creation of the branding % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."accentColour" !~ '^#[0-9a-f]{6}$' THEN
    RAISE EXCEPTION 'portal: the accent of the branding % is #rrggbb in lower case, not %', NEW."id", NEW."accentColour"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."senderDisplayName") = '' OR length(NEW."senderDisplayName") > 80 OR NEW."senderDisplayName" ~ '[[:cntrl:]<>]' THEN
    RAISE EXCEPTION 'portal: the sender name of the branding % has 1 to 80 characters, no control characters and no angle brackets (it goes into a mail header)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."portalLabel") = '' OR length(NEW."portalLabel") > 60 OR NEW."portalLabel" ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'portal: the portal label of the branding % has 1 to 60 characters and no control characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."logoDarkFileId" IS NOT NULL AND NEW."logoFileId" IS NULL THEN
    RAISE EXCEPTION 'portal: the branding % has a logo for dark pages only beside a logo for light ones', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- Each logo set or changed by this write (an unchanged one was checked when it was set).
  FOREACH file_id IN ARRAY ARRAY[NEW."logoFileId", NEW."logoDarkFileId"] LOOP
    CONTINUE WHEN file_id IS NULL OR (TG_OP = 'UPDATE' AND file_id IN (OLD."logoFileId", OLD."logoDarkFileId"));
    SELECT f."kind"::text AS kind, f."companyId" AS company INTO logo FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = file_id;
    IF FOUND AND (logo.kind <> 'PHOTO' OR logo.company IS DISTINCT FROM NEW."companyId") THEN
      RAISE EXCEPTION 'portal: a logo of the branding % is a picture (PHOTO) of its company; file % is a % file', NEW."id", file_id, logo.kind
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CompanyBranding_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CompanyBranding"
  FOR EACH ROW EXECUTE FUNCTION "factory_company_branding_guard"();
CREATE TRIGGER "CompanyBranding_no_truncate" BEFORE TRUNCATE ON "CompanyBranding"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_portal_identity_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- PartnerNoticeAck: append-only (plan A1 §2.1; scripts/factory/check-append-only.mjs). No login may change or remove a
-- row, the owner and superusers included; the runtime roles have no UPDATE, DELETE or TRUNCATE grant either.
CREATE TRIGGER "PartnerNoticeAck_append_only" BEFORE UPDATE OR DELETE ON "PartnerNoticeAck"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_privacy_ledger_change"();
CREATE TRIGGER "PartnerNoticeAck_no_truncate" BEFORE TRUNCATE ON "PartnerNoticeAck"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_privacy_ledger_change"();

-- PartnerNoticeAck, INSERT (GDPR arts. 7(1), 13; GATE-PRIVACY; design portal.signin first-visit)
--   the PORTAL_TERMS notice in force of its company; a label, a language (ISO 639-1) and the SHA-256 of the notice's
--   text in that language, as shown; an ACTIVE partner person of its party. One per person, company and label (the
--   unique key). Its label is the API's copy of the notice's (the generated isolation test copies a row with its unique
--   text columns suffixed, so it is not compared here).
CREATE FUNCTION "factory_partner_notice_ack_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  notice record;
  person record;
BEGIN
  IF btrim(NEW."noticeVersion") = '' OR NEW."locale" !~ '^[a-z]{2}$' OR NEW."noticeSha256" !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'portal: terms acknowledgement % names the version, the language (ISO 639-1) and the SHA-256 of the text as shown', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT n."kind"::text AS kind, n."status"::text AS status, n."companyId" AS company INTO notice FROM "PrivacyNotice" n WHERE n."tenantId" = NEW."tenantId" AND n."id" = NEW."noticeId";
  IF FOUND THEN
    IF notice.kind <> 'PORTAL_TERMS' OR notice.status <> 'PUBLISHED' OR notice.company <> NEW."companyId" THEN
      RAISE EXCEPTION 'portal: terms acknowledgement % names its company''s portal terms in force; notice % is a % % one', NEW."id", NEW."noticeId", notice.status, notice.kind
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "PrivacyNoticeText" t WHERE t."tenantId" = NEW."tenantId" AND t."noticeId" = NEW."noticeId" AND t."locale" = NEW."locale" AND t."sha256" = NEW."noticeSha256") THEN
      RAISE EXCEPTION 'portal: terms acknowledgement % stores the fingerprint of notice % in language %', NEW."id", NEW."noticeId", NEW."locale"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT u."audience"::text AS audience, u."status"::text AS status, u."partyId" AS party INTO person FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."userId";
  IF FOUND AND (person.audience <> 'PARTNER' OR person.status <> 'ACTIVE' OR person.party IS DISTINCT FROM NEW."partyId") THEN
    RAISE EXCEPTION 'portal: the portal terms are acknowledged by an ACTIVE partner person of the acknowledgement''s party; person % is an % % person', NEW."userId", person.status, person.audience
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PartnerNoticeAck_check" BEFORE INSERT ON "PartnerNoticeAck"
  FOR EACH ROW EXECUTE FUNCTION "factory_partner_notice_ack_check"();
