import { PrismaClient } from '@prisma/client';
import { categorySchemaMarkets } from '../src/services/categories/category-schema-coordinate.js';
const p = new PrismaClient({ datasources: { db: { url: process.argv[2] } } });
const db: any = await p.$queryRawUnsafe(`select current_database() as db`);
const count = (where: any) => p.categorySchema.count({ where: { channel: 'EBAY', ...where } });
const out: any = { db: db[0].db };
// ebay-presentation-order / category-mapping: the caller may hold either spelling.
for (const input of ['IT', 'EBAY_IT']) {
  out[`before_composed_${input}`] = { list: [input, `EBAY_${input}`], rows: await count({ marketplace: { in: [input, `EBAY_${input}`] } }) };
  out[`after_authority_${input}`] = { list: categorySchemaMarkets('EBAY', input), rows: await count({ marketplace: { in: categorySchemaMarkets('EBAY', input) } }) };
}
// schema-sync-bridge: verbatim single value vs the authority's read set.
out.bridge_before_verbatim_IT = await count({ marketplace: 'IT' });
out.bridge_before_verbatim_EBAY_IT = await count({ marketplace: 'EBAY_IT' });
out.bridge_after = await count({ marketplace: { in: categorySchemaMarkets('EBAY', 'IT') } });
// positive control: a market the table has only one spelling of must not gain rows.
out.control_UK_before = await count({ marketplace: 'UK' });
out.control_UK_after = await count({ marketplace: { in: categorySchemaMarkets('EBAY', 'UK') } });
console.log(JSON.stringify(out, null, 2));
await p.$disconnect();
