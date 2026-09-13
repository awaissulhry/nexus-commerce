import { PrismaClient } from '@prisma/client';
const p = new PrismaClient({ datasources: { db: { url: process.argv[2] } } });
const g = await p.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { id: true, sku: true, version: true } });
const r: any = await p.$queryRawUnsafe(`select current_database() as db`);
console.log(JSON.stringify({ db: r[0].db, gale: g }));
await p.$disconnect();
