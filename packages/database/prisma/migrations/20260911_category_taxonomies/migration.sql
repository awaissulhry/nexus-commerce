BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE "MarketplaceTaxonomy" (
  "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
  "id" TEXT PRIMARY KEY, "channel" TEXT NOT NULL, "marketplace" TEXT NOT NULL,
  "activeSnapshotId" TEXT, "requestVersion" INTEGER NOT NULL DEFAULT 0,
  "completedRequestVersion" INTEGER NOT NULL DEFAULT 0, "schemaRequests" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "nextSyncAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "leaseToken" TEXT, "leaseUntil" TIMESTAMP(3),
  "retryAt" TIMESTAMP(3), "lastSyncedAt" TIMESTAMP(3), "lastError" TEXT, "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "MarketplaceTaxonomy_workspaceId_channel_marketplace_key" ON "MarketplaceTaxonomy" ("workspaceId", "channel", "marketplace");
CREATE INDEX "MarketplaceTaxonomy_workspaceId_nextSyncAt_idx" ON "MarketplaceTaxonomy" ("workspaceId", "nextSyncAt");
CREATE TABLE "MarketplaceTaxonomySnapshot" (
  "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
  "id" TEXT PRIMARY KEY, "sourceId" TEXT NOT NULL REFERENCES "MarketplaceTaxonomy"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "status" TEXT NOT NULL, "providerVersion" TEXT, "contentHash" TEXT,
  "nodeCount" INTEGER NOT NULL DEFAULT 0, "addedCount" INTEGER NOT NULL DEFAULT 0,
  "removedCount" INTEGER NOT NULL DEFAULT 0, "changedCount" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3)
);
CREATE INDEX "MarketplaceTaxonomySnapshot_workspaceId_sourceId_createdAt_idx" ON "MarketplaceTaxonomySnapshot" ("workspaceId", "sourceId", "createdAt");
CREATE TABLE "MarketplaceTaxonomyNode" (
  "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
  "id" TEXT PRIMARY KEY, "snapshotId" TEXT NOT NULL REFERENCES "MarketplaceTaxonomySnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "externalId" TEXT NOT NULL, "parentId" TEXT, "name" TEXT NOT NULL, "path" TEXT NOT NULL,
  "assignable" BOOLEAN NOT NULL, "metadata" JSONB NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX "MarketplaceTaxonomyNode_workspaceId_snapshotId_externalId_key" ON "MarketplaceTaxonomyNode" ("workspaceId", "snapshotId", "externalId");
CREATE INDEX "MarketplaceTaxonomyNode_workspaceId_snapshotId_parentId_idx" ON "MarketplaceTaxonomyNode" ("workspaceId", "snapshotId", "parentId");
CREATE INDEX "MarketplaceTaxonomyNode_path_search_idx" ON "MarketplaceTaxonomyNode" USING gin ("path" gin_trgm_ops);
CREATE INDEX "MarketplaceTaxonomyNode_externalId_search_idx" ON "MarketplaceTaxonomyNode" USING gin ("externalId" gin_trgm_ops);

-- Mirror the business-profile isolation of existing catalog models.
DO $$ DECLARE table_name TEXT; reference_config TEXT; BEGIN
  FOREACH table_name IN ARRAY ARRAY['MarketplaceTaxonomy', 'MarketplaceTaxonomySnapshot', 'MarketplaceTaxonomyNode'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO nexus_workspace_runtime', table_name);
    EXECUTE format('CREATE POLICY nexus_workspace_isolation ON %I FOR ALL TO nexus_workspace_runtime USING ("workspaceId" = NULLIF(current_setting(''nexus.workspace_id'', true), '''') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "workspaceId" AND w.status = ''active'' AND (NULLIF(current_setting(''nexus.actor_id'', true), '''') IS NULL OR EXISTS (SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId" WHERE m."workspaceId" = w.id AND m."userId" = current_setting(''nexus.actor_id'', true) AND m.status = ''active'' AND u.status = ''active''))))', table_name);
    reference_config := CASE table_name WHEN 'MarketplaceTaxonomySnapshot' THEN '[{"model":"MarketplaceTaxonomy","from":"sourceId","to":"id"}]' WHEN 'MarketplaceTaxonomyNode' THEN '[{"model":"MarketplaceTaxonomySnapshot","from":"snapshotId","to":"id"}]' ELSE '[]' END;
    EXECUTE format('CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard(%L)', table_name, reference_config);
  END LOOP;
END $$;
-- An active revision must be complete and belong to this exact business/channel/market source.
CREATE FUNCTION nexus_taxonomy_active_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."activeSnapshotId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "MarketplaceTaxonomySnapshot" s WHERE s.id = NEW."activeSnapshotId"
      AND s."sourceId" = NEW.id AND s."workspaceId" = NEW."workspaceId" AND s.status = 'SUCCEEDED'
  ) THEN RAISE EXCEPTION 'Taxonomy revision is incomplete or belongs to a different source' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nexus_taxonomy_active_revision BEFORE INSERT OR UPDATE OF "activeSnapshotId" ON "MarketplaceTaxonomy"
  FOR EACH ROW EXECUTE FUNCTION nexus_taxonomy_active_revision_guard();
COMMIT;
