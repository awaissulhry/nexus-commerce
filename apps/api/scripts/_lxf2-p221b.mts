import { PrismaClient } from '@prisma/client';
const url = process.argv[2];
process.env.DATABASE_URL = url;
const disc = new PrismaClient({ datasources: { db: { url } } });
const db: any = await disc.$queryRawUnsafe(`select current_database() as db`);
const gale = await disc.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { version: true } });
if (db[0].db !== 'nexus_development' || gale?.version !== 59) throw new Error(`REFUSED: not the local database (${db[0].db}, gale ${gale?.version})`);
await disc.$disconnect();
const FAMILY = 'cmtzci5kf0000njr9f8yhrsxm';
const { reconcileFamilyReadiness } = await import('../src/services/pim/readiness-index.service.js');
const { catalogLanguageValues } = await import('../src/services/pim/catalog-language.js');
const { default: prisma } = await import('../src/db.js');
const before = await prisma.readinessIndex.count({ where: { productId: FAMILY } });
const t0 = process.hrtime.bigint();
const written = await reconcileFamilyReadiness(FAMILY);
const reconcileMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
await new Promise(r => setTimeout(r, 8500));
const rows = await prisma.readinessIndex.findMany({ where: { productId: FAMILY, channel: null, market: null, accountId: null, aliasId: null }, select: { language: true, sortTitle: true, sortDescription: true, state: true }, orderBy: { language: 'asc' } });
// PARITY: the stored sort key must equal the catalogue's own projection, same resolver, same product+language.
const parity: any[] = [];
for (const row of rows) {
  const values = await catalogLanguageValues([FAMILY], row.language);
  const projected = values.get(FAMILY)!;
  const t = typeof projected.title.value === 'string' && projected.title.value.length ? projected.title.value : null;
  const d = typeof projected.description.value === 'string' && projected.description.value.length ? projected.description.value.slice(0, 512) : null;
  parity.push({ language: row.language, sortTitle: row.sortTitle, projectedTitle: t, titleMatches: row.sortTitle === t, descMatches: row.sortDescription === d });
}
console.log(JSON.stringify({ db: db[0].db, galeVersion: gale?.version, familyRowsBefore: before, written, reconcileMs, readBackAfterMs: 8500, rows: rows.length, parity }, null, 2));
