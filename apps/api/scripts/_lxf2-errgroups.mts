import { PrismaClient } from '@prisma/client';
const p = new PrismaClient({ datasources: { db: { url: process.argv[2] } } });
const r: any = await p.$queryRawUnsafe(`select current_database() as db`);
let rows = 0, resolved = 0;
try { rows = await (p as any).syncLogErrorGroup.count(); resolved = await (p as any).syncLogErrorGroup.count({ where: { resolutionStatus: 'RESOLVED' } }) } catch (e: any) { console.log('model read failed:', e.message.split('\n')[0]) }
console.log(JSON.stringify({ db: r[0].db, syncLogErrorGroup: rows, resolved }));
await p.$disconnect();
