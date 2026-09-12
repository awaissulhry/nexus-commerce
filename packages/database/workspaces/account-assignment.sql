CREATE OR REPLACE FUNCTION nexus_retired_connection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."managedBy" = 'transferred' THEN
    RAISE EXCEPTION 'This connection was retired by a profile assignment and cannot be reused' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS nexus_retired_connection ON "ChannelConnection";
CREATE TRIGGER nexus_retired_connection BEFORE UPDATE ON "ChannelConnection" FOR EACH ROW EXECUTE FUNCTION nexus_retired_connection_guard();

-- An explicit handover creates a NEW connection. Never change a tenant row's
-- workspaceId: old references and queued jobs must retain the old, inactive ID.
CREATE OR REPLACE FUNCTION nexus_assign_channel_account(connection_id text, destination_id text, expected_version text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET TimeZone = 'UTC' AS $$
DECLARE
  source_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
  actor_id text := NULLIF(current_setting('nexus.actor_id', true), '');
  account "ChannelConnection"%ROWTYPE;
  destination "Workspace"%ROWTYPE;
  source_name text;
  ownership_id text;
  version text;
  new_id text;
  blockers jsonb := '[]'::jsonb;
  references_found jsonb := '[]'::jsonb;
  ref record;
  found_reference boolean;
  result jsonb;
BEGIN
  IF source_id IS NULL OR actor_id IS NULL OR destination_id IS NULL OR source_id = destination_id THEN
    RETURN jsonb_build_object('error', 'Choose a different business profile.', 'code', 'invalid_assignment', 'status', 400);
  END IF;
  -- Matches membership/archive serialization; stable ordering avoids opposite moves deadlocking.
  PERFORM id FROM "Workspace" WHERE id IN (source_id, destination_id) ORDER BY id FOR UPDATE;
  PERFORM id FROM "UserProfile" WHERE id = actor_id AND status = 'active' FOR SHARE;
  IF NOT FOUND OR (SELECT count(*) FROM "WorkspaceMembership" m
    JOIN "Workspace" w ON w.id = m."workspaceId"
    WHERE m."userId" = actor_id AND m.status = 'active' AND w.status = 'active'
      AND m."workspaceId" IN (source_id, destination_id)
      AND EXISTS (SELECT 1 FROM "WorkspaceMemberRole" mr JOIN "Role" r ON r.id = mr."roleId"
        WHERE mr."membershipId" = m.id AND r.key = 'OWNER')) <> 2 THEN
    RETURN jsonb_build_object('error', 'Owner access to both active profiles is required.', 'code', 'workspace_owner_required', 'status', 403);
  END IF;
  SELECT * INTO account FROM "ChannelConnection" WHERE id = connection_id AND "workspaceId" = source_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'This account is unavailable in the current profile.', 'code', 'account_unavailable', 'status', 404);
  END IF;
  SELECT * INTO destination FROM "Workspace" WHERE id = destination_id;
  SELECT name INTO source_name FROM "Workspace" WHERE id = source_id;
  -- A response lost after commit can be retried without creating another connection.
  IF account."managedBy" = 'transferred' AND expected_version IS NOT NULL
    AND account."connectionMetadata"->'profileAssignment'->>'version' = expected_version
    AND account."connectionMetadata"->'profileAssignment'->>'destinationId' = destination_id THEN
    IF NOT EXISTS (SELECT 1 FROM "ChannelAccountOwnership" WHERE "channelType" = account."channelType"
      AND environment = COALESCE(account."connectionMetadata"->>'environment', 'production')
      AND "externalAccountId" = account."connectionMetadata"->'profileAssignment'->>'externalAccountId'
      AND "workspaceId" = destination_id) THEN
      RETURN jsonb_build_object('error', 'This assignment completed, but the account has since moved again. Refresh your profiles.', 'code', 'assignment_changed', 'status', 409);
    END IF;
    RETURN jsonb_build_object('assigned', true, 'connectionId', account."connectionMetadata"->'profileAssignment'->>'connectionId', 'destinationId', destination_id, 'destinationName', destination.name);
  END IF;
  version := md5(to_jsonb(account)::text || destination.id || destination.version::text);
  IF expected_version IS NOT NULL AND expected_version <> version THEN
    RETURN jsonb_build_object('error', 'The account or destination changed. Review the assignment again.', 'code', 'assignment_changed', 'status', 409);
  END IF;
  IF account."managedBy" <> 'oauth' THEN blockers := blockers || jsonb_build_array('Only accounts connected through marketplace sign-in can be reassigned.'); END IF;
  IF account."externalAccountId" IS NULL THEN blockers := blockers || jsonb_build_array('The marketplace identity must be verified before reassignment.'); END IF;
  IF account."isActive" OR account."credentialsEnc" IS NOT NULL OR account."accessToken" IS NOT NULL
    OR account."refreshToken" IS NOT NULL OR account."ebayAccessToken" IS NOT NULL OR account."ebayRefreshToken" IS NOT NULL THEN
    blockers := blockers || jsonb_build_array('Disconnect this account first to clear its active sign-in.');
  END IF;
  IF account."refreshLeaseUntil" > CURRENT_TIMESTAMP THEN blockers := blockers || jsonb_build_array('A credential refresh is running. Wait for it to finish.'); END IF;
  IF account."lastSyncAt" IS NOT NULL OR account."lastInboundAt" IS NOT NULL OR account."lastOutboundAt" IS NOT NULL THEN
    blockers := blockers || jsonb_build_array('This account has business activity. Its records need a reviewed data migration before reassignment.');
  END IF;
  IF EXISTS (SELECT 1 FROM "OAuthSession" WHERE "workspaceId" = source_id AND "expiresAt" > CURRENT_TIMESTAMP AND ("consumedAt" IS NULL OR ("resultConnectionId" IS NULL AND error IS NULL))) THEN
    blockers := blockers || jsonb_build_array('A marketplace sign-in is pending in this profile. Finish it or wait for it to expire.');
  END IF;
  SELECT "workspaceId" INTO ownership_id FROM "ChannelAccountOwnership"
    WHERE "channelType" = account."channelType" AND environment = COALESCE(account."connectionMetadata"->>'environment', 'production')
      AND "externalAccountId" = account."externalAccountId" FOR UPDATE;
  IF ownership_id IS DISTINCT FROM source_id THEN blockers := blockers || jsonb_build_array('The verified account ownership is unavailable or has changed.'); END IF;
  IF EXISTS (SELECT 1 FROM "ChannelConnection" WHERE "workspaceId" = source_id AND id <> account.id
    AND "channelType" = account."channelType" AND "externalAccountId" = account."externalAccountId"
    AND COALESCE("connectionMetadata"->>'environment', 'production') = COALESCE(account."connectionMetadata"->>'environment', 'production')) THEN
    blockers := blockers || jsonb_build_array('This seller has other connection records. Review that connection history before reassignment.');
  END IF;
  -- Indexed existence probes cover declared foreign keys and legacy scalar account
  -- references. Do not scan JSON blobs or load whole business tables into memory.
  -- Connection scopes/events remain on the retired source ID for audit purposes.
  FOR ref IN
    SELECT DISTINCT t.relname AS model, a.attname AS field FROM pg_class t
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND t.relkind = 'r'
      AND t.relname NOT IN ('ConnectionScope', 'ConnectionEvent', 'ChannelAccountRoute')
      AND EXISTS (SELECT 1 FROM pg_attribute w WHERE w.attrelid = t.oid AND w.attname = 'workspaceId' AND NOT w.attisdropped)
      AND (a.attname IN ('connectionId', 'channelConnectionId', 'accountId') OR EXISTS (
        SELECT 1 FROM pg_constraint fk WHERE fk.contype = 'f' AND fk.conrelid = t.oid
          AND fk.confrelid = '"ChannelConnection"'::regclass AND a.attnum = ANY(fk.conkey)))
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE "workspaceId" = $1 AND %I::text = $2)', ref.model, ref.field)
      INTO found_reference USING source_id, account.id;
    IF found_reference THEN references_found := references_found || jsonb_build_array(ref.model); END IF;
  END LOOP;
  IF jsonb_array_length(references_found) > 0 THEN
    blockers := blockers || jsonb_build_array('Business records or pending work reference this account. A reviewed data migration is required.');
  END IF;
  result := jsonb_build_object('eligible', jsonb_array_length(blockers) = 0, 'version', version, 'blockers', blockers,
    'references', references_found, 'sourceId', source_id, 'sourceName', source_name, 'destinationId', destination_id, 'destinationName', destination.name);
  IF expected_version IS NULL THEN RETURN result; END IF;
  IF jsonb_array_length(blockers) > 0 THEN RETURN result || jsonb_build_object('error', 'The account cannot be reassigned yet. Review the checks below.', 'code', 'assignment_blocked', 'status', 409); END IF;

  new_id := gen_random_uuid()::text;
  -- Source identity remains in the assignment audit. Never reuse this ID for a
  -- new grant, even if a delayed callback or job still names it.
  UPDATE "ChannelConnection" SET "externalAccountId" = NULL, "managedBy" = 'transferred', "isPrimary" = false,
    "connectionMetadata" = COALESCE("connectionMetadata", '{}'::jsonb) || jsonb_build_object('profileAssignment', jsonb_build_object(
      'destinationId', destination_id, 'connectionId', new_id, 'externalAccountId', account."externalAccountId", 'version', version)),
    "updatedAt" = CURRENT_TIMESTAMP WHERE id = account.id AND "workspaceId" = source_id;
  UPDATE "ChannelAccountOwnership" SET "workspaceId" = destination_id
    WHERE "channelType" = account."channelType" AND environment = COALESCE(account."connectionMetadata"->>'environment', 'production')
      AND "externalAccountId" = account."externalAccountId" AND "workspaceId" = source_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account ownership changed during assignment'; END IF;

  -- The only cross-profile write is a new, credential-free account. The caller
  -- cannot choose any row payload or SQL. Restore scope before returning.
  PERFORM set_config('nexus.workspace_id', destination_id, true);
  INSERT INTO "ChannelConnection" (id, "workspaceId", "channelType", marketplace, "managedBy", "displayName", "accountLabel", "accountColor",
    "externalAccountId", region, identity, "connectionMetadata", "authStatus", "isActive", "isPrimary", "updatedAt")
  VALUES (new_id, destination_id, account."channelType", account.marketplace, 'oauth', account."displayName", account."accountLabel", account."accountColor",
    account."externalAccountId", account.region, account.identity, jsonb_build_object('environment', COALESCE(account."connectionMetadata"->>'environment', 'production')),
    'disconnected', false, false, CURRENT_TIMESTAMP);
  PERFORM set_config('nexus.workspace_id', source_id, true);
  INSERT INTO "WorkspaceAudit" (id, "workspaceId", "actorUserId", action, "targetId", metadata)
    SELECT gen_random_uuid()::text, w, actor_id, 'account.assigned', account.id,
      jsonb_build_object('sourceId', source_id, 'destinationId', destination_id, 'connectionId', new_id, 'externalAccountId', account."externalAccountId", 'channelType', account."channelType")
    FROM unnest(ARRAY[source_id, destination_id]) w;
  RETURN jsonb_build_object('assigned', true, 'connectionId', new_id, 'destinationId', destination_id, 'destinationName', destination.name);
END $$;
REVOKE ALL ON FUNCTION nexus_assign_channel_account(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_assign_channel_account(text, text, text) TO nexus_workspace_runtime;
