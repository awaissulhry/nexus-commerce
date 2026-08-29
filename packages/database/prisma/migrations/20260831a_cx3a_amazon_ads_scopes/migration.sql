-- CX.3a — Amazon Ads onto the connection core (docs/2026-08-29-cx3a-amazon-ads-on-the-core.md §2).
--
-- ADDITIVE ONLY, and it does NOT touch AmazonAdsConnection: the nine rows and their
-- credential blobs stay exactly as they are, because the bid engine reads them and the
-- rollback for the credential change is "read the row again". No column is added, no
-- table created, no constraint altered.
--
-- Shape: ONE ChannelConnection for the grant + ONE ConnectionScope per Ads profile.
-- One LWA grant covers N profiles (all nine rows carry the SAME encrypted credential —
-- measured on prod 2026-08-29: 9 rows, 1 distinct blob), so nine connections would be
-- nine copies of one fact. `schema.prisma` says the same at the ConnectionScope model.
--
-- Credentials are NOT moved here: the envelope needs KMS/the token service, so the
-- one-shot job `cx3a-ads-credentials` adopts the refresh token after a verified read.
-- authStatus starts 'unknown' — a migration must never assert health it has not measured;
-- the heartbeat decides within 15 minutes.

-- ── §2.1 the grant row (only if the core does not already hold one) ────────────
INSERT INTO "ChannelConnection" (
  "id", "channelType", "managedBy", "isActive", "isPrimary", "authStatus", "region",
  "displayName", "apiVersion", "sortOrder", "createdAt", "updatedAt"
)
SELECT
  md5('cx3a:amazon_ads:grant'),
  'AMAZON_ADS',
  'oauth',
  true,
  true,
  'unknown',
  'EU',
  -- The operator's own label for the account, taken from the profiles themselves.
  (SELECT "accountLabel" FROM "AmazonAdsConnection"
    WHERE "accountLabel" IS NOT NULL
    GROUP BY "accountLabel" ORDER BY count(*) DESC, "accountLabel" ASC LIMIT 1),
  'ads-v1 · reporting-v3',
  0,
  now(),
  now()
WHERE EXISTS (SELECT 1 FROM "AmazonAdsConnection")
  AND NOT EXISTS (SELECT 1 FROM "ChannelConnection" WHERE "channelType" = 'AMAZON_ADS');

-- ── §2.2 one scope per profile ────────────────────────────────────────────────
-- `isActive` on the scope means "this profile is live", i.e. mode = production. A
-- sandbox profile is a real profile the account reaches; it is listed and marked, not
-- hidden — hiding it would under-report the account's reach.
INSERT INTO "ConnectionScope" (
  "id", "connectionId", "kind", "externalId", "label", "region", "isActive", "metadata", "createdAt", "updatedAt"
)
SELECT
  md5(c."id" || ':profile:' || a."profileId"),
  c."id",
  'profile',
  a."profileId",
  COALESCE(a."accountLabel", 'Ads profile') || ' · ' || a."marketplace" || CASE WHEN a."mode" = 'production' THEN '' ELSE ' · sandbox' END,
  a."region",
  (a."mode" = 'production' AND a."isActive"),
  jsonb_strip_nulls(jsonb_build_object(
    'marketplace',      a."marketplace",
    'mode',             a."mode",
    'writesEnabledAt',  a."writesEnabledAt",
    'lastWriteAt',      a."lastWriteAt",
    'lastVerifiedAt',   a."lastVerifiedAt",
    'legacyRowId',      a."id"
  )),
  now(),
  now()
FROM "AmazonAdsConnection" a
JOIN "ChannelConnection" c ON c."channelType" = 'AMAZON_ADS'
ON CONFLICT ("connectionId", "kind", "externalId") DO NOTHING;

-- ── §2.3 gate: a partial fan-out must fail loudly ─────────────────────────────
-- Under-reporting the account's reach is the failure this catches: nine profiles in,
-- nine scopes out, or the migration refuses.
DO $$
DECLARE ads INTEGER; scopes INTEGER;
BEGIN
  SELECT count(*) INTO ads FROM "AmazonAdsConnection";
  IF ads = 0 THEN RETURN; END IF;

  SELECT count(*) INTO scopes
  FROM "ConnectionScope" s
  JOIN "ChannelConnection" c ON c."id" = s."connectionId" AND c."channelType" = 'AMAZON_ADS'
  WHERE s."kind" = 'profile';

  IF scopes <> ads THEN
    RAISE EXCEPTION 'CX.3a: % Amazon Ads profile(s) but % scope row(s) — refusing a partial fan-out', ads, scopes;
  END IF;
END $$;
