import { PrismaClient } from '@prisma/client';
const url = process.argv[2];
process.env.DATABASE_URL = url;
const d = new PrismaClient({ datasources: { db: { url } } });
const db: any = await d.$queryRawUnsafe(`select current_database() as db`);
const filled: any = await d.$queryRawUnsafe(`select count(*)::int total, count("sortTitle")::int with_title from "ReadinessIndex"`);
await d.$disconnect();
const { orderCatalogLanguage } = await import('../src/services/pim/catalog-language.js');
const where = { deletedAt: null } as any;
const runs: any[] = [];
for (const field of ['title', 'description'] as const) for (const direction of ['asc', 'desc'] as const) {
  await orderCatalogLanguage({ language: 'de', languageSort: { field, direction } } as any, where, 0, 50);
  const t0 = process.hrtime.bigint();
  const ids = await orderCatalogLanguage({ language: 'de', languageSort: { field, direction } } as any, where, 0, 50);
  runs.push({ field, direction, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6 * 10) / 10, page: ids.length, firstThree: ids.slice(0, 3) });
}
console.log(JSON.stringify({ db: db[0].db, index: filled[0], runs }, null, 2));
