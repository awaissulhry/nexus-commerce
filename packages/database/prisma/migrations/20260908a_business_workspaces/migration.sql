BEGIN;
-- AlterTable
ALTER TABLE "AccountSettings" ADD COLUMN     "workspaceId" TEXT;

-- AlterTable
ALTER TABLE "ChannelConnection" ADD COLUMN     "workspaceId" TEXT;

-- AlterTable
ALTER TABLE "OAuthSession" ADD COLUMN     "workspaceId" TEXT;

-- CreateTable
CREATE TABLE "Workspace" (
    "isLegacy" BOOLEAN NOT NULL DEFAULT false,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdByUserId" TEXT NOT NULL,
    "creationKey" TEXT NOT NULL,
    "creationFingerprint" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Role" ADD COLUMN "workspaceId" TEXT, ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
CREATE INDEX "Role_workspaceId_idx" ON "Role" ("workspaceId");
ALTER TABLE "Role" ADD CONSTRAINT "Role_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" (id) ON DELETE RESTRICT;

-- CreateTable
CREATE TABLE "WorkspaceMembership" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMemberRole" (
    "membershipId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,

    CONSTRAINT "WorkspaceMemberRole_pkey" PRIMARY KEY ("membershipId","roleId")
);

-- CreateTable
CREATE TABLE "WorkspaceInvitation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "roleIds" TEXT[],
    "tokenHash" TEXT NOT NULL,
    "invitedByUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceAudit" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "targetId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Workspace_status_createdAt_idx" ON "Workspace"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_createdByUserId_creationKey_key" ON "Workspace"("createdByUserId", "creationKey");

-- CreateIndex
CREATE INDEX "WorkspaceMembership_userId_status_idx" ON "WorkspaceMembership"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMembership_workspaceId_userId_key" ON "WorkspaceMembership"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "WorkspaceMemberRole_roleId_idx" ON "WorkspaceMemberRole"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceInvitation_tokenHash_key" ON "WorkspaceInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "WorkspaceInvitation_workspaceId_email_idx" ON "WorkspaceInvitation"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "WorkspaceAudit_workspaceId_createdAt_idx" ON "WorkspaceAudit"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AccountSettings_workspaceId_key" ON "AccountSettings"("workspaceId");

-- CreateIndex
CREATE INDEX "ChannelConnection_workspaceId_channelType_idx" ON "ChannelConnection"("workspaceId", "channelType");

-- CreateIndex
CREATE INDEX "OAuthSession_workspaceId_idx" ON "OAuthSession"("workspaceId");

-- AddForeignKey
ALTER TABLE "AccountSettings" ADD CONSTRAINT "AccountSettings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelConnection" ADD CONSTRAINT "ChannelConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMembership" ADD CONSTRAINT "WorkspaceMembership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMembership" ADD CONSTRAINT "WorkspaceMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMemberRole" ADD CONSTRAINT "WorkspaceMemberRole_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "WorkspaceMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMemberRole" ADD CONSTRAINT "WorkspaceMemberRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInvitation" ADD CONSTRAINT "WorkspaceInvitation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceAudit" ADD CONSTRAINT "WorkspaceAudit_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Preserve the existing single-business population. Refuse ambiguous settings instead
-- of choosing whichever row happens to come first. An empty installation is populated
-- through authenticated profile creation after its first login identity is provisioned.
DO $$
DECLARE owner_id text; settings_count bigint; existing_name text;
BEGIN
  IF EXISTS (SELECT 1 FROM "UserRole" WHERE "channelScope" IS NOT NULL AND "channelScope" NOT IN ('null'::jsonb, '{}'::jsonb))
     OR EXISTS (SELECT 1 FROM "Invitation" WHERE "channelScope" IS NOT NULL AND "channelScope" NOT IN ('null'::jsonb, '{}'::jsonb) AND "acceptedAt" IS NULL AND "revokedAt" IS NULL AND "expiresAt" > CURRENT_TIMESTAMP) THEN
    RAISE EXCEPTION 'Scoped account assignments need explicit migration before business profiles can be enabled; permissions must not be broadened';
  END IF;
  SELECT COUNT(*) INTO settings_count FROM "AccountSettings";
  IF settings_count > 1 THEN
    RAISE EXCEPTION 'Workspace migration needs an explicit assignment for multiple AccountSettings rows';
  END IF;
  SELECT u.id INTO owner_id FROM "UserProfile" u
    JOIN "UserRole" ur ON ur."userId" = u.id JOIN "Role" r ON r.id = ur."roleId"
    WHERE u.status = 'active' AND r.key = 'OWNER' ORDER BY u."createdAt", u.id LIMIT 1;
  IF owner_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM "ChannelConnection") OR EXISTS (SELECT 1 FROM "Product") OR settings_count > 0 THEN
      RAISE EXCEPTION 'Workspace migration requires an active existing owner before assigning business data';
    END IF;
    RETURN;
  END IF;
  SELECT NULLIF(BTRIM("businessName"), '') INTO existing_name FROM "AccountSettings";
  INSERT INTO "Workspace" (id, name, status, version, "isLegacy", "createdByUserId", "creationKey", "createdAt", "updatedAt")
    VALUES ('nexus_legacy_workspace', COALESCE(existing_name, 'Existing business'), 'active', 1, true, owner_id,
      'legacy-migration-20260908', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, version, "createdAt", "updatedAt")
    SELECT 'legacy_member_' || u.id, 'nexus_legacy_workspace', u.id, 'active', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM "UserProfile" u WHERE u.status = 'active' AND EXISTS (SELECT 1 FROM "UserRole" ur WHERE ur."userId" = u.id);
  INSERT INTO "WorkspaceMemberRole" ("membershipId", "roleId")
    SELECT m.id, ur."roleId" FROM "WorkspaceMembership" m JOIN "UserRole" ur ON ur."userId" = m."userId"
    WHERE m."workspaceId" = 'nexus_legacy_workspace';
  INSERT INTO "WorkspaceInvitation" (id, "workspaceId", email, "roleIds", "tokenHash", "invitedByUserId", "expiresAt", "createdAt")
    SELECT 'legacy_' || i.id, 'nexus_legacy_workspace', LOWER(i.email), ARRAY[i."roleId"], i."tokenHash", i."invitedByUserId", i."expiresAt", i."createdAt"
    FROM "Invitation" i WHERE i."acceptedAt" IS NULL AND i."revokedAt" IS NULL AND i."expiresAt" > CURRENT_TIMESTAMP;
  UPDATE "AccountSettings" SET "workspaceId" = 'nexus_legacy_workspace';
  IF settings_count = 0 THEN
    INSERT INTO "AccountSettings" (id, "workspaceId", "businessName", "updatedAt")
      VALUES ('legacy_account_settings', 'nexus_legacy_workspace', COALESCE(existing_name, 'Existing business'), CURRENT_TIMESTAMP);
  END IF;
  UPDATE "ChannelConnection" SET "workspaceId" = 'nexus_legacy_workspace';
  UPDATE "Role" SET "workspaceId" = 'nexus_legacy_workspace' WHERE "isSystem" = false;
  UPDATE "OAuthSession" SET "expiresAt" = LEAST("expiresAt", CURRENT_TIMESTAMP) WHERE "workspaceId" IS NULL;
  INSERT INTO "WorkspaceAudit" (id, "workspaceId", "actorUserId", action, metadata)
    VALUES ('legacy_workspace_migration', 'nexus_legacy_workspace', owner_id, 'workspace.migrated',
      jsonb_build_object('accounts', (SELECT COUNT(*) FROM "ChannelConnection"), 'memberships',
        (SELECT COUNT(*) FROM "WorkspaceMembership" WHERE "workspaceId" = 'nexus_legacy_workspace')));
END $$;

CREATE UNIQUE INDEX "Workspace_single_legacy_key" ON "Workspace" ("isLegacy") WHERE "isLegacy" = true;
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_status_check" CHECK (status IN ('active', 'archived'));
ALTER TABLE "WorkspaceMembership" ADD CONSTRAINT "WorkspaceMembership_status_check" CHECK (status IN ('active', 'revoked'));
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_name_check" CHECK (length(btrim(name)) BETWEEN 2 AND 80);

ALTER TABLE "OAuthSession" ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'production';
CREATE TABLE "ChannelAccountRoute" ("connectionId" TEXT PRIMARY KEY REFERENCES "ChannelConnection"(id) ON DELETE CASCADE ON UPDATE CASCADE, "workspaceId" TEXT NOT NULL REFERENCES "Workspace"(id) ON DELETE RESTRICT ON UPDATE CASCADE, "channelType" TEXT NOT NULL, "externalAccountId" TEXT);
CREATE INDEX "ChannelAccountRoute_channelType_externalAccountId_idx" ON "ChannelAccountRoute" ("channelType", "externalAccountId");
CREATE INDEX "ChannelAccountRoute_workspaceId_idx" ON "ChannelAccountRoute" ("workspaceId");

ALTER TABLE "Workspace" ADD COLUMN "automationResumedAt" TIMESTAMP(3);

ALTER TABLE "ChannelAccountRoute" ADD COLUMN "destinationIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
CREATE INDEX "ChannelAccountRoute_destinationIds_idx" ON "ChannelAccountRoute" USING GIN ("destinationIds");

CREATE TABLE "ChannelAccountOwnership" ("channelType" TEXT NOT NULL, "environment" TEXT NOT NULL DEFAULT 'production', "externalAccountId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL REFERENCES "Workspace"(id) ON DELETE RESTRICT ON UPDATE CASCADE, PRIMARY KEY ("channelType", "environment", "externalAccountId"));
CREATE INDEX "ChannelAccountOwnership_workspaceId_idx" ON "ChannelAccountOwnership" ("workspaceId");
COMMIT;
