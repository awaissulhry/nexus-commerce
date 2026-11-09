import type { Prisma } from '@nexus/factory-db'
import { InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { GRADING_CHANGES, type GradingChange } from '@nexus/factory-domain/inventory/hides/changes'
import {
  gradeChoiceProblem,
  gradingDraftProblems,
  gradingRefusal,
  reasonRequired,
  shadeChoiceProblem,
  shadeGroupsFor,
  type GradingDraft,
} from '@nexus/factory-domain/inventory/hides/grading'
import { INVENTORY_HIDES_MANAGE } from '@nexus/factory-domain/inventory/hides/permissions'
import { activeRules, gradeOfHide, gradesForArticle, shareFor, usableArea, type GradeFacts } from '@nexus/factory-domain/inventory/hides/usable'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { fixed } from '../stock/read-kit'
import type { GradingView } from './contract'
import { cutEntriesOf, gradeRefOf, gradesOf, hideFor, hideHeadOf, HIDE_SELECT, mayAtHide, ruleFactsOf, rulesOf, stockOfHide, toleranceOfLot, type HideData } from './facts'
import { measuresOf, measureViewOf, namesOf } from './measures'

/**
 * A hide's grade, shade group, thickness and defects (B-W2b-94; SCM-250, PRD-031; design warehouse.hides record "Measurements
 * & grade": grade (Listbox of the material's grades) · shade group · thickness mm; "W2b: usable-area estimate per grade";
 * "a change after the first cut asks for a reason"; "read-only for CONSUMED / SCRAPPED"; Changes: "who changed grade or
 * shade, from → to, why"). Office: inventory.stock.view to read, inventory.hides.manage to change.
 *
 *   GET   /inventory/hides/:hideId/grading   the hide's grade (record, or by its W1 text), shade group, thickness, defects,
 *                                            the usable area at its grade and at every grade it may be given, the choices,
 *                                            the latest measure, whether it is read-only or a change needs a reason, and
 *                                            the changes from the audit rows.
 *   PATCH /inventory/hides/:hideId/grading   at the version read, one command() with an Idempotency-Key: the grade as a
 *                                            record WITH its text (gradeId + grade = its code), the shade group WITH its
 *                                            text (shadeGroupId + shade = its label), the thickness, the defects; null
 *                                            clears a record and its text. This is the office route that replaces W1's
 *                                            text-only grading: the database (Hide_grade_shade_check) refuses a text that
 *                                            disagrees with the record, so nothing writes the text alone once a hide has
 *                                            one. The measured area is not here: it never changes (a re-measure and an
 *                                            adjustment move, ./measures.ts).
 */

const SHADE_SELECT = { id: true, itemId: true, itemColourId: true, lotId: true, label: true, outOfShade: true, swatchRef: true, sortOrder: true, active: true } as const satisfies Prisma.ShadeGroupSelect
type ShadeRow = Prisma.ShadeGroupGetPayload<{ select: typeof SHADE_SELECT }>
const shadeViewOf = (row: ShadeRow) => ({ id: row.id, label: row.label, outOfShade: row.outOfShade, swatchRef: row.swatchRef, lotId: row.lotId })
const byShadeOrder = (a: ShadeRow, b: ShadeRow) => a.sortOrder - b.sortOrder || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)

type Reader = Pick<CommandTx, 'leatherGrade' | 'itemGradeRule' | 'shadeGroup' | 'hideMeasure' | 'user' | 'worker' | 'peopleLegalGate' | 'stockMove' | 'cutLog' | 'auditLog' | 'lot' | 'purchasingSettings' | '$queryRaw'>

/** The hide's article: its grades, its rules, the shade groups the hide may be sorted into. */
async function articleFacts(db: Reader, hide: HideData) {
  const grades = await gradesOf(db)
  const rules = activeRules(((await rulesOf(db, [hide.itemId])).get(hide.itemId) ?? []).map(ruleFactsOf))
  const groups = await db.shadeGroup.findMany({ where: { itemId: hide.itemId }, select: SHADE_SELECT })
  return { grades, rules, groups }
}

const GRADED_FIELDS = ['grade', 'shade', 'thicknessMm', 'defects'] as const
const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** What the audit rows of this hide's corrections say: from → to, why, newest first. */
async function changesOf(db: Pick<CommandTx, 'auditLog'>, hideId: string): Promise<GradingView['changes']> {
  const rows = await db.auditLog.findMany({ where: { recordType: 'Hide', recordId: hideId, action: 'inventory.gradeHide' }, orderBy: [{ at: 'desc' }, { id: 'desc' }], select: { at: true, actorId: true, audience: true, before: true, after: true, reason: true }, take: 50 })
  return rows.map((row) => {
    const before = (row.before ?? {}) as Record<string, unknown>
    const after = (row.after ?? {}) as Record<string, unknown>
    const fields = GRADED_FIELDS.filter((field) => textOf(before[field]) !== textOf(after[field]))
    return {
      at: toUtcIso(row.at),
      actorId: row.actorId,
      audience: row.audience,
      from: Object.fromEntries(fields.map((field) => [field, textOf(before[field])])),
      to: Object.fromEntries(fields.map((field) => [field, textOf(after[field])])),
      reason: row.reason,
    }
  })
}

async function viewOf(db: Reader, hide: HideData, context: OfficeContext): Promise<GradingView> {
  const { grades, rules, groups } = await articleFacts(db, hide)
  const stock = await stockOfHide(db, hide.id)
  const measures = (await measuresOf(db, [hide.id])).get(hide.id) ?? []
  const names = await namesOf(db, hide.siteId, measures.slice(0, 1))
  const cutEntries = await cutEntriesOf(db, hide.id)
  const { grade, byText } = gradeOfHide(hide, grades)
  const allowed = gradesForArticle(grades, rules)
  const left = stock.onHand
  const measured = new Dec(hide.baseArea.toString())
  const share = grade ? shareFor(grade, rules) : null
  const facts = { itemId: hide.itemId, lotId: hide.lotId, itemColourId: hide.lot.itemColourId }
  const shade = hide.shadeGroupId ? (groups.find((group) => group.id === hide.shadeGroupId) ?? null) : null
  // The current grade stays a choice even when retired or no longer the article's.
  const choices: GradeFacts[] = grade && !allowed.some((entry) => entry.id === grade.id) ? [grade, ...allowed] : allowed
  return {
    hide: { ...hideHeadOf(hide, left), supplierCode: hide.supplierCode, thicknessMm: hide.thicknessMm === null ? null : hide.thicknessMm.toFixed(2), defects: hide.defects },
    grade: grade ? { ...gradeRefOf(grade), byText } : null,
    gradeText: hide.grade,
    shade: shade ? shadeViewOf(shade) : null,
    shadeText: hide.shade,
    usable: share ? { share: share.share, source: share.source, panels: [...share.panels], measured: fixed(usableArea(measured, share.share)), left: fixed(usableArea(left, share.share)) } : null,
    estimates: choices.map((entry) => {
      const at = shareFor(entry, rules)
      return { gradeId: entry.id, code: entry.code, share: at.share, source: at.source, usable: fixed(usableArea(left, at.share)), current: entry.id === grade?.id }
    }),
    choices: {
      grades: choices.map((entry) => {
        const at = shareFor(entry, rules)
        return { ...gradeRefOf(entry), share: at.share, source: at.source, panels: [...at.panels] }
      }),
      shadeGroups: [...shadeGroupsFor(groups, facts), ...(shade && !shade.active ? [shade] : [])].sort(byShadeOrder).map(shadeViewOf),
    },
    lastMeasure: measures[0] ? measureViewOf(measures[0], hide, names, true, await toleranceOfLot(db, hide.lotId)) : null,
    readOnly: gradingRefusal(hide),
    reasonRequired: reasonRequired({ state: hide.state, cutEntries }),
    canEdit: gradingRefusal(hide) === null && mayAtHide(context, INVENTORY_HIDES_MANAGE, hide),
    changes: await changesOf(db, hide.id),
  }
}

/** GET /inventory/hides/:hideId/grading. */
export async function readGrading(caller: CommandCaller, hideId: string): Promise<GradingView> {
  const { hide, context } = await hideFor(caller, hideId)
  return caller.withClient((client) => viewOf(client, hide, context))
}

export interface CorrectGradingBody extends GradingDraft {
  readonly version: number
}

const refuse = (problems: Issue[], words: string): never => {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
}

interface Resolved {
  readonly data: Prisma.HideUncheckedUpdateInput
  readonly before: Record<(typeof GRADED_FIELDS)[number], string | null> & { gradeId: string | null; shadeGroupId: string | null }
  readonly after: Record<(typeof GRADED_FIELDS)[number], string | null> & { gradeId: string | null; shadeGroupId: string | null }
  readonly changed: GradingChange[]
}

/** The body against the hide and its article's records: the update, from → to, and what changed (refused in words). */
async function resolve(db: Reader, hide: HideData, body: CorrectGradingBody): Promise<Resolved> {
  const refusal = gradingRefusal(hide)
  if (refusal) throw new InvalidStateError(refusal)
  const cutEntries = await cutEntriesOf(db, hide.id)
  const draftProblems = gradingDraftProblems(body, reasonRequired({ state: hide.state, cutEntries }))
  if (draftProblems.length > 0) refuse(draftProblems, 'The change is not valid.')
  const { grades, rules, groups } = await articleFacts(db, hide)
  const problems: Issue[] = []
  const before = { grade: hide.grade, shade: hide.shade, thicknessMm: hide.thicknessMm === null ? null : hide.thicknessMm.toFixed(2), defects: hide.defects, gradeId: hide.gradeId, shadeGroupId: hide.shadeGroupId }
  const after = { ...before }
  const data: Prisma.HideUncheckedUpdateInput = {}
  if (body.gradeId !== undefined) {
    if (body.gradeId === null) {
      Object.assign(after, { gradeId: null, grade: null })
    } else {
      const grade = isUuid(body.gradeId) ? grades.find((entry) => entry.id === body.gradeId) : undefined
      const problem = grade ? gradeChoiceProblem(grade, hide.gradeId, gradesForArticle(grades, rules), hide.lot.item.code) : 'Not a grade of the tenant.'
      if (problem) problems.push({ path: 'gradeId', message: problem })
      else Object.assign(after, { gradeId: grade!.id, grade: grade!.code })
    }
    if (after.gradeId !== before.gradeId || after.grade !== before.grade) Object.assign(data, { gradeId: after.gradeId, grade: after.grade })
  }
  if (body.shadeGroupId !== undefined) {
    if (body.shadeGroupId === null) {
      Object.assign(after, { shadeGroupId: null, shade: hide.shadeGroupId ? null : hide.shade })
    } else {
      // Another article's group is found too, so the answer can say why it does not fit.
      const group = isUuid(body.shadeGroupId) ? (groups.find((entry) => entry.id === body.shadeGroupId) ?? (await db.shadeGroup.findUnique({ where: { id: body.shadeGroupId }, select: SHADE_SELECT })) ?? undefined) : undefined
      const problem = group
        ? shadeChoiceProblem(group, { itemId: hide.itemId, lotId: hide.lotId, itemColourId: hide.lot.itemColourId, shadeGroupId: hide.shadeGroupId, code: hide.code })
        : 'Not a shade group of the tenant.'
      if (problem) problems.push({ path: 'shadeGroupId', message: problem })
      else Object.assign(after, { shadeGroupId: group!.id, shade: group!.label })
    }
    if (after.shadeGroupId !== before.shadeGroupId || after.shade !== before.shade) Object.assign(data, { shadeGroupId: after.shadeGroupId, shade: after.shade })
  }
  if (body.thicknessMm !== undefined) {
    after.thicknessMm = body.thicknessMm === null ? null : new Dec(body.thicknessMm.trim()).toFixed(2)
    if (after.thicknessMm !== before.thicknessMm) data.thicknessMm = after.thicknessMm
  }
  if (body.defects !== undefined) {
    after.defects = body.defects?.trim() || null
    if (after.defects !== before.defects) data.defects = after.defects
  }
  if (problems.length > 0) refuse(problems, 'The change is not valid.')
  const changed = GRADING_CHANGES.filter((change) => {
    if (change === 'GRADE') return after.gradeId !== before.gradeId || after.grade !== before.grade
    if (change === 'SHADE') return after.shadeGroupId !== before.shadeGroupId || after.shade !== before.shade
    if (change === 'THICKNESS') return after.thicknessMm !== before.thicknessMm
    return after.defects !== before.defects
  })
  if (changed.length === 0) refuse([{ path: 'gradeId', message: `Nothing changes: hide ${hide.code} says this already.` }], 'Nothing changes.')
  return { data, before, after, changed }
}

/** PATCH /inventory/hides/:hideId/grading. */
export async function correctGrading(caller: CommandCaller, hideId: string, body: CorrectGradingBody, idempotencyKey?: string): Promise<GradingView> {
  const { hide } = await hideFor(caller, hideId, INVENTORY_HIDES_MANAGE)
  // Checked inside the command only: a repeated request (same Idempotency-Key) answers its receipt before anything is read.
  const { result } = await command(
    caller,
    { name: 'inventory.gradeHide', idempotencyKey, input: { hideId, ...body }, record: { type: 'Hide', id: hide.id, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      const current = await tx.hide.findUniqueOrThrow({ where: { id: hide.id }, select: HIDE_SELECT })
      const { data, before, after, changed } = await resolve(tx, current, body)
      await tx.hide.update({ where: { id: current.id }, data: { ...data, updatedAt: now }, select: { id: true } })
      const reason = body.reason?.trim() || undefined
      tools.audit({
        action: 'inventory.gradeHide',
        recordType: 'Hide',
        recordId: current.id,
        companyId: current.lot.companyId,
        siteId: current.siteId,
        before,
        after,
        ...(reason ? { reason } : {}),
      })
      tools.emit({
        type: 'inventory.hide_graded',
        subject: current.id,
        companyId: current.lot.companyId,
        siteId: current.siteId,
        payload: { hideId: current.id, lotId: current.lotId, itemId: current.itemId, changed, gradeId: after.gradeId, gradeCode: after.gradeId ? after.grade : null, shadeGroupId: after.shadeGroupId, shadeLabel: after.shadeGroupId ? after.shade : null },
      })
      return { hideId: current.id, version: tools.record!.version }
    },
  )
  // Read after the command: its audit row (the Changes) is written with it. A repeated request answers what is there now.
  return readGrading(caller, result.hideId)
}
