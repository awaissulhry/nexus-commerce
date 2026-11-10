import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { PRODUCT_BOM_MANAGE } from '@nexus/factory-domain/product/bom/permissions'
import type { AddAlternateBody, BomDepthView, OrderAlternatesBody, UpdateAlternateBody } from '@nexus/factory-domain/product/bom-lines/contracts'
import { alternateProblems, certificateCheckRequired, MAX_ALTERNATES, nextPriority, orderProblems, prioritiesOf, type AlternateDraft } from '@nexus/factory-domain/product/bom-lines/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { assertMayWrite, contextOf, lockDraft, lockMaterials, readRevisionFor, type LockedDraft } from '../bom/store'
import { alternateLineOf, depthInTx, guarded, invalid, lineFor, prefixed, readAlternates, readItems, recordChange, type AlternateRecord, type DepthLine } from './store'

/**
 * A draft line's alternates (B-W2b-228; PRD-083; design styles.bomLine "Alternates (W2b)", style.bom.lines "Alternates"):
 * added after the last, changed, removed (the rest close up: priorities stay 1..n) and put in a new order. Every write sends
 * the revision's version and starts as W1's line writes do (product/bom store `lockDraft`: the style row FOR UPDATE, the
 * revision a DRAFT of a style not archived, B-W2b-221's edit rule DRAFT, the version compared and set), then holds the
 * line's material and the alternate's FOR SHARE, then writes. Every rule of the database (…_bom_options_w2b_guards
 * `BomLineAlternate_shape`) is said in words first (factory-domain product/bom-lines `alternateProblems`, 400): not the line's
 * own material, each once, not archived or blocked when newly named, of the style's company, counted in the line's unit,
 * its colour its own, a certificate check whenever a PPE component is involved (left out: switched on by itself, never
 * off). Audit rows on the alternate and on the revision; W1's `style.bom_changed` with the line.
 */

const FIELDS = ['itemId', 'itemColourId', 'qty', 'allowedWhen', 'certificateCheck', 'note'] as const satisfies readonly (keyof AlternateDraft)[]
const AUDITED = ['priority', ...FIELDS] as const
const audited = (row: Pick<AlternateRecord, (typeof AUDITED)[number]>): Record<string, unknown> => Object.fromEntries(AUDITED.map((field) => [field, row[field]]))

const createdByOf = (tools: CommandTools): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

function alternateOf(alternates: readonly AlternateRecord[], alternateId: string): AlternateRecord {
  const found = isUuid(alternateId) ? alternates.find((alternate) => alternate.id === alternateId) : undefined
  if (!found) throw new NotFoundError('Alternate not found on this line.')
  return found
}

/**
 * Both materials held FOR SHARE and read, the alternate built (`build` is told whether a PPE component is involved: the
 * certificate check's default), then checked against the rules (400 in words).
 */
async function plan(
  tools: CommandTools,
  draft: LockedDraft,
  line: DepthLine,
  itemId: string,
  build: (certificateRequired: boolean) => AlternateDraft,
  others: readonly AlternateRecord[],
  fresh: { material: boolean; colour: boolean },
): Promise<AlternateDraft> {
  await lockMaterials(tools.tx, [line.itemId, itemId])
  const items = await readItems(tools.tx, [line.itemId, itemId])
  const lineFacts = alternateLineOf(line, items.get(line.itemId))
  const material = items.get(itemId)
  const next = build(material ? certificateCheckRequired(lineFacts, material) : false)
  const issues = alternateProblems(lineFacts, next, material, others, { companyId: draft.style.companyId, fresh })
  if (issues.length > 0) throw invalid(prefixed(issues), 'alternate')
  return next
}

/** product.bomLines.addAlternate: an alternate after the line's last. */
export async function addAlternate(caller: CommandCaller, styleId: string, revisionId: string, lineId: string, body: AddAlternateBody, idempotencyKey?: string): Promise<BomDepthView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_MANAGE, style.companyId)

  const { result } = await guarded(() =>
    command(caller, { name: 'product.bomLines.addAlternate', idempotencyKey, input: { styleId, revisionId, lineId, ...body } }, async (tools) => {
      const { tx, now } = tools
      const draft = await lockDraft(tools, styleId, revisionId, body.version)
      const line = await lineFor(tx, revisionId, lineId)
      const others = await readAlternates(tx, revisionId, line.id)
      if (others.length >= MAX_ALTERNATES) throw invalid([{ path: 'body', message: `Line ${line.seq} has ${MAX_ALTERNATES} alternates already: remove one first.` }], 'alternate')
      const next = await plan(
        tools,
        draft,
        line,
        body.itemId,
        (required) => ({
          itemId: body.itemId,
          itemColourId: body.itemColourId ?? null,
          qty: body.qty === undefined || body.qty === null ? null : decimalText(body.qty),
          allowedWhen: body.allowedWhen ?? 'WITH_APPROVAL',
          // Left out: on whenever a PPE component is involved.
          certificateCheck: body.certificateCheck ?? required,
          note: body.note ?? null,
        }),
        others,
        { material: true, colour: true },
      )
      const id = newId()
      const priority = nextPriority(others)
      await tx.bomLineAlternate.create({ data: { id, revisionId, bomLineId: line.id, priority, ...next, createdAt: now, updatedAt: now, createdById: createdByOf(tools) }, select: { id: true } })
      tools.audit({ recordType: 'BomLineAlternate', recordId: id, companyId: draft.style.companyId, after: { revisionId, bomLineId: line.id, ...audited({ ...next, priority }) } })
      recordChange(tools, draft, [line.id], { alternates: { line: line.id, added: id, priority, itemId: next.itemId } })
      return depthInTx(tools, styleId, revisionId)
    }),
  )
  return result
}

/** product.bomLines.updateAlternate: the fields sent; a new material clears the old one's colour unless a colour is sent. */
export async function updateAlternate(caller: CommandCaller, styleId: string, revisionId: string, lineId: string, alternateId: string, body: UpdateAlternateBody, idempotencyKey?: string): Promise<BomDepthView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_MANAGE, style.companyId)

  const { result } = await guarded(() =>
    command(caller, { name: 'product.bomLines.updateAlternate', idempotencyKey, input: { styleId, revisionId, lineId, alternateId, ...body } }, async (tools) => {
      const { tx, now } = tools
      const draft = await lockDraft(tools, styleId, revisionId, body.version)
      const line = await lineFor(tx, revisionId, lineId)
      const alternates = await readAlternates(tx, revisionId, line.id)
      const current = alternateOf(alternates, alternateId)
      const itemId = body.itemId ?? current.itemId
      const materialChanged = itemId !== current.itemId
      const itemColourId = body.itemColourId !== undefined ? body.itemColourId : materialChanged ? null : current.itemColourId
      const next = await plan(
        tools,
        draft,
        line,
        itemId,
        (required) => ({
          itemId,
          itemColourId,
          qty: body.qty === undefined ? current.qty : body.qty === null ? null : decimalText(body.qty),
          allowedWhen: body.allowedWhen ?? current.allowedWhen,
          // Left out: kept, and switched on when a PPE component is now involved (never switched off by itself).
          certificateCheck: body.certificateCheck ?? (current.certificateCheck || required),
          note: body.note === undefined ? current.note : body.note,
        }),
        alternates.filter((alternate) => alternate.id !== current.id),
        { material: materialChanged, colour: itemColourId !== current.itemColourId },
      )
      const changed = FIELDS.filter((field) => next[field] !== current[field])
      if (changed.length > 0) {
        await tx.bomLineAlternate.update({ where: { id: current.id }, data: { ...Object.fromEntries(changed.map((field) => [field, next[field]])), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
        tools.audit({ recordType: 'BomLineAlternate', recordId: current.id, companyId: draft.style.companyId, before: audited(current), after: audited({ ...next, priority: current.priority }) })
      }
      recordChange(tools, draft, changed.length > 0 ? [line.id] : [], { alternates: { line: line.id, changed: current.id, fields: changed } })
      return depthInTx(tools, styleId, revisionId)
    }),
  )
  return result
}

/** product.bomLines.removeAlternate: the alternate out of the line; the ones after it move up (priorities stay 1..n). */
export async function removeAlternate(caller: CommandCaller, styleId: string, revisionId: string, lineId: string, alternateId: string, version: number, idempotencyKey?: string): Promise<BomDepthView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_MANAGE, style.companyId)

  const { result } = await guarded(() =>
    command(caller, { name: 'product.bomLines.removeAlternate', idempotencyKey, input: { styleId, revisionId, lineId, alternateId, version } }, async (tools) => {
      const { tx, now } = tools
      const draft = await lockDraft(tools, styleId, revisionId, version)
      const line = await lineFor(tx, revisionId, lineId)
      const alternates = await readAlternates(tx, revisionId, line.id)
      const current = alternateOf(alternates, alternateId)
      const { count } = await tx.bomLineAlternate.deleteMany({ where: { id: current.id } })
      if (count !== 1) throw new NotFoundError('Alternate not found on this line.')
      // Close up, first to last: each moves into the place just freed (no two at one priority at any moment).
      const moved: { id: string; from: number; to: number }[] = []
      for (const alternate of alternates.filter((entry) => entry.priority > current.priority)) {
        await tx.bomLineAlternate.update({ where: { id: alternate.id }, data: { priority: alternate.priority - 1, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
        moved.push({ id: alternate.id, from: alternate.priority, to: alternate.priority - 1 })
      }
      tools.audit({ recordType: 'BomLineAlternate', recordId: current.id, companyId: draft.style.companyId, before: { revisionId, bomLineId: line.id, ...audited(current) }, after: { removed: true, moved } })
      recordChange(tools, draft, [line.id], { alternates: { line: line.id, removed: current.id, itemId: current.itemId } })
      return depthInTx(tools, styleId, revisionId)
    }),
  )
  return result
}

/** product.bomLines.orderAlternates: every alternate of the line in its new order (the first is priority 1). */
export async function orderAlternates(caller: CommandCaller, styleId: string, revisionId: string, lineId: string, body: OrderAlternatesBody, idempotencyKey?: string): Promise<BomDepthView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_MANAGE, style.companyId)

  const { result } = await guarded(() =>
    command(caller, { name: 'product.bomLines.orderAlternates', idempotencyKey, input: { styleId, revisionId, lineId, ...body } }, async (tools) => {
      const { tx, now } = tools
      const draft = await lockDraft(tools, styleId, revisionId, body.version)
      const line = await lineFor(tx, revisionId, lineId)
      const alternates = await readAlternates(tx, revisionId, line.id)
      const issues = orderProblems(alternates, body.alternateIds)
      if (issues.length > 0) throw invalid(prefixed(issues), 'order of alternates')
      const wanted = prioritiesOf(body.alternateIds)
      const moving = alternates.filter((alternate) => wanted.get(alternate.id) !== alternate.priority)
      // Out of the way first (above any priority in use), then each to its place: never two at one priority.
      for (const alternate of moving) await tx.bomLineAlternate.update({ where: { id: alternate.id }, data: { priority: alternate.priority + MAX_ALTERNATES * 100 }, select: { id: true } })
      for (const alternate of moving) {
        await tx.bomLineAlternate.update({ where: { id: alternate.id }, data: { priority: wanted.get(alternate.id)!, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
        tools.audit({ recordType: 'BomLineAlternate', recordId: alternate.id, companyId: draft.style.companyId, before: { priority: alternate.priority }, after: { priority: wanted.get(alternate.id)! } })
      }
      recordChange(tools, draft, moving.length > 0 ? [line.id] : [], { alternates: { line: line.id, order: body.alternateIds } })
      return depthInTx(tools, styleId, revisionId)
    }),
  )
  return result
}
