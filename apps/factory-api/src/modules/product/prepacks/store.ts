import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { editRefusal as ruleRefusal } from '@nexus/factory-domain/product/lifecycle/rules'
import type { PrepackView, StylePrepacksView } from '@nexus/factory-domain/product/prepacks/contracts'
import { bySize, outsideRange, piecesOf, prepackWords, ratioText, type PrepackScope, type PrepackStatus } from '@nexus/factory-domain/product/prepacks/rules'
import type { CommandTx } from '../../../core/command'
import { editRuleOf } from '../lifecycle/edit-rule'

/**
 * The prepacks' rows (factory-db `Prepack`, `PrepackLine`, B-W2b-210) and what they name (`Style`, `SizeScale`, `Size`,
 * `Colourway`): the columns every read names (no relation selects: inside a transaction Prisma would send them at once on
 * its one connection), the views, and the last net for a database refusal.
 *
 * Whose company: a style's prepack is the style's (`Style.companyId`), a scale's prepack the scale's (`SizeScale.companyId`);
 * null is every company of the tenant (written only by a role over every company).
 */

export const PREPACK_COLUMNS = { id: true, sizeScaleId: true, styleId: true, code: true, name: true, status: true, version: true, createdAt: true, updatedAt: true } as const satisfies Prisma.PrepackSelect
export type PrepackRow = Prisma.PrepackGetPayload<{ select: typeof PREPACK_COLUMNS }>

export const LINE_COLUMNS = { id: true, prepackId: true, size: true, styleId: true, colourwayId: true, quantity: true, version: true } as const satisfies Prisma.PrepackLineSelect
export type LineRow = Prisma.PrepackLineGetPayload<{ select: typeof LINE_COLUMNS }>

export const STYLE_COLUMNS = { id: true, code: true, name: true, companyId: true, status: true, sizes: true, baseSize: true, sizeScaleId: true } as const satisfies Prisma.StyleSelect
export type StyleRow = Prisma.StyleGetPayload<{ select: typeof STYLE_COLUMNS }>

export const SCALE_COLUMNS = { id: true, code: true, name: true, companyId: true, status: true } as const satisfies Prisma.SizeScaleSelect
export type ScaleRow = Prisma.SizeScaleGetPayload<{ select: typeof SCALE_COLUMNS }>

type Client = FactoryClient | CommandTx

export const scopeOf = (row: Pick<PrepackRow, 'styleId'>): PrepackScope => (row.styleId === null ? 'SCALE' : 'STYLE')

/** The scale's sizes in their order. */
export async function scaleSizes(client: Client, scaleId: string): Promise<string[]> {
  const rows = await client.size.findMany({ where: { scaleId }, select: { code: true }, orderBy: [{ seq: 'asc' }, { code: 'asc' }] })
  return rows.map((row) => row.code)
}

export const readLines = (client: Client, prepackIds: readonly string[]): Promise<LineRow[]> =>
  prepackIds.length === 0 ? Promise.resolve([]) : client.prepackLine.findMany({ where: { prepackId: { in: [...prepackIds] } }, select: LINE_COLUMNS, orderBy: [{ size: 'asc' }, { createdAt: 'asc' }] })

export interface ColourwayRow {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly status: 'ACTIVE' | 'ARCHIVED'
}

export async function readColourways(client: Client, styleIds: readonly string[]): Promise<Map<string, ColourwayRow>> {
  if (styleIds.length === 0) return new Map()
  const rows = await client.colourway.findMany({ where: { styleId: { in: [...styleIds] } }, select: { id: true, code: true, name: true, status: true }, orderBy: { code: 'asc' } })
  return new Map(rows.map((row) => [row.id, { id: row.id, code: row.code, name: row.name, status: row.status as ColourwayRow['status'] }]))
}

/**
 * A prepack as a style's section (or W2b-5's order line) reads it: the lines in the size order, the pieces per size and the
 * ratio, and — against the style in view (`range`) — the pack's sizes the style is not made in.
 */
export function prepackViewOf(row: PrepackRow, lines: readonly LineRow[], scale: Pick<ScaleRow, 'id' | 'code' | 'name'>, order: readonly string[], colourways: ReadonlyMap<string, ColourwayRow>, range: readonly string[]): PrepackView {
  const own = lines.filter((line) => line.prepackId === row.id)
  const rank = (size: string) => {
    const index = order.indexOf(size)
    return index < 0 ? Number.MAX_SAFE_INTEGER : index
  }
  const sorted = [...own].sort((a, b) => rank(a.size) - rank(b.size) || a.size.localeCompare(b.size) || (colourways.get(a.colourwayId ?? '')?.code ?? '').localeCompare(colourways.get(b.colourwayId ?? '')?.code ?? ''))
  const outside = outsideRange(sorted, range)
  const status = row.status as PrepackStatus
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    scope: scopeOf(row),
    styleId: row.styleId,
    sizeScale: { id: scale.id, code: scale.code, name: scale.name },
    status,
    lines: sorted.map((line) => {
      const colourway = line.colourwayId ? colourways.get(line.colourwayId) : undefined
      return { size: line.size, colourwayId: line.colourwayId, colourway: colourway ? { id: colourway.id, code: colourway.code, name: colourway.name } : null, quantity: line.quantity }
    }),
    bySize: bySize(sorted, order),
    ratio: ratioText(sorted, order),
    pieces: piecesOf(sorted),
    byColourway: sorted.some((line) => line.colourwayId !== null),
    outsideRange: outside,
    usable: status === 'ACTIVE' && outside.length === 0 && sorted.length > 0,
    words: prepackWords(
      sorted.map((line) => ({ size: line.size, quantity: line.quantity, colourway: line.colourwayId ? (colourways.get(line.colourwayId)?.code ?? null) : null })),
      order,
      outside,
    ),
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** Why a prepack of this style cannot be added or changed now (archived; the style's edit rule, kind DETAILS), or null. */
export async function styleRefusalOf(client: Client, style: Pick<StyleRow, 'id' | 'status'>): Promise<string | null> {
  if (style.status === 'ARCHIVED') return 'This style is archived: reactivate it before changing its prepacks.'
  const { rule, facts } = await editRuleOf(client, style.id)
  return ruleRefusal(rule, 'DETAILS', facts)?.message ?? null
}

const statusRank = (status: string) => (status === 'ACTIVE' ? 0 : 1)

/** The style's section: its own prepacks, then its scale's, each active before archived, by code. */
export async function stylePrepacksView(client: Client, style: StyleRow): Promise<StylePrepacksView> {
  const scale = await client.sizeScale.findUniqueOrThrow({ where: { id: style.sizeScaleId }, select: SCALE_COLUMNS })
  const order = await scaleSizes(client, scale.id)
  const rows = await client.prepack.findMany({ where: { sizeScaleId: scale.id, OR: [{ styleId: style.id }, { styleId: null }] }, select: PREPACK_COLUMNS })
  rows.sort((a, b) => (a.styleId === null ? 1 : 0) - (b.styleId === null ? 1 : 0) || statusRank(a.status) - statusRank(b.status) || a.code.localeCompare(b.code))
  const lines = await readLines(
    client,
    rows.map((row) => row.id),
  )
  const colourways = await readColourways(client, [style.id])
  const prepacks = rows.map((row) => prepackViewOf(row, lines, scale, order, colourways, style.sizes))
  const styleRefusal = await styleRefusalOf(client, style)
  const own = prepacks.filter((prepack) => prepack.scope === 'STYLE' && prepack.status === 'ACTIVE').length
  const usable = prepacks.filter((prepack) => prepack.usable).length
  return {
    style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, status: style.status, baseSize: style.baseSize, sizes: [...style.sizes] },
    sizeScale: { id: scale.id, code: scale.code, name: scale.name, companyId: scale.companyId, sizes: order },
    colourways: [...colourways.values()].map((colourway) => ({ ...colourway })),
    prepacks,
    styleRefusal,
    words: prepacks.length === 0 ? 'No prepacks yet.' : `${own} prepack(s) of this style · ${usable} it can sell now (its own and its scale's)`,
  }
}

export const prefixed = (issues: readonly Issue[], at = 'body'): Issue[] => issues.map((issue) => ({ path: `${at}/${issue.path}`, message: issue.message }))
export const invalid = (issues: readonly Issue[]): ValidationError => new ValidationError(issues.length === 1 ? issues[0]!.message : 'The prepack is not valid.', issues)

/**
 * The last net (the lead: "a database refusal never reaches a person as a 500"): a refusal of the …_sizes_measures_w2b_guards
 * triggers (check_violation 'product: …') that the checks before did not foresee (a race), or a code or a line taken
 * meanwhile, is a 409 in words. Anything else is thrown as it is.
 */
export async function prepacksGuarded<T>(work: () => Promise<T>, taken = 'Someone changed this prepack at the same time: load it again.'): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const known = error as { code?: unknown; meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null
    const cause = known?.meta?.driverAdapterError?.cause
    if ((cause?.originalCode === '23514' || cause?.originalCode === 'P0001') && typeof cause.originalMessage === 'string' && cause.originalMessage.startsWith('product: ')) {
      const words = cause.originalMessage.slice('product: '.length)
      throw new ConflictError(`${words.charAt(0).toUpperCase()}${words.slice(1)}. Load the prepacks again.`)
    }
    if (known?.code === 'P2002' || cause?.originalCode === '23505') throw new ConflictError(taken)
    throw error
  }
}
