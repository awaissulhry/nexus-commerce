-- The cross-business reference guard, fired BEFORE INSERT OR UPDATE on every tenant
-- table. It refuses a row whose foreign key points at another business's record.
--
-- Moved into this file on 2026-09-16 so the generator (workspace-policies.mjs, which the
-- disposable test database applies) and the migrations share ONE body — the same
-- pattern as account-grant.sql and the rest. Its original form is in
-- 20260908b_workspace_data_isolation; everything above the BP.S3 block is unchanged.
--
-- ── BP.S3 — the one deliberate exception ─────────────────────────────────────────
--
-- 🔴 Measured before this change: with an active `publish` grant, a guest business
-- still could NOT create a ChannelListing on the shared account. This guard read the
-- account's owning business, found it differed, and raised 23503 — which Prisma
-- reports as "Foreign key constraint violated". The claim, the publish preflight and
-- the credential guard were all correct and all unreachable behind it. The BP.S3 tests
-- never saw it, because they exercised claims on a coordinate and never created a real
-- listing on a shared account.
--
-- A link to ChannelConnection is now allowed when, and only when, ALL of these hold:
--
--   1. the row is one of the three a publisher must write — ChannelListing,
--      VariantChannelListing, ProductListingAlias. NOT Order (inbound orders stay with
--      the owner — ingress routing is unchanged), NOT ConnectionScope/ConnectionEvent
--      (the owner's account metadata), NOT EbayCampaign (ads spend on the owner's
--      account), NOT SyncChannelPolicy or SharedListingMembership;
--   2. this business holds an ACTIVE grant on that account;
--   3. that grant's mode is `publish`. A `read` grant still cannot attach anything.
--
-- The grant is read as the invoking role, under the grant table's own policy, so a
-- business can only ever satisfy this with a grant made TO it.
--
-- Attaching a listing is not publishing it. The coordinate itself is still protected by
-- ChannelListingClaim at push time, so a guest that attaches a listing for a SKU the
-- owner already publishes gets a row that is refused when it is pushed — and told why.
--
-- ⚠ Consequence of revoking publish: this guard fires on UPDATE too, so a guest's
-- existing listings on that account can no longer be edited once the grant is revoked
-- or downgraded to `read`. That is intended — it is the same moment the guest loses the
-- right to push them — but it is the behaviour to expect.

CREATE OR REPLACE FUNCTION nexus_workspace_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE relation jsonb; foreign_value text; parent_workspace text;
    BEGIN
      IF TG_OP = 'UPDATE' AND OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId" THEN
        RAISE EXCEPTION 'Business ownership cannot be reassigned' USING ERRCODE = '23514';
      END IF;
      FOR relation IN SELECT * FROM jsonb_array_elements(TG_ARGV[0]::jsonb) LOOP
        foreign_value := to_jsonb(NEW)->>(relation->>'from');
        IF foreign_value IS NULL THEN CONTINUE; END IF;
        EXECUTE format('SELECT "workspaceId" FROM %I.%I WHERE %I::text = $1', TG_TABLE_SCHEMA, relation->>'model', relation->>'to')
          INTO parent_workspace USING foreign_value;
        IF parent_workspace IS DISTINCT FROM NEW."workspaceId" THEN
          -- BP.S3: a publisher's listing on an account shared WITH it for publishing.
          IF relation->>'model' = 'ChannelConnection'
             AND TG_TABLE_NAME IN ('ChannelListing', 'VariantChannelListing', 'ProductListingAlias')
             AND EXISTS (
               SELECT 1 FROM "ChannelAccountGrant" g
               WHERE g."connectionId" = foreign_value
                 AND g."workspaceId" = NEW."workspaceId"
                 AND g.mode = 'publish'
                 AND g."revokedAt" IS NULL
             ) THEN
            CONTINUE;
          END IF;
          RAISE EXCEPTION 'Related record is unavailable in this business profile' USING ERRCODE = '23503';
        END IF;
      END LOOP;
      RETURN NEW;
    END $$;
