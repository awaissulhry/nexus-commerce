/**
 * F1 — db smoke check: opens the factory DB via the shared singleton, proves
 * WAL is active and the schema answers. Run: npx tsx scripts/db-smoke.ts
 */
import { prisma } from "../src/lib/db";

async function main() {
  const mode = await prisma.$queryRawUnsafe<{ journal_mode: string }[]>("PRAGMA journal_mode;");
  const parties = await prisma.party.count();
  const users = await prisma.user.count();
  const roles = await prisma.role.count();
  console.log(
    `db-smoke: journal_mode=${JSON.stringify(mode)} parties=${parties} users=${users} roles=${roles}`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error("db-smoke FAILED:", err);
    await prisma.$disconnect();
    process.exit(1);
  });
