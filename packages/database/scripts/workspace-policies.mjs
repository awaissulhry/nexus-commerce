import { readFileSync } from 'node:fs'

const ownership = JSON.parse(readFileSync(new URL('../workspaces/model-ownership.json', import.meta.url), 'utf8'))
const keys = JSON.parse(readFileSync(new URL('../workspaces/scoped-keys.json', import.meta.url), 'utf8'))
const quote = name => {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid schema identifier: ${name}`)
  return `"${name}"`
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
    `CREATE OR REPLACE FUNCTION nexus_workspace_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
          RAISE EXCEPTION 'Related record is unavailable in this business profile' USING ERRCODE = '23503';
        END IF;
      END LOOP;
      RETURN NEW;
    END $$;`,
  ]
  for (const model of [...ownership.globalModels, ...ownership.workspaceModels]) {
    sql.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${quote(model)} TO nexus_workspace_runtime;`)
  }
  sql.push('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nexus_workspace_runtime;')
  for (const model of ownership.workspaceModels) {
    const table = quote(model)
    const scope = `"workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '')`
    const access = `EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "${model}"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))`
    const condition = model === 'AuditLog'
      ? `((${scope} AND ${access}) OR ("workspaceId" IS NULL AND NULLIF(current_setting('nexus.workspace_id', true), '') IS NULL))`
      : `(${scope} AND ${access})`
    sql.push(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`)
    sql.push(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`)
    sql.push(`DROP POLICY IF EXISTS nexus_workspace_isolation ON ${table};`)
    sql.push(`CREATE POLICY nexus_workspace_isolation ON ${table} FOR ALL TO nexus_workspace_runtime USING (${condition}) WITH CHECK (${condition});`)
    const relations = keys[model].relations.filter(relation => tenantModels.has(relation.model) && relation.from.length === 1 && relation.to.length === 1)
      .map(relation => ({ model: relation.model, from: relation.from[0], to: relation.to[0] }))
    sql.push(`DROP TRIGGER IF EXISTS nexus_workspace_references ON ${table};`)
    sql.push(`CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('${JSON.stringify(relations)}');`)
  }
  sql.push(`CREATE OR REPLACE FUNCTION nexus_channel_route_sync() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN DELETE FROM "ChannelAccountRoute" WHERE "connectionId" = OLD.id; RETURN OLD; END IF;
      IF NEW."externalAccountId" IS NOT NULL THEN
        INSERT INTO "ChannelAccountOwnership" ("channelType", environment, "externalAccountId", "workspaceId")
          VALUES (NEW."channelType", COALESCE(NEW."connectionMetadata"->>'environment', 'production'), NEW."externalAccountId", NEW."workspaceId")
          ON CONFLICT DO NOTHING;
        IF NOT EXISTS (SELECT 1 FROM "ChannelAccountOwnership" WHERE "channelType" = NEW."channelType" AND environment = COALESCE(NEW."connectionMetadata"->>'environment', 'production') AND "externalAccountId" = NEW."externalAccountId" AND "workspaceId" = NEW."workspaceId") THEN
          RAISE EXCEPTION 'This seller account belongs to another business profile' USING ERRCODE = '23505';
        END IF;
      END IF;
      IF NEW."isActive" THEN
        INSERT INTO "ChannelAccountRoute" ("connectionId", "workspaceId", "channelType", "externalAccountId", "destinationIds")
          VALUES (NEW.id, NEW."workspaceId", NEW."channelType", NEW."externalAccountId", ARRAY(
            SELECT DISTINCT identifier FROM "ConnectionScope" s CROSS JOIN LATERAL unnest(ARRAY[s."externalId", s.metadata->>'accountId']) identifier
            WHERE s."connectionId" = NEW.id AND s."isActive" AND s.kind = 'profile' AND identifier IS NOT NULL
          ))
          ON CONFLICT ("connectionId") DO UPDATE SET "workspaceId" = EXCLUDED."workspaceId", "channelType" = EXCLUDED."channelType", "externalAccountId" = EXCLUDED."externalAccountId", "destinationIds" = EXCLUDED."destinationIds";
      ELSE DELETE FROM "ChannelAccountRoute" WHERE "connectionId" = NEW.id; END IF;
      RETURN NEW;
    END $$;`)
  sql.push('DROP TRIGGER IF EXISTS nexus_channel_route ON "ChannelConnection";')
  sql.push('CREATE TRIGGER nexus_channel_route AFTER INSERT OR UPDATE OR DELETE ON "ChannelConnection" FOR EACH ROW EXECUTE FUNCTION nexus_channel_route_sync();')
  sql.push(`INSERT INTO "ChannelAccountOwnership" ("channelType", environment, "externalAccountId", "workspaceId") SELECT DISTINCT "channelType", COALESCE("connectionMetadata"->>'environment', 'production'), "externalAccountId", "workspaceId" FROM "ChannelConnection" WHERE "externalAccountId" IS NOT NULL ON CONFLICT DO NOTHING;`)
  sql.push(`INSERT INTO "ChannelAccountRoute" ("connectionId", "workspaceId", "channelType", "externalAccountId") SELECT id, "workspaceId", "channelType", "externalAccountId" FROM "ChannelConnection" WHERE "isActive" ON CONFLICT ("connectionId") DO NOTHING;`)
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
  return sql.join('\n') + '\n' 
}
