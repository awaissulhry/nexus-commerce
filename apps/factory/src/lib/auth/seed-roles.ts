/**
 * F1 — idempotent system-role seeding (upsert by key), called on every boot
 * and by scripts/seed.ts. bumpVersions re-resolves everyone immediately.
 */
import { prisma } from "@/lib/db";
import { clearPermissionCache } from "./rbac";
import { SYSTEM_ROLES } from "./permissions";

export async function seedSystemRoles(opts?: { bumpVersions?: boolean }): Promise<void> {
  for (const def of Object.values(SYSTEM_ROLES)) {
    await prisma.role.upsert({
      where: { key: def.key },
      create: {
        key: def.key,
        name: def.name,
        description: def.description,
        permissions: def.permissions,
        isSystem: true,
      },
      update: {
        name: def.name,
        description: def.description,
        permissions: def.permissions,
        isSystem: true,
      },
    });
  }
  if (opts?.bumpVersions) {
    await prisma.user.updateMany({ data: { permissionsVersion: { increment: 1 } } });
    clearPermissionCache();
  }
}
