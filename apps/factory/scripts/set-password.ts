/**
 * F1 — set/rotate a user's password locally (no email loop exists yet; FP11
 * adds invitations UI). Reads FACTORY_USER_EMAIL + FACTORY_NEW_PASSWORD from
 * the environment for one run; values are never printed. Revokes all of the
 * user's sessions afterwards.
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth/password";

async function main() {
  const email = process.env.FACTORY_USER_EMAIL?.toLowerCase().trim();
  const password = process.env.FACTORY_NEW_PASSWORD;
  if (!email || !password || password.length < 8) {
    console.error(
      "set-password: run as FACTORY_USER_EMAIL=you@example.com FACTORY_NEW_PASSWORD='new password (min 8)' npm run -w @nexus/factory exec tsx scripts/set-password.ts",
    );
    process.exit(1);
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`set-password: no user ${email}`);
    process.exit(1);
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: hashPassword(password), failedLoginCount: 0, lockedUntil: null },
  });
  await prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
  console.log(`set-password: updated for ${email}; all sessions revoked — sign in again.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error("set-password FAILED:", err);
    await prisma.$disconnect();
    process.exit(1);
  });
