import { readFileSync } from 'node:fs'

const ownership = JSON.parse(readFileSync(new URL('../workspaces/model-ownership.json', import.meta.url), 'utf8'))
const keys = JSON.parse(readFileSync(new URL('../workspaces/scoped-keys.json', import.meta.url), 'utf8'))
const quote = name => {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid schema identifier: ${name}`)
  return `"${name}"`
}

/**
 * The isolation policy and reference-guard trigger for ONE business-owned model, exactly as the
 * full script emits it. Exported so a migration adding a business-owned table can carry the same
 * bytes the disposable test database gets (AE.2: 20260916g) instead of a hand-copied policy.
 */
export function workspaceModelSql(model) {
  const tenantModels = new Set(ownership.workspaceModels)
  if (!tenantModels.has(model)) throw new Error(`${model} is not a business-owned model in model-ownership.json`)
  const out = []
  const table = quote(model)
  const scope = `"workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '')`
  // The continuation lines keep their original indentation: it is inside the SQL string, and the
  // policy text of every business-owned table must stay byte-identical to what was deployed.
  const access = `EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "${model}"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))`
  const condition = model === 'AuditLog'
    ? `((${scope} AND ${access}) OR ("workspaceId" IS NULL AND NULLIF(current_setting('nexus.workspace_id', true), '') IS NULL))`
    : `(${scope} AND ${access})`
  out.push(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`)
  out.push(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`)
  out.push(`DROP POLICY IF EXISTS nexus_workspace_isolation ON ${table};`)
  out.push(`CREATE POLICY nexus_workspace_isolation ON ${table} FOR ALL TO nexus_workspace_runtime USING (${condition}) WITH CHECK (${condition});`)
  const relations = keys[model].relations.filter(relation => tenantModels.has(relation.model) && relation.from.length === 1 && relation.to.length === 1)
    .map(relation => ({ model: relation.model, from: relation.from[0], to: relation.to[0] }))
  out.push(`DROP TRIGGER IF EXISTS nexus_workspace_references ON ${table};`)
  out.push(`CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('${JSON.stringify(relations)}');`)
  return out
}

/** Also applied by the disposable database tests; includes real policies and triggers. */
export function workspacePolicySql() {
  const tenantModels = new Set(ownership.workspaceModels)
  const sql = [
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_workspace_runtime') THEN
        CREATE ROLE nexus_workspace_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_workspace_runtime' AND (rolsuper OR rolbypassrls)) THEN
        RAISE EXCEPTION 'Workspace runtime role must not bypass row-level security';
      END IF;
    END $$;`,
    'GRANT nexus_workspace_runtime TO CURRENT_USER;',
    'GRANT USAGE ON SCHEMA public TO nexus_workspace_runtime;',
    // The reference guard now lives in one file shared with its migrations. BP.S3 added
    // its single exception (publish grants); see the file header for exactly what.
    readFileSync(new URL('../workspaces/reference-guard.sql', import.meta.url), 'utf8'),
  ]
  for (const model of [...ownership.globalModels, ...ownership.workspaceModels]) {
    sql.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${quote(model)} TO nexus_workspace_runtime;`)
  }
  sql.push('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nexus_workspace_runtime;')
  for (const model of ownership.workspaceModels) sql.push(...workspaceModelSql(model))
  sql.push(readFileSync(new URL('../workspaces/cx-account-integrity.sql', import.meta.url), 'utf8'))
  sql.push('DROP TRIGGER IF EXISTS nexus_channel_route ON "ChannelConnection";')
  sql.push('CREATE TRIGGER nexus_channel_route AFTER INSERT OR UPDATE OR DELETE ON "ChannelConnection" FOR EACH ROW EXECUTE FUNCTION nexus_channel_route_sync();')
  sql.push(`INSERT INTO "ChannelAccountOwnership" ("channelType", environment, "externalAccountId", "workspaceId") SELECT DISTINCT "channelType", COALESCE("connectionMetadata"->>'environment', 'production'), "externalAccountId", "workspaceId" FROM "ChannelConnection" WHERE "externalAccountId" IS NOT NULL ON CONFLICT DO NOTHING;`)
  sql.push(`INSERT INTO "ChannelAccountRoute" ("connectionId", "workspaceId", "channelType", "externalAccountId", "inboundAliases") SELECT c.id, c."workspaceId", c."channelType", c."externalAccountId", nexus_channel_inbound_aliases(c) FROM "ChannelConnection" c WHERE c."isActive" ON CONFLICT ("connectionId") DO NOTHING;`)
  sql.push(`CREATE OR REPLACE FUNCTION nexus_channel_scope_route_sync() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    DECLARE target_id text;
    BEGIN
      target_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."connectionId" ELSE NEW."connectionId" END;
      UPDATE "ChannelAccountRoute" SET "destinationIds" = ARRAY(
        SELECT DISTINCT identifier FROM "ConnectionScope" s CROSS JOIN LATERAL unnest(ARRAY[s."externalId", s.metadata->>'accountId']) identifier
        WHERE s."connectionId" = target_id AND s."isActive" AND s.kind = 'profile' AND identifier IS NOT NULL
      ) WHERE "connectionId" = target_id;
      RETURN COALESCE(NEW, OLD);
    END $$;`)
  sql.push('DROP TRIGGER IF EXISTS nexus_scope_route ON "ConnectionScope";')
  sql.push('CREATE TRIGGER nexus_scope_route AFTER INSERT OR UPDATE OR DELETE ON "ConnectionScope" FOR EACH ROW EXECUTE FUNCTION nexus_channel_scope_route_sync();')
  sql.push(`UPDATE "ChannelAccountRoute" r SET "destinationIds" = ARRAY(SELECT DISTINCT identifier FROM "ConnectionScope" s CROSS JOIN LATERAL unnest(ARRAY[s."externalId", s.metadata->>'accountId']) identifier WHERE s."connectionId" = r."connectionId" AND s."isActive" AND s.kind = 'profile' AND identifier IS NOT NULL);`)
  sql.push('REVOKE INSERT, UPDATE, DELETE ON "ChannelAccountRoute" FROM nexus_workspace_runtime;')
  sql.push('REVOKE INSERT, UPDATE, DELETE ON "ChannelAccountOwnership" FROM nexus_workspace_runtime;')
  sql.push(readFileSync(new URL('../workspaces/account-assignment.sql', import.meta.url), 'utf8'))
  // BP.S1a — the read-only share. Byte-for-byte the tail of migration
  // 20260916a; kept in one file so the disposable test database and every
  // deployed database cannot disagree about who may read a shared account.
  sql.push(readFileSync(new URL('../workspaces/account-grant.sql', import.meta.url), 'utf8'))
  // BP.S2 — per-person account access. Byte-for-byte the tail of migration 20260916b.
  sql.push(readFileSync(new URL('../workspaces/account-restriction.sql', import.meta.url), 'utf8'))
  // BP.S3 — the listing claim. Byte-for-byte the tail of migration 20260916c.
  sql.push(readFileSync(new URL('../workspaces/listing-claim.sql', import.meta.url), 'utf8'))
  // L1 — membership/role write protection. Byte-for-byte the tail of 20260916d.
  sql.push(readFileSync(new URL('../workspaces/membership-write-guard.sql', import.meta.url), 'utf8'))
  // AE.2 — assortment shares between businesses. Byte-for-byte the tail of 20260916g.
  sql.push(readFileSync(new URL('../workspaces/assortment-share.sql', import.meta.url), 'utf8'))
  // AE.3 — which products a share covers, and catalog links. Byte-for-byte the tail of 20260916h.
  sql.push(readFileSync(new URL('../workspaces/assortment-copy.sql', import.meta.url), 'utf8'))
  // Shared stock (plan 2026-09-19) — the lending permission, product links, work queue and pool doors.
  // Byte-for-byte the tail of 20260919a.
  sql.push(readFileSync(new URL('../workspaces/stock-pool.sql', import.meta.url), 'utf8'))
  sql.push(readFileSync(new URL('../workspaces/order-stock-locks.sql', import.meta.url), 'utf8'))
  sql.push(readFileSync(new URL('../workspaces/order-stock-restore.sql', import.meta.url), 'utf8'))
  // Shared stock step 3 — end times never outlive their mode. Byte-for-byte the tail of 20260919b.
  sql.push(readFileSync(new URL('../workspaces/listing-end-times.sql', import.meta.url), 'utf8'))
  // Shared stock step 6 (AE.4) — live product sync: capture, the change queue, the worker's door.
  // Byte-for-byte the tail of 20260919d.
  sql.push(readFileSync(new URL('../workspaces/assortment-sync.sql', import.meta.url), 'utf8'))
  sql.push(readFileSync(new URL('../workspaces/shopify-colour-sync.sql', import.meta.url), 'utf8'))
  sql.push(readFileSync(new URL('../workspaces/ebay-quarantine.sql', import.meta.url), 'utf8'))
  sql.push(readFileSync(new URL('../workspaces/inbound-history.sql', import.meta.url), 'utf8'))
  sql.push(readFileSync(new URL('../workspaces/ebay-erasure-review.sql', import.meta.url), 'utf8'))
  return sql.join('\n') + '\n' 
}
