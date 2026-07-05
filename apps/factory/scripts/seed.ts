/**
 * F1 — idempotent seed: system roles, the default price list ("Listino base",
 * FD7's fallback list), the default stage pipeline, and pricing defaults.
 * NO demo data — this platform never presents fake data as real. A separate
 * dev-only faker can exist later behind FACTORY_ALLOW_DEV_SEED.
 */
import { prisma } from "../src/lib/db";
import { seedSystemRoles } from "../src/lib/auth/seed-roles";

const DEFAULT_STAGES = ["CUTTING", "STITCHING", "ASSEMBLY", "QC", "PACKING"];

async function main() {
  await seedSystemRoles({ bumpVersions: true });

  const defaultList = await prisma.priceList.findFirst({ where: { kind: "DEFAULT" } });
  if (!defaultList) {
    await prisma.priceList.create({
      data: { kind: "DEFAULT", name: "Listino base", notes: "Default price list — party lists override sparsely (FD7)." },
    });
  }

  await prisma.appSetting.upsert({
    where: { key: "production.stages" },
    create: { key: "production.stages", value: DEFAULT_STAGES },
    update: {},
  });
  await prisma.appSetting.upsert({
    where: { key: "pricing.defaults" },
    create: { key: "pricing.defaults", value: { marginFloorPct: 20, depositDefaultPct: 30 } },
    update: {},
  });

  const roles = await prisma.role.count();
  const lists = await prisma.priceList.count();
  console.log(`seed: ok — roles=${roles} priceLists=${lists} stages=${DEFAULT_STAGES.join("→")}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error("seed FAILED:", err);
    await prisma.$disconnect();
    process.exit(1);
  });
