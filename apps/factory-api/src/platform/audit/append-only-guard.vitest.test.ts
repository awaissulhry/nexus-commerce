import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// scripts/factory/check-append-only.mjs, proven on plants: each test copies the real schema, ownership and migrations
// into a temporary root, plants one violation, and runs the guard on it.

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url))
const GUARD = join(REPO, 'scripts/factory/check-append-only.mjs')
const MIGRATIONS = 'packages/factory-db/prisma/migrations'
// The hand-written trigger migration, whatever its timestamp (the lead renumbers migrations when merging).
const TRIGGERS = `${MIGRATIONS}/${readdirSync(join(REPO, MIGRATIONS)).find((name) => name.endsWith('_audit_append_only'))}/migration.sql`
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A copy of the factory-db files the guard reads, with the plants written over it. */
function tree(plants: Record<string, string | ((text: string) => string)> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'factory-append-only-'))
  roots.push(root)
  for (const part of ['packages/factory-db/prisma/schema', 'packages/factory-db/prisma/migrations', 'packages/factory-db/ownership']) {
    cpSync(join(REPO, part), join(root, part), { recursive: true })
  }
  for (const [path, plant] of Object.entries(plants)) {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof plant === 'function' ? plant(readFileSync(file, 'utf8')) : plant)
  }
  return root
}

const guard = (root?: string) => {
  const run = spawnSync(process.execPath, [GUARD, ...(root ? [root] : [])], { encoding: 'utf8' })
  return { status: run.status, output: `${run.stdout}${run.stderr}` }
}
const laterMigration = (sql: string) => ({ [`${MIGRATIONS}/209912010000_zz_later/migration.sql`]: sql })

describe('check-append-only', () => {
  it('passes on the repository and on an untouched copy', () => {
    expect(guard()).toMatchObject({ status: 0, output: expect.stringMatching(/ok \(43 append-only model\(s\): AlertEvent, AuditLog, IdempotencyReceipt, NotificationDelivery, MessageMention, WorkOrderCostEntry, FloorSyncEvent, GeneratedDocument, AttentionActionLog, IntegrationCall, StockMove, StockValuation, LinkEvidence, SdiNotification, PaymentAllocation, NumberAllocation, NumberBlockUse, RestoreDrill, ViesCheck, RequirementPegging, StaffNoticeAck, CutLog, CutLogPiece, BundleReprint, OperationScan, WorkerNoticeAck, OperationScanDefect, GarmentLabelPrint, QualityRelease, QualityReleaseReversal, LabResult, ReturnReceipt, RepairStageEvent, QuoteAcceptance, SalesOrderAmendment, Ddt, DdtCancellation, TrackingEvent, PurchaseOrderRevision, PurchaseOrderReminder, SubcontractReceipt, SubcontractReceiptLine, Message/) })
    expect(guard(tree()).status).toBe(0)
  })

  it.each<[string, Record<string, string | ((text: string) => string)>, RegExp]>([
    [
      'a dropped marker on the audit log',
      { 'packages/factory-db/prisma/schema/audit.prisma': (text) => text.replace('/// @append-only\nmodel AuditLog', 'model AuditLog') },
      /model AuditLog must be marked/,
    ],
    [
      'an update grant on the audit log',
      { 'packages/factory-db/ownership/audit.json': (text) => text.replace('"privileges": ["select", "insert"] },\n        "factory_floor', '"privileges": ["select", "insert", "update"] },\n        "factory_floor') },
      /AuditLog is append-only, but factory_runtime is granted update/,
    ],
    [
      'a delete grant on the receipts',
      { 'packages/factory-db/ownership/audit.json': (text) => text.replace(/("IdempotencyReceipt"[\s\S]*?"factory_runtime": \{ "privileges": \["select", "insert")/, '$1, "delete"') },
      /IdempotencyReceipt is append-only, but factory_runtime is granted delete/,
    ],
    [
      'a migration without the row trigger',
      { [TRIGGERS]: (text) => text.replace(/CREATE TRIGGER "AuditLog_append_only"[^;]*;/, '') },
      /AuditLog \("AuditLog"\) has no row trigger BEFORE UPDATE OR DELETE/,
    ],
    [
      'a migration without the truncate trigger',
      { [TRIGGERS]: (text) => text.replace(/CREATE TRIGGER "IdempotencyReceipt_no_truncate"[^;]*;/, '') },
      /IdempotencyReceipt \("IdempotencyReceipt"\) has no statement trigger BEFORE TRUNCATE/,
    ],
    ['a later migration that drops the trigger', laterMigration('DROP TRIGGER "AuditLog_append_only" ON "AuditLog";\n'), /a migration drops trigger AuditLog_append_only/],
    ['a later migration that disables it', laterMigration('ALTER TABLE "AuditLog" DISABLE TRIGGER ALL;\n'), /AuditLog \("AuditLog"\): a migration disables a trigger/],
    [
      'a function redefined so it no longer refuses',
      laterMigration('CREATE OR REPLACE FUNCTION "factory_refuse_audit_change"() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN OLD;\nEND\n$$;\n'),
      /the function factory_refuse_audit_change of trigger AuditLog_append_only does not RAISE EXCEPTION/,
    ],
    ['a dropped function', laterMigration('DROP FUNCTION IF EXISTS "factory_refuse_receipt_change"() CASCADE;\n'), /drops the function factory_refuse_receipt_change/],
    [
      'a new ledger without triggers',
      { 'packages/factory-db/prisma/schema/stock.prisma': '/// A stock move.\n/// @append-only\nmodel StockMove {\n  id String @id @db.Uuid\n  @@map("stock_move")\n}\n' },
      /StockMove \("stock_move"\) has no row trigger/,
    ],
    ['an update call on the delegate', { 'apps/factory-api/src/modules/x/fix.ts': 'await tx.auditLog.update({ where: { id }, data: { reason: "x" } })\n' }, /fix\.ts:1 {2}auditLog\.update\(\) on the append-only AuditLog/],
    ['an upsert of a receipt', { 'packages/factory-db/seed/zz.ts': 'await client.idempotencyReceipt.upsert({})\n' }, /zz\.ts:1 {2}idempotencyReceipt\.upsert\(\)/],
    ['a deleteMany through optional chaining', { 'apps/factory-api/src/core/x.ts': '\n\nawait db?.auditLog?.deleteMany({})\n' }, /x\.ts:3 {2}auditLog\.deleteMany\(\)/],
    ['raw SQL that deletes audit rows', { 'apps/factory-api/src/modules/x/raw.ts': 'await tx.$executeRawUnsafe(\'DELETE FROM "AuditLog" WHERE id = $1\', id)\n' }, /raw\.ts:1 {2}SQL DELETE FROM on the append-only AuditLog/],
    ['raw SQL that updates receipts', { 'packages/factory-domain/src/x.ts': 'const sql = `UPDATE public."IdempotencyReceipt" SET key = $1`\n' }, /x\.ts:1 {2}SQL UPDATE on the append-only IdempotencyReceipt/],
    ['raw SQL that truncates', { 'apps/factory-api/src/x.mjs': 'await client.query("TRUNCATE TABLE \\"AuditLog\\"")\n' }, /SQL TRUNCATE TABLE on the append-only AuditLog/],
  ])('fails on %s', (_label, plants, problem) => {
    const result = guard(tree(plants))
    expect(result.status).toBe(1)
    expect(result.output).toMatch(problem)
  })

  it('leaves inserts, reads, comments and test files alone', () => {
    const result = guard(
      tree({
        'apps/factory-api/src/modules/x/ok.ts': [
          'await tx.auditLog.createMany({ data })',
          'await tx.auditLog.findMany({ where })',
          'await tx.idempotencyReceipt.findFirst({ where })',
          '// never: tx.auditLog.update(...) or DELETE FROM "AuditLog"',
          '/* UPDATE "IdempotencyReceipt" */',
          'const auditLogUpdate = 1',
        ].join('\n'),
        'apps/factory-api/src/modules/x/ok.pg.vitest.test.ts': 'await admin(\'DELETE FROM "AuditLog"\')\nawait tx.auditLog.deleteMany({})\n',
      }),
    )
    expect(result).toMatchObject({ status: 0 })
  })
})
