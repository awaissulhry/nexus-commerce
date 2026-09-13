import { PrismaClient } from '@prisma/client';
const p = new PrismaClient({ datasources: { db: { url: process.argv[2] } } });
const db: any = await p.$queryRawUnsafe(`select current_database() as db, inet_server_port() as port`);
const cols: any = await p.$queryRawUnsafe(`select column_name, data_type, is_nullable from information_schema.columns where table_name = 'ReadinessIndex' and column_name in ('sortTitle','sortDescription','variationSource') order by column_name`);
const idx: any = await p.$queryRawUnsafe(`select indexname, indexdef from pg_indexes where tablename = 'ReadinessIndex' order by indexname`);
const filled: any = await p.$queryRawUnsafe(`select count(*)::int as total, count("sortTitle")::int as with_title, count("sortDescription")::int as with_desc from "ReadinessIndex"`);
console.log(JSON.stringify({ db, cols, idx: idx.map((i: any) => i.indexname), filled }, null, 2));
await p.$disconnect();
