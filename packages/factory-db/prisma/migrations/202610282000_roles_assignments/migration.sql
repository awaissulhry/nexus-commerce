-- CreateEnum
CREATE TYPE "RoleAudience" AS ENUM ('OFFICE');

-- CreateTable
CREATE TABLE "Role" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "system" BOOLEAN NOT NULL DEFAULT false,
    "basedOn" TEXT,
    "audience" "RoleAudience" NOT NULL DEFAULT 'OFFICE',
    "requireMfa" BOOLEAN NOT NULL DEFAULT false,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "grains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleAssignment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "allCompanies" BOOLEAN NOT NULL DEFAULT false,
    "companyIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "siteIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "partyIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "validFrom" TIMESTAMPTZ(3) NOT NULL,
    "validTo" TIMESTAMPTZ(3),
    "grantedById" UUID,
    "endedAt" TIMESTAMPTZ(3),
    "endedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Role_tenantId_key_key" ON "Role"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Role_tenantId_id_key" ON "Role"("tenantId", "id");

-- CreateIndex
CREATE INDEX "RoleAssignment_tenantId_userId_idx" ON "RoleAssignment"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "RoleAssignment_tenantId_roleId_idx" ON "RoleAssignment"("tenantId", "roleId");

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "Role"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

