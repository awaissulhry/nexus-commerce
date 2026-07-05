/**
 * F1 — idempotent first-OWNER creation/promotion from FACTORY_OWNER_EMAIL
 * (+ optional FACTORY_OWNER_INITIAL_PASSWORD). The password value is NEVER
 * printed. Safe to re-run: existing owner → no-op; existing user → promoted.
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth/password";
import { seedSystemRoles } from "../src/lib/auth/seed-roles";

async function main() {
  const email = process.env.FACTORY_OWNER_EMAIL?.toLowerCase().trim();
  if (!email) {
    console.error("bootstrap-owner: set FACTORY_OWNER_EMAIL in apps/factory/.env first.");
    process.exit(1);
  }
  await seedSystemRoles();
  const ownerRole = await prisma.role.findUniqueOrThrow({ where: { key: "OWNER" } });

  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    const password = process.env.FACTORY_OWNER_INITIAL_PASSWORD;
    if (!password || password.length < 8) {
      console.error(
        "bootstrap-owner: user does not exist yet — set FACTORY_OWNER_INITIAL_PASSWORD (min 8 chars) in apps/factory/.env, run again, then remove it from the file.",
      );
      process.exit(1);
    }
    user = await prisma.user.create({
      data: {
        email,
        displayName: email.split("@")[0],
        passwordHash: hashPassword(password),
      },
    });
    console.log(`bootstrap-owner: created user ${email}`);
  }

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: ownerRole.id } },
    create: { userId: user.id, roleId: ownerRole.id },
    update: {},
  });
  await prisma.user.update({
    where: { id: user.id },
    data: { permissionsVersion: { increment: 1 } },
  });
  console.log(`bootstrap-owner: ${email} is OWNER. (If you set FACTORY_OWNER_INITIAL_PASSWORD, remove it from .env now.)`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error("bootstrap-owner FAILED:", err);
    await prisma.$disconnect();
    process.exit(1);
  });
