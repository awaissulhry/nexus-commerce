import { PrismaClient } from '@prisma/client';
const url = process.argv[2];
process.env.DATABASE_URL = url;
const d = new PrismaClient({ datasources: { db: { url } } });
const db: any = await d.$queryRawUnsafe(`select current_database() as db`);
await d.$disconnect();
const { getStudioSheet } = await import('../src/services/pim/studio-sheet.service.js');
const sheet = await getStudioSheet({ productId: 'cmtzci5kf0000njr9f8yhrsxm', scope: 'master', market: 'IT', locale: 'it' });
const row: any = sheet.rows[0];
console.log(JSON.stringify({
  db: db[0].db,
  topLevelKeys: Object.keys(sheet as any).sort(),
  coordinates: ((sheet as any).coordinates ?? (sheet as any).meta?.coordinates ?? []).map((c: any) => `${c.channel}:${c.marketplace}`),
  rowHasReadinessByCoordinate: 'readinessByCoordinate' in row,
  rowReadiness: row.readiness,
  // POSITIVE CONTROL: a field the row really does carry, read the same way.
  rowHasPhotoCount: 'photoCount' in row, photoCount: row.photoCount,
}, null, 2));
