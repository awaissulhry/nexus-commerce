import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ConflictError, DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import {
  askProblems,
  fieldHeld,
  missingRow,
  normaliseValue,
  previewRow,
  refusalOfError,
  sameValue,
  type BulkRefusal,
  type BulkResult,
  type BulkRowFacts,
  type BulkValue,
} from '@nexus/factory-domain/views/bulk/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { ApiError } from '../../../core/errors'
import type { z } from 'zod'
import type { applyBulkContract, ApplyBulkBody, previewBulkContract, PreviewBulkBody } from './contract'
import { bulkTargetOf } from './registry'
import { BulkRowRefused, type AnyBulkTarget } from './target'

/**
 * Bulk edit with preview and inline edit (B-W2b-13; PLT-182, PLT-166). The preview reads the asked rows as they are now
 * (the target's own read, the person's scope) and answers old → new per row, or why a row is not changed; nothing is
 * written. The apply writes each asked row through the record's OWN command (the target's write: its permission over
 * the row's company and site, its version check, its audit row, its events), one row after the other; a refused row
 * never stops the others, and nothing half-written is left on a row (each row is its own command). Undo is the same
 * apply with each changed row's earlier values, from the version the change gave it: a row changed again since is
 * refused as stale, never overwritten. One cell edited in the grid is an apply of one row and one field.
 *
 * An Idempotency-Key gives each row's command its own key (`<key>:<row id>`): a repeated apply answers each row from
 * the receipt and writes nothing again.
 */

function officeOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new ApiError('unauthenticated')
  if (context.audience !== 'office') throw new ApiError('forbidden')
  return context
}

/** The list's target, when the person may change its records (its permission over the screen's company). */
function targetFor(caller: CommandCaller, listKey: string): AnyBulkTarget {
  const context = officeOf(caller)
  const target = bulkTargetOf(listKey)
  if (!target) throw new NotFoundError('This list is not edited in bulk.')
  const companyId = context.companyId ?? null
  if (!can(actorOf(context), target.permission, companyId ? { companyId } : {})) throw new ForbiddenError('You may not change the records of this list.')
  return target
}

/** The asked values as written (the field's kind), checked; a money field needs its grain. */
function checkedChanges(caller: CommandCaller, target: AnyBulkTarget, changes: Readonly<Record<string, BulkValue>>, rowCount: number, path: string): { values: Record<string, BulkValue>; issues: Issue[] } {
  const values: Record<string, BulkValue> = {}
  for (const [name, value] of Object.entries(changes)) values[name] = Object.hasOwn(target.fields, name) ? normaliseValue(target.fields[name]!, value) : value
  const issues = askProblems(target.fields, values, rowCount, path)
  if (issues.length === 0) {
    const grains = heldGrains(actorOf(officeOf(caller)))
    for (const name of Object.keys(values)) {
      const held = fieldHeld(target.fields[name]!, grains)
      if (held) throw new ForbiddenError(held)
    }
  }
  return { values, issues }
}

function factsOf(caller: CommandCaller, target: AnyBulkTarget, row: unknown): BulkRowFacts {
  const values: Record<string, BulkValue> = {}
  const held: Record<string, BulkRefusal | null> = { '*': target.rowHeld?.(caller, row) ?? null }
  for (const [name, field] of Object.entries(target.fields)) {
    values[name] = field.read(row)
    held[name] = field.held?.(row) ?? null
  }
  return { id: target.idOf(row), label: target.labelOf(row), version: target.versionOf(row), values, held }
}

type RefusalView = { code: BulkRefusal['code']; field: string | null; status: string | null; reasons?: string[] }
const refusalView = (refusal: BulkRefusal | null): RefusalView | null =>
  refusal ? { code: refusal.code, field: refusal.field ?? null, status: refusal.status ?? null, ...(refusal.reasons ? { reasons: [...refusal.reasons] } : {}) } : null

/** B-W2b-51: a target whose rows are heavy to read reaches fewer rows at once (400 in words). */
function assertRows(target: AnyBulkTarget, count: number, path: string): void {
  if (target.maxRows !== undefined && count > target.maxRows) throw new ValidationError(`Up to ${target.maxRows} rows at once here.`, [{ path, message: `Choose at most ${target.maxRows} rows.` }])
}

/** POST /views/bulk/preview: old → new per row in the order asked; nothing is written. */
export async function previewBulk(caller: CommandCaller, body: PreviewBulkBody): Promise<z.infer<(typeof previewBulkContract.response)[200]>> {
  const target = targetFor(caller, body.listKey)
  assertRows(target, body.ids.length, 'body/ids')
  const { values, issues } = checkedChanges(caller, target, body.changes, body.ids.length, 'body')
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  const rows = await target.load(caller, body.ids)
  const byId = new Map(rows.map((row) => [target.idOf(row), row]))
  return {
    rows: body.ids.map((id) => {
      const row = byId.get(id)
      const preview = row === undefined ? missingRow(id) : previewRow(factsOf(caller, target, row), values)
      return { ...preview, changes: [...preview.changes], refusal: refusalView(preview.refusal) }
    }),
  }
}

/** The kind refusalOfError reads: the domain error's class (a stale version is a conflict), else its name. */
function kindOf(error: unknown): string {
  if (error instanceof ConflictError) return 'ConflictError'
  if (error instanceof InvalidStateError) return 'InvalidStateError'
  if (error instanceof NotFoundError) return 'NotFoundError'
  if (error instanceof ForbiddenError) return 'ForbiddenError'
  if (error instanceof ValidationError) return 'ValidationError'
  if (error instanceof ApiError && error.code === 'forbidden') return 'ForbiddenError'
  return 'Error'
}

/** The field a record's own refusal names: its issue's last path part when that is one of the fields, else the only field asked. */
function fieldOf(error: unknown, fields: readonly string[]): string | null {
  if (error instanceof DomainError) {
    for (const issue of error.issues ?? []) {
      const last = issue.path.split('/').at(-1) ?? ''
      if (fields.includes(last)) return last
    }
  }
  return fields.length === 1 ? fields[0]! : null
}

type ResultView = Omit<BulkResult, 'refusal'> & { refusal: RefusalView | null }

/** POST /views/bulk/apply: each row through the record's own command, in the order asked. */
export async function applyBulk(caller: CommandCaller, body: ApplyBulkBody, idempotencyKey?: string): Promise<z.infer<(typeof applyBulkContract.response)[200]>> {
  const target = targetFor(caller, body.listKey)
  assertRows(target, body.rows.length, 'body/rows')
  const asked = body.rows.map((row, index) => {
    const { values, issues } = checkedChanges(caller, target, row.changes, 1, `body/rows/${index}`)
    return { row, values, issues }
  })
  const issues = asked.flatMap((entry) => entry.issues)
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  const loaded = await target.load(
    caller,
    body.rows.map((row) => row.id),
  )
  const byId = new Map(loaded.map((row) => [target.idOf(row), row]))
  const results: ResultView[] = []
  for (const { row, values } of asked) {
    const current = byId.get(row.id)
    const fields = Object.keys(values)
    if (current === undefined) {
      results.push({ id: row.id, label: '', ok: false, refusal: { code: 'missing', field: null, status: null }, before: {}, after: {}, version: 0 })
      continue
    }
    const facts = factsOf(caller, target, current)
    const before = Object.fromEntries(fields.map((field) => [field, facts.values[field] ?? null]))
    const refused = (refusal: BulkRefusal): ResultView => ({ id: row.id, label: facts.label, ok: false, refusal: refusalView(refusal), before, after: before, version: facts.version })
    const whole = facts.held['*'] ?? null
    if (whole) {
      results.push(refused(whole))
      continue
    }
    const changed = fields.filter((field) => !sameValue(facts.values[field] ?? null, values[field] ?? null))
    const held = changed.map((field) => facts.held[field] ?? null).find((refusal) => refusal !== null) ?? null
    if (held) {
      results.push(refused(held))
      continue
    }
    // Already there on a record whose state keeps the field: nothing to write (its command would refuse the field).
    if (changed.length === 0 && fields.some((field) => facts.held[field])) {
      results.push({ id: row.id, label: facts.label, ok: true, refusal: null, before, after: before, version: facts.version })
      continue
    }
    // Without a key, a version that moved is refused before the command runs (with one, the command's receipt answers
    // a repeated apply first, then checks the version itself).
    if (!idempotencyKey && facts.version !== row.version) {
      results.push(refused({ code: 'stale' }))
      continue
    }
    try {
      const after = await target.write(caller, current, values, row.version, idempotencyKey ? `${idempotencyKey.slice(0, 90)}:${row.id}` : undefined)
      const now = factsOf(caller, target, after)
      results.push({ id: row.id, label: now.label, ok: true, refusal: null, before, after: Object.fromEntries(fields.map((field) => [field, now.values[field] ?? null])), version: now.version })
    } catch (error) {
      // B-W2b-51: a refusal the target words in its own codes, as it is.
      results.push(refused(error instanceof BulkRowRefused ? error.refusal : refusalOfError(kindOf(error), fieldOf(error, fields), target.statusOf?.(current) ?? null)))
    }
  }
  return { results }
}
