/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'

const migration = (folder: string) => readFileSync(new URL(`../../../../../packages/database/prisma/migrations/${folder}/migration.sql`, import.meta.url), 'utf8')
const original = migration('20260912_lx1_translation_store')
const reversal = migration('20260912_lx1_remove_legacy_content_guard')
let db: PGlite
let before: unknown

beforeAll(async () => {
  db = await PGlite.create()
  await db.exec(`CREATE TABLE "Product" (id text PRIMARY KEY, name text, "localizedContent" jsonb NOT NULL DEFAULT '{"en":{},"it":{}}');
    CREATE TABLE "ProductTranslation" (id text PRIMARY KEY, "productId" text, language text, name text, "reviewedAt" timestamp, "updatedAt" timestamp);
    INSERT INTO "Product" VALUES ('p','Source','{"de":{"title":"Existing legacy text"}}');
    INSERT INTO "ProductTranslation" VALUES ('t','p','en','Existing translation','2026-01-02','2026-01-03');`)
  before = (await db.query('SELECT * FROM "ProductTranslation"')).rows
  await db.exec(original)
  await db.exec(reversal)
}, 30000)
afterAll(async () => { await db?.close() })

describe('LX.1 additive columns with deployed legacy writers preserved', () => {
  it('adds exactly the four typed columns with the specified defaults', async () => {
    expect((await db.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name='ProductTranslation'
      AND column_name IN ('attributes','sourceHash','authoredAt','version') ORDER BY column_name`)).rows).toEqual([
      { column_name: 'attributes', data_type: 'jsonb', is_nullable: 'NO' },
      { column_name: 'authoredAt', data_type: 'timestamp without time zone', is_nullable: 'YES' },
      { column_name: 'sourceHash', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'version', data_type: 'integer', is_nullable: 'NO' },
    ])
    expect((await db.query('SELECT attributes, "sourceHash", "authoredAt", version FROM "ProductTranslation"')).rows).toEqual([{ attributes: {}, sourceHash: null, authoredAt: null, version: 0 }])
  })
  it('preserves every existing translation value and legacy JSON byte representation', async () => {
    expect((await db.query('SELECT id, "productId", language, name, "reviewedAt", "updatedAt" FROM "ProductTranslation"')).rows).toEqual(before)
    expect((await db.query('SELECT "localizedContent" FROM "Product" WHERE id=\'p\'')).rows).toEqual([{ localizedContent: { de: { title: 'Existing legacy text' } } }])
  })
  it('removes the premature database trigger and function', async () => {
    expect((await db.query(`SELECT tgname FROM pg_trigger WHERE tgrelid='"Product"'::regclass AND tgname='Product_localizedContent_readonly'`)).rows).toEqual([])
    expect((await db.query("SELECT proname FROM pg_proc WHERE proname='nexus_lx1_legacy_content_readonly'")).rows).toEqual([])
  })
  it('permits legacy media and translation updates, and clearing the bag', async () => {
    for (const value of [{ en: { _productMedia: { version: 1, items: [] } } }, { de: { title: 'Changed' } }, {}]) {
      await db.query('UPDATE "Product" SET "localizedContent"=$1 WHERE id=$2', [value, 'p'])
      expect((await db.query('SELECT "localizedContent" FROM "Product" WHERE id=$1', ['p'])).rows[0]).toEqual({ localizedContent: value })
    }
  })
  it('allows unchanged JSON and ordinary native fields in a disposable fixture', async () => {
    await db.query('UPDATE "Product" SET "localizedContent"="localizedContent", name=\'Edited source\' WHERE id=\'p\'')
    expect((await db.query('SELECT name FROM "Product" WHERE id=\'p\'')).rows[0]).toEqual({ name: 'Edited source' })
  })
  it('preserves creation with populated JSON and the existing empty defaults', async () => {
    await db.query('INSERT INTO "Product" (id,"localizedContent") VALUES ($1,$2)', ['new-text', { de: { title: 'New text' } }])
    await db.query('INSERT INTO "Product" (id) VALUES (\'new-default\')')
    await db.query('INSERT INTO "Product" (id,"localizedContent") VALUES (\'new-empty\',\'{}\')')
    expect((await db.query('SELECT count(*)::int AS n FROM "Product"')).rows[0]).toEqual({ n: 4 })
  })
})
