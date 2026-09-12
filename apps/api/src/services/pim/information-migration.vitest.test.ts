import { expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
const migration = new URL('../../../../../packages/database/prisma/migrations/20260911020000_information_formula_destination/migration.sql', import.meta.url)
const setup = async () => {
  const db = await PGlite.create()
  await db.exec(`CREATE TABLE "CellFormula" ("workspaceId" text, "productId" text, scope text, channel text, marketplace text, locale text, "fieldKey" text);
    CREATE TABLE "ChannelConnection" (id text, "workspaceId" text, "channelType" text, "isActive" boolean, "isPrimary" boolean);
    INSERT INTO "CellFormula" VALUES ('w','p','channel','ETSY','GLOBAL','de','title'), ('w','p','master','','','it','brand');`)
  return db
}
it('binds legacy formulas once to an unambiguous account while leaving canonical formulas unscoped', async () => {
  const db = await setup()
  try {
    await db.exec(`INSERT INTO "ChannelConnection" VALUES ('a','w','ETSY',true,true),('b','w','ETSY',true,false)`)
    await db.exec(await readFile(migration, 'utf8'))
    expect((await db.query(`SELECT scope, "channelConnectionId", "aliasKey" FROM "CellFormula" ORDER BY scope`)).rows).toEqual([{ scope: 'channel', channelConnectionId: 'a', aliasKey: '' }, { scope: 'master', channelConnectionId: '', aliasKey: '' }])
    await db.exec(`INSERT INTO "CellFormula" VALUES ('w','p','channel','ETSY','GLOBAL','de','title','b','named')`)
    expect((await db.query('SELECT count(*)::int AS count FROM "CellFormula"')).rows).toEqual([{ count: 3 }])
  } finally { await db.close() }
})
it('rolls back the additive migration if an old formula has no attributable account', async () => {
  const db = await setup()
  try {
    await db.exec(`INSERT INTO "ChannelConnection" VALUES ('a','w','ETSY',true,false),('b','w','ETSY',true,false)`)
    await expect(db.exec(await readFile(migration, 'utf8'))).rejects.toThrow('unambiguous')
    await db.exec('ROLLBACK')
    expect((await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'CellFormula' AND column_name = 'channelConnectionId'`)).rows).toEqual([])
  } finally { await db.close() }
})
