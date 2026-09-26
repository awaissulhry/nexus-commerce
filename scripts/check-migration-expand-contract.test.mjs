// Self-test for scripts/check-migration-expand-contract.mjs — every rule must be able to go red.
//   node --test scripts/check-migration-expand-contract.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { destructive, hasContractHeader, statements } from './check-migration-expand-contract.mjs'

test('additive migrations pass', () => {
  assert.deepEqual(destructive(`
    -- AlterTable
    ALTER TABLE "Product" ADD COLUMN "note" TEXT;
    ALTER TABLE "Product" ADD COLUMN "flag" BOOLEAN NOT NULL DEFAULT false;
    CREATE TABLE "Thing" ("id" TEXT NOT NULL, CONSTRAINT "Thing_pkey" PRIMARY KEY ("id"));
    CREATE INDEX "Thing_idx" ON "Thing"("id");
    ALTER TYPE "Channel" ADD VALUE 'ETSY';
  `), [])
})

test('each contracting statement is caught', () => {
  const cases = {
    'DROP TABLE': 'DROP TABLE "Old";',
    'DROP COLUMN': 'ALTER TABLE "Product" DROP COLUMN "legacy";',
    'RENAME': 'ALTER TABLE "Product" RENAME COLUMN "a" TO "b";',
    'ALTER COLUMN … TYPE': 'ALTER TABLE "Product" ALTER COLUMN "price" SET DATA TYPE DECIMAL(12,2);',
    'SET NOT NULL': 'ALTER TABLE "Product" ALTER COLUMN "sku" SET NOT NULL;',
    'DROP TYPE': 'DROP TYPE "Old";',
    'ADD COLUMN … NOT NULL without DEFAULT': 'ALTER TABLE "Product" ADD COLUMN "must" TEXT NOT NULL;',
  }
  for (const [rule, sql] of Object.entries(cases)) {
    const found = destructive(sql)
    assert.ok(found.some(f => f.startsWith(`${rule}:`)), `${rule} not caught in: ${sql} → ${JSON.stringify(found)}`)
  }
})

test('comments do not trigger or hide a rule', () => {
  assert.deepEqual(destructive('-- DROP TABLE "x";\nALTER TABLE "a" ADD COLUMN "b" TEXT;'), [])
  assert.equal(destructive('/* note */ DROP TABLE "x";').length, 1)
  assert.equal(statements('a; -- b;\n c;').length, 2)
})

test('the contract header must name the expand and the commit', () => {
  assert.ok(hasContractHeader('-- contract: expands in 20260901a_add_x, readers removed in 1a2b3c4d\nDROP TABLE "x";'))
  assert.ok(!hasContractHeader('-- contract: trust me\nDROP TABLE "x";'))
  assert.ok(!hasContractHeader('DROP TABLE "x";'))
})
