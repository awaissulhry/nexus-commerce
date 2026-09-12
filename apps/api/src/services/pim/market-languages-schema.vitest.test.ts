/// <reference types="node" />
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, existsSync } from 'node:fs'
import { it, expect } from 'vitest'

it('adds ordered language arrays while preserving all existing values and allowing old writers', async () => {
  const folder = '20260912_lx2_marketplace_languages'
  const shipped = new URL(`../../../../../packages/database/prisma/migrations/${folder}/migration.sql`, import.meta.url)
  const staged = new URL(`../../../../../docs/audits/2026-09-12-language-axis/step2/staged/${folder}/migration.sql`, import.meta.url)
  const db = await PGlite.create()
  try {
    await db.exec(`CREATE TABLE "Marketplace" (id text, channel text, code text, language text, "updatedAt" timestamp);
      INSERT INTO "Marketplace" VALUES ('be','AMAZON','BE','nl','2026-01-01'), ('de','AMAZON','DE','DE','2026-01-02'), ('eb','EBAY','DE','en','2026-01-03');`)
    const before = (await db.query('SELECT * FROM "Marketplace" ORDER BY id')).rows
    await db.exec(readFileSync(existsSync(shipped) ? shipped : staged, 'utf8'))
    expect((await db.query('SELECT id,channel,code,language,"updatedAt" FROM "Marketplace" ORDER BY id')).rows).toEqual(before)
    expect((await db.query('SELECT id,languages FROM "Marketplace" ORDER BY id')).rows).toEqual([
      { id: 'be', languages: ['nl', 'fr'] }, { id: 'de', languages: ['de'] }, { id: 'eb', languages: ['en'] },
    ])
    await db.exec(`INSERT INTO "Marketplace" (id,channel,code,language) VALUES ('new','ETSY','GLOBAL','en'); UPDATE "Marketplace" SET language='fr' WHERE id='new';`)
    expect((await db.query(`SELECT language,languages FROM "Marketplace" WHERE id='new'`)).rows).toEqual([{ language: 'fr', languages: [] }])
    expect((await db.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`)).rows).toEqual([])
  } finally { await db.close() }
}, 30000)
