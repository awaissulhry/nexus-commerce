import type { FactoryClient } from '@nexus/factory-db'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { LifecycleView, MoveLifecycleBody, ReplacementBody } from '@nexus/factory-domain/product/lifecycle/contracts'
import { PRODUCT_LIFECYCLE_MOVE } from '@nexus/factory-domain/product/lifecycle/permissions'
import {
  editAllowance,
  isBackward,
  LIFECYCLE_MOVES,
  LIFECYCLE_WORDS,
  mayNameReplacement,
  moveRefusal,
  replacementRefusal,
  type StyleLifecycle,
} from '@nexus/factory-domain/product/lifecycle/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { assertMayWrite, contextOf, readStyle } from '../styles/store'
import { editRuleOf, refuse } from './edit-rule'

/**
 * A style's lifecycle (B-W2b-221; PRD-007, PRD-182; factory-domain product/lifecycle): where it is, where it may go and what
 * may change in it now, and the moves, one command each.
 *
 *   GET  /product/styles/:styleId/lifecycle      product.styles.view: the state, the moves (each allowed now or refused in
 *                                                words), the edit rule in force with what each kind of write may do, the
 *                                                rules of every state for the style's company, the replacing style
 *   POST /product/styles/:styleId/lifecycle      product.styles.lifecycle: {version, to, reason?, replacedById?} one move
 *   PUT  /product/styles/:styleId/replaced-by    product.styles.lifecycle: {version, replacedById | null} the replacing style
 *                                                of a style being phased out or discontinued
 *
 * Each write is ONE command on the Style at the version the caller read (command()'s record guard locks the row): the move
 * writes lifecycle, lifecycleChangedAt (the command's time) and lifecycleChangedById (the person) in one UPDATE, with the
 * replacing style (cleared by a move out of phase out / discontinued: the database allows it only there), an audit row with
 * the reason, and style.lifecycle_changed. A move into IN_PRODUCTION without a released revision is refused in words here
 * before the database's own refusal (Style_w2b4_depth). W1's record state `status` is not touched: an archived style does
 * not move (reactivate it first), and W1's archive leaves the lifecycle as it is.
 */

const MAX_CHAIN = 100

type Reader = FactoryClient | CommandTx

/** The styles that replace `styleId` in turn (its replacedById, that one's, …), to find a circle. */
async function replacementChain(db: Reader, styleId: string): Promise<string[]> {
  const chain: string[] = []
  let next: string | null = styleId
  while (next !== null && chain.length < MAX_CHAIN) {
    const row: { replacedById: string | null } | null = await db.style.findUnique({ where: { id: next }, select: { replacedById: true } })
    next = row?.replacedById ?? null
    if (next !== null) {
      if (chain.includes(next)) break
      chain.push(next)
    }
  }
  return chain
}

const REF = { id: true, code: true, name: true } as const

/** The lifecycle view of a style (a read, or a command's answer with its transaction). */
export async function lifecycleViewOf(db: Reader, styleId: string): Promise<LifecycleView> {
  const style = await db.style.findUniqueOrThrow({
    where: { id: styleId },
    select: { id: true, code: true, name: true, companyId: true, status: true, lifecycle: true, version: true, lifecycleChangedAt: true, lifecycleChangedById: true, replacedById: true },
  })
  const replacedBy = style.replacedById === null ? null : await db.style.findUnique({ where: { id: style.replacedById }, select: REF })
  const replaces = await db.style.findMany({ where: { replacedById: styleId }, select: REF, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  const released = await db.styleRevision.findFirst({ where: { styleId, status: 'RELEASED' }, select: { id: true, revision: true } })
  const draft = await db.styleRevision.findFirst({ where: { styleId, status: 'DRAFT' }, select: { id: true, revision: true }, orderBy: { revision: 'desc' } })
  const rule = await editRuleOf(db, styleId)
  const moves = LIFECYCLE_MOVES[style.lifecycle].map((to) => {
    // The reason is asked by the screen for a move back: the refusal shown is what would stop the move with one.
    const refusal = moveRefusal({ code: style.code, status: style.status, from: style.lifecycle, releasedRevision: released !== null, reason: 'given' }, to)
    return { to, backward: isBackward(style.lifecycle, to), allowed: refusal === null, refusal }
  })
  const kinds = editAllowance(rule.rule, rule.facts)
  return {
    style: {
      id: style.id,
      code: style.code,
      name: style.name,
      companyId: style.companyId,
      status: style.status,
      lifecycle: style.lifecycle,
      version: style.version,
      changedAt: style.lifecycleChangedAt ? toUtcIso(style.lifecycleChangedAt) : null,
      changedById: style.lifecycleChangedById,
    },
    replacedBy: replacedBy ? { ...replacedBy } : null,
    replaces: replaces.map((row) => ({ ...row })),
    releasedRevision: released ? { ...released } : null,
    draftRevision: draft ? { ...draft } : null,
    moves,
    editRule: { state: style.lifecycle, rule: rule.rule, source: rule.source, kinds: Object.entries(kinds).map(([kind, refusal]) => ({ kind: kind as keyof typeof kinds, refusal })) },
    rules: rule.table,
  }
}

/** GET /product/styles/:styleId/lifecycle */
export async function readLifecycle(caller: CommandCaller, styleId: string): Promise<LifecycleView> {
  await readStyle(caller, styleId)
  return caller.withClient((client) => lifecycleViewOf(client, styleId))
}

/** The replacing style named (or null), checked against the state the style is in or moves to. */
async function checkedReplacement(tx: CommandTx, style: { id: string; code: string; companyId: string | null }, state: StyleLifecycle, replacedById: string | null): Promise<void> {
  if (replacedById === null) return
  const row = await tx.style.findUnique({ where: { id: replacedById }, select: { id: true, code: true, status: true, lifecycle: true, companyId: true } })
  if (!row) refuse({ code: 'REPLACEMENT_UNUSABLE', message: 'No such style to replace it.' })
  const replacement = row!
  const refusal = replacementRefusal({
    code: style.code,
    state,
    styleId: style.id,
    replacement: {
      id: replacement.id,
      code: replacement.code,
      status: replacement.status,
      lifecycle: replacement.lifecycle,
      fitsCompany: replacement.companyId === null || replacement.companyId === style.companyId,
      chain: await replacementChain(tx, replacement.id),
    },
  })
  if (refusal) refuse(refusal)
}

/** POST /product/styles/:styleId/lifecycle: one move. */
export async function moveLifecycle(caller: CommandCaller, styleId: string, body: MoveLifecycleBody, idempotencyKey?: string): Promise<LifecycleView> {
  const context = contextOf(caller)
  const seen = await readStyle(caller, styleId)
  assertMayWrite(context, PRODUCT_LIFECYCLE_MOVE, seen.companyId)
  const { result } = await command(
    caller,
    { name: 'product.styles.moveLifecycle', idempotencyKey, input: { styleId, ...body }, record: { type: 'Style', id: styleId, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      const style = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: { id: true, code: true, companyId: true, status: true, lifecycle: true, replacedById: true } })
      const released = (await tx.styleRevision.count({ where: { styleId, status: 'RELEASED' } })) > 0
      const refusal = moveRefusal({ code: style.code, status: style.status, from: style.lifecycle, releasedRevision: released, reason: body.reason }, body.to)
      if (refusal) refuse(refusal)
      if (body.replacedById && !mayNameReplacement(body.to)) {
        refuse({ code: 'REPLACEMENT_NOT_HERE', message: `Style ${style.code} is moved to ${LIFECYCLE_WORDS[body.to]}: a replacing style is named only when it is being phased out or discontinued.` })
      }
      // Into PHASE_OUT / DISCONTINUED: the one named (null clears it), else the one it had; out of them: none.
      const replacedById = mayNameReplacement(body.to) ? (body.replacedById === undefined ? style.replacedById : body.replacedById) : null
      if (replacedById !== style.replacedById) await checkedReplacement(tx, style, body.to, replacedById)
      const changedById = tools.context.audience === 'office' ? tools.context.actorId : null
      await tx.style.update({ where: { id: styleId }, data: { lifecycle: body.to, lifecycleChangedAt: now, lifecycleChangedById: changedById, replacedById }, select: { id: true } })
      tools.audit({
        action: 'product.styles.moveLifecycle',
        recordType: 'Style',
        recordId: styleId,
        companyId: style.companyId,
        before: { lifecycle: style.lifecycle, replacedById: style.replacedById },
        after: { lifecycle: body.to, replacedById },
        ...(body.reason ? { reason: body.reason } : {}),
      })
      tools.emit({ type: 'style.lifecycle_changed', subject: styleId, companyId: style.companyId, payload: { styleId, code: style.code, from: style.lifecycle, to: body.to, replacedById } })
      return lifecycleViewOf(tx, styleId)
    },
  )
  return result
}

/** PUT /product/styles/:styleId/replaced-by: the replacing style of a style being phased out or discontinued. */
export async function setReplacement(caller: CommandCaller, styleId: string, body: ReplacementBody, idempotencyKey?: string): Promise<LifecycleView> {
  const context = contextOf(caller)
  const seen = await readStyle(caller, styleId)
  assertMayWrite(context, PRODUCT_LIFECYCLE_MOVE, seen.companyId)
  const { result } = await command(
    caller,
    { name: 'product.styles.setReplacement', idempotencyKey, input: { styleId, ...body }, record: { type: 'Style', id: styleId, expectedVersion: body.version } },
    async (tools) => {
      const { tx } = tools
      const style = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: { id: true, code: true, companyId: true, status: true, lifecycle: true, replacedById: true } })
      if (style.status === 'ARCHIVED') refuse({ code: 'STYLE_ARCHIVED', message: `Style ${style.code} is archived: reactivate it before naming the style that replaces it.` })
      if (body.replacedById !== null && !mayNameReplacement(style.lifecycle)) {
        refuse({ code: 'REPLACEMENT_NOT_HERE', message: `Style ${style.code} is not being phased out or discontinued: a replacing style is named only then.` })
      }
      if (body.replacedById !== style.replacedById) {
        await checkedReplacement(tx, style, style.lifecycle, body.replacedById)
        await tx.style.update({ where: { id: styleId }, data: { replacedById: body.replacedById }, select: { id: true } })
      }
      tools.audit({
        action: 'product.styles.setReplacement',
        recordType: 'Style',
        recordId: styleId,
        companyId: style.companyId,
        before: { replacedById: style.replacedById },
        after: { replacedById: body.replacedById },
        ...(body.reason ? { reason: body.reason } : {}),
      })
      if (body.replacedById !== style.replacedById) tools.emit({ type: 'style.updated', subject: styleId, companyId: style.companyId, payload: { styleId, code: style.code, fields: ['replacedById'] } })
      return lifecycleViewOf(tx, styleId)
    },
  )
  return result
}
