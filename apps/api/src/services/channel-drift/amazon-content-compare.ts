/**
 * PLAN A-39 (R-41) — Step 3.5b slice b1: what Amazon HOLDS for a listing's content, against what Nexus WOULD SEND.
 *
 * Pure. "Ours" is built by `amazon-content-ours.ts` through the studio builder's own seams (so a difference here is a
 * difference with the payload, not with a second opinion of it); "theirs" is one `getListingsItem` read's `attributes`.
 * The result feeds the ONE drift writer (`recordChannelReadback`) as source `amazon-content`.
 *
 * Rules, each a gate arm:
 *   · content is compared per (attribute, language tag) — `item_name[de_DE]` — as an ORDERED list of normalised values;
 *   · a market language with no text of ours is NOT compared (R-LX-6: the builder omits it, and an omitted attribute is
 *     not deleted on Amazon — Amazon keeps its own text, which is not drift);
 *   · ours present and theirs absent IS drift (`theirs: null`);
 *   · a tag only Amazon holds is ignored — we do not send it;
 *   · attributes: only the LEAVES we send are compared, by path; key order and Amazon-only leaves are ignored;
 *   · normalisation: Unicode NFC, whitespace collapsed, trimmed; a numeric text compares as a number.
 */
import type { DriftField } from '../channel-drift.service.js'

export const AMAZON_CONTENT_SOURCE = 'amazon-content'
export const CONTENT_ROOTS = ['item_name', 'product_description', 'bullet_point', 'generic_keyword'] as const
/** Structure, not content: owned by the variation resolver / the parent link (A-39 "out of scope"). */
export const STRUCTURE_ROOTS: ReadonlySet<string> = new Set(['child_parent_sku_relationship', 'variation_theme', 'parentage_level'])

export type ContentEntry = { value: unknown; marketplace_id?: string; language_tag?: string }
export type NotCompared = { field: string; reason: string }
export interface Comparison { compared: string[]; differing: DriftField[]; notCompared: NotCompared[] }

const NUMERIC = /^-?\d+(\.\d+)?$/

/** One normal form for a scalar, so a stray space or a decomposed accent is not "drift". */
export function normaliseText(value: unknown): string {
  const text = String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim()
  return NUMERIC.test(text) ? String(Number(text)) : text
}

const list = (v: unknown): any[] => (Array.isArray(v) ? v : [])
const one = (values: string[]) => (values.length === 1 ? values[0] : values)
const inMarket = (entry: any, marketplaceId: string) => !entry?.marketplace_id || entry.marketplace_id === marketplaceId

/** Content: our entries (the builder's `buildAmazonContentEntries` output) against Amazon's, per requested tag. */
export function compareAmazonContent(ours: Record<string, ContentEntry[]>, theirs: Record<string, unknown> | null | undefined,
  input: { marketplaceId: string; tags: readonly string[] }): Comparison {
  const out: Comparison = { compared: [], differing: [], notCompared: [] }
  for (const root of CONTENT_ROOTS) {
    for (const tag of input.tags) {
      const field = `${root}[${tag}]`
      const mine = list(ours[root]).filter(e => e?.language_tag === tag && inMarket(e, input.marketplaceId)).map(e => normaliseText(e.value)).filter(Boolean)
      if (!mine.length) { out.notCompared.push({ field, reason: `no ${tag} text of ours — the builder omits it (R-LX-6); Amazon keeps its own` }); continue }
      out.compared.push(field)
      const their = list(theirs?.[root]).filter(e => e?.language_tag === tag && inMarket(e, input.marketplaceId)).map(e => normaliseText(e.value)).filter(Boolean)
      if (!their.length) out.differing.push({ field, ours: one(mine), theirs: null })
      else if (mine.length !== their.length || mine.some((v, i) => v !== their[i])) out.differing.push({ field, ours: one(mine), theirs: one(their) })
    }
  }
  return out
}

/** Every scalar leaf of a value, by path; object keys sorted so key order never matters. */
export function leaves(value: unknown, path = ''): Array<[string, string]> {
  if (value == null) return []
  if (Array.isArray(value)) return value.flatMap((v, i) => leaves(v, `${path}[${i}]`))
  if (typeof value === 'object') {
    return Object.keys(value as object).sort().flatMap(k => leaves((value as Record<string, unknown>)[k], path ? `${path}.${k}` : k))
  }
  const text = normaliseText(value)
  return text === '' ? [] : [[path, text]]
}

/** Attributes: every root we send, compared on the leaves WE send. */
export function compareAmazonAttributes(ours: Record<string, unknown>, theirs: Record<string, unknown> | null | undefined): Comparison {
  const out: Comparison = { compared: [], differing: [], notCompared: [] }
  for (const root of Object.keys(ours).sort()) {
    if ((CONTENT_ROOTS as readonly string[]).includes(root) || STRUCTURE_ROOTS.has(root)) continue
    const mine = leaves(ours[root])
    if (!mine.length) { out.notCompared.push({ field: root, reason: 'nothing of ours to send' }); continue }
    out.compared.push(root)
    if (theirs?.[root] === undefined) { out.differing.push({ field: root, ours: Object.fromEntries(mine), theirs: null }); continue }
    const their = new Map(leaves(theirs[root]))
    const diffs = mine.filter(([p, v]) => their.get(p) !== v)
    if (diffs.length) out.differing.push({ field: root, ours: Object.fromEntries(diffs), theirs: Object.fromEntries(diffs.map(([p]) => [p, their.get(p) ?? null])) })
  }
  return out
}

/** Both halves, one result for the writer. */
export function mergeComparisons(...parts: Comparison[]): Comparison {
  return { compared: parts.flatMap(p => p.compared), differing: parts.flatMap(p => p.differing), notCompared: parts.flatMap(p => p.notCompared) }
}
