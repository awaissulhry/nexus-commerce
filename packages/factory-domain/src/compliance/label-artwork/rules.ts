import type { Issue } from '../../core/errors'
import { decimalOf, decimalText, type Uom } from '../../product/units/units'

/**
 * Label artwork, label lines in the BOM and the label reconciliation (B-W2b-259), pure. The tables are B-W2b-218's
 * LabelArtworkVersion and GarmentLabelSpoil and B-W2b-211's BomLine.sourceKey; the database holds the hard rules (a second
 * person approves, one approved proof per label revision, spoiled + returned ≤ a print's quantity); these say them first,
 * in words, and compute what no column holds.
 *
 *   artwork (PRD-347)      versions of a label revision's proof: DRAFT → APPROVED (by a person other than its author) →
 *                          RETIRED; the version in force at a moment (a work order's labels follow the version in force
 *                          at its first print: "reprints use the same version").
 *   label lines (PRD-088)  the lines a style's BOM needs by the rules: the brand's packaging rules (BrandingSet, per
 *                          garment: "branding:<key>") and the marking the law asks of the garment (its label templates
 *                          and, for PPE, the user information leaflet: "compliance:…"); the plan compares them with the
 *                          lines the rules made before (sourceKey) and says what to add, change or remove.
 *   reconciliation (MES-140) per work order and size: printed = used + spoiled + returned; any difference holds the
 *                          work order's final release (B-W2b-254's gate, check `label.reconciliation`).
 */

// ---- artwork ------------------------------------------------------------------------------------------------------------

export const ARTWORK_STATUSES = ['DRAFT', 'APPROVED', 'RETIRED'] as const
export type ArtworkStatus = (typeof ARTWORK_STATUSES)[number]
export const ARTWORK_NOTE_MAX = 2000
export const ARTWORK_REASON_MIN = 3
export const ARTWORK_REASON_MAX = 500
/** The proof is a PDF or a picture of the label (a file of the label template). */
export const ARTWORK_FILE_KINDS = ['DOCUMENT', 'PHOTO', 'ATTACHMENT'] as const

export interface ArtworkFact {
  readonly id: string
  readonly versionNo: number
  readonly status: ArtworkStatus
  /** Who made it (authorId, else createdById); null: not known. */
  readonly authorId: string | null
  readonly approvedAt: Date | null
  readonly approvedById: string | null
  readonly retiredAt: Date | null
}

/** The next version number of a label revision's artwork. */
export const nextVersionNo = (versions: readonly Pick<ArtworkFact, 'versionNo'>[]): number => versions.reduce((max, row) => Math.max(max, row.versionNo), 0) + 1

/** The version approved now (at most one). */
export const approvedNow = <T extends Pick<ArtworkFact, 'status'>>(versions: readonly T[]): T | null => versions.find((row) => row.status === 'APPROVED') ?? null

/** The version that was approved at `at` (approved by then and not retired by then), or null. */
export function inForceAt<T extends Pick<ArtworkFact, 'approvedAt' | 'retiredAt'>>(versions: readonly T[], at: Date): T | null {
  const time = at.getTime()
  const live = versions.filter((row) => row.approvedAt !== null && row.approvedAt.getTime() <= time && (row.retiredAt === null || row.retiredAt.getTime() > time))
  return live.sort((a, b) => b.approvedAt!.getTime() - a.approvedAt!.getTime())[0] ?? null
}

export type ArtworkAct = 'APPROVE' | 'RETIRE' | 'REMOVE'

/** Why the act is refused (null: it may run). `actorId`: who acts; `templateRetired`: the label revision is retired. */
export function artworkRefusal(act: ArtworkAct, version: ArtworkFact, facts: { readonly actorId: string; readonly templateRetired: boolean }): string | null {
  const name = `Artwork v${version.versionNo}`
  if (act === 'APPROVE') {
    if (version.status !== 'DRAFT') return `${name} is ${version.status.toLowerCase()}: only a draft is approved. Add a new version instead.`
    if (facts.templateRetired) return `The label revision of ${name} is retired: it takes no approved artwork.`
    if (version.authorId === null) return `${name} has no known author, so nobody can be its second person: add it again as a new version.`
    if (version.authorId === facts.actorId) return `${name} is yours: a second person approves it (PRD-347).`
    return null
  }
  if (act === 'RETIRE') return version.status === 'RETIRED' ? `${name} is retired already.` : null
  return version.status === 'DRAFT' ? null : `${name} is ${version.status.toLowerCase()}: it is kept, never removed. Retire it instead.`
}

export function noteProblems(note: string | null | undefined, path = 'body/note'): Issue[] {
  if (note === null || note === undefined) return []
  const text = note.trim()
  if (text.length === 0 || text.length > ARTWORK_NOTE_MAX) return [{ path, message: `A note is 1 to ${ARTWORK_NOTE_MAX} characters.` }]
  return []
}

// ---- label lines in the BOM (PRD-088) ----------------------------------------------------------------------------------

export const LINE_SOURCES = ['BRANDING', 'COMPLIANCE'] as const
export type LineSource = (typeof LINE_SOURCES)[number]
export const PACKAGING_PER = ['GARMENT', 'PACK', 'CARTON'] as const
export type PackagingPer = (typeof PACKAGING_PER)[number]
export const LINE_SECTIONS = ['LABELS', 'PACKAGING'] as const
export type LineSection = (typeof LINE_SECTIONS)[number]
/** The sourceKey of the user information leaflet a PPE style's garment carries (Reg. 2016/425 art. 8(7), Annex II 1.4). */
export const USER_INFORMATION_KEY = 'compliance:user-information'
export const SOURCE_KEY_MAX = 120
/** The rules a branding set may hold (B-W2b-206's guard). */
export const PACKAGING_RULE_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/

export const brandingKey = (ruleKey: string): string => `branding:${ruleKey}`
export const labelKey = (templateCode: string): string => `compliance:label:${templateCode}`
export const sourceOf = (sourceKey: string): LineSource | null => (sourceKey.startsWith('branding:') ? 'BRANDING' : sourceKey.startsWith('compliance:') ? 'COMPLIANCE' : null)

/** A packaging rule of the brand's set as stored (BrandingSet.packagingRules: B-W2b-206's shape). */
export interface PackagingRule {
  readonly key: string
  readonly text: string
  readonly itemId?: string | null
  readonly quantity?: string | null
  readonly per?: PackagingPer | null
}

/** The rules' JSON as stored: rows of the right shape only (the database's guard keeps it so). */
export function packagingRulesOf(value: unknown): PackagingRule[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const row = entry as Record<string, unknown>
    if (typeof row.key !== 'string' || !PACKAGING_RULE_KEY.test(row.key) || typeof row.text !== 'string') return []
    const per = typeof row.per === 'string' && (PACKAGING_PER as readonly string[]).includes(row.per) ? (row.per as PackagingPer) : null
    return [{ key: row.key, text: row.text, itemId: typeof row.itemId === 'string' ? row.itemId : null, quantity: typeof row.quantity === 'string' ? row.quantity : null, per }]
  })
}

/** A material a rule names, as the plan needs it. */
export interface RuleMaterial {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly kind: string
  readonly status: 'ACTIVE' | 'ARCHIVED'
  readonly approval: string
  readonly companyId: string | null
  readonly consumptionUom: Uom
}

/** A rule that asks for a line (what the rule is, where the line goes, its material and quantity when the rule names them). */
export interface LineRule {
  readonly sourceKey: string
  readonly source: LineSource
  /** What the rule asks, in words (the rule's own text, or the law's). */
  readonly words: string
  readonly section: LineSection
  /** The material the rule names (branding); null: the person picks it once (compliance), or none (a rule in words). */
  readonly itemId: string | null
  /** Per garment, in the material's consumption unit. */
  readonly qty: string
  /** A branding rule's per; compliance lines are per garment. */
  readonly per: PackagingPer
  /** The label template it marks (compliance labels). */
  readonly template: { readonly id: string; readonly code: string; readonly revision: number; readonly kind: string } | null
}

/** A rule's quantity as plain decimal text above 0, or null. */
function quantityText(value: string | null | undefined): string | null {
  if (!value || !/^\d{1,14}(\.\d{1,4})?$/.test(value.trim())) return null
  const text = decimalText(value.trim())
  return text === '0' ? null : text
}

/** The rules a style needs, in order: its label templates, the leaflet (PPE), then the brand's packaging rules. */
export function lineRules(input: {
  readonly labels: readonly { readonly id: string; readonly code: string; readonly revision: number; readonly kind: string; readonly name: string }[]
  readonly ppe: boolean
  readonly packaging: readonly PackagingRule[]
}): { readonly rules: LineRule[]; readonly inWords: { readonly sourceKey: string; readonly words: string; readonly why: 'NO_MATERIAL' | 'PER_PACK' | 'PER_CARTON' }[] } {
  const rules: LineRule[] = []
  const inWords: { sourceKey: string; words: string; why: 'NO_MATERIAL' | 'PER_PACK' | 'PER_CARTON' }[] = []
  const seen = new Set<string>()
  for (const label of input.labels) {
    const sourceKey = labelKey(label.code)
    if (seen.has(sourceKey)) continue
    seen.add(sourceKey)
    rules.push({ sourceKey, source: 'COMPLIANCE', words: `${label.kind === 'PACKAGING' ? 'Packaging label' : 'Garment label'} ${label.code} r${label.revision} (${label.name}), one per garment.`, section: label.kind === 'PACKAGING' ? 'PACKAGING' : 'LABELS', itemId: null, qty: '1', per: 'GARMENT', template: { id: label.id, code: label.code, revision: label.revision, kind: label.kind } })
  }
  if (input.ppe) rules.push({ sourceKey: USER_INFORMATION_KEY, source: 'COMPLIANCE', words: 'The user information leaflet in the market\'s languages, one per garment (Reg. (EU) 2016/425 art. 8(7)).', section: 'PACKAGING', itemId: null, qty: '1', per: 'GARMENT', template: null })
  for (const rule of input.packaging) {
    const sourceKey = brandingKey(rule.key)
    if (seen.has(sourceKey)) continue
    seen.add(sourceKey)
    const qty = quantityText(rule.quantity)
    if (!rule.itemId || qty === null || !rule.per) inWords.push({ sourceKey, words: rule.text, why: 'NO_MATERIAL' })
    else if (rule.per !== 'GARMENT') inWords.push({ sourceKey, words: rule.text, why: rule.per === 'PACK' ? 'PER_PACK' : 'PER_CARTON' })
    else rules.push({ sourceKey, source: 'BRANDING', words: rule.text, section: 'PACKAGING', itemId: rule.itemId, qty, per: 'GARMENT', template: null })
  }
  return { rules, inWords }
}

/** A line a rule made before (BomLine.sourceKey set). */
export interface RuleLine {
  readonly id: string
  readonly seq: number
  readonly sourceKey: string
  readonly itemId: string
  readonly qty: string
  readonly uom: Uom
  readonly section: string | null
}

export const LINE_ACTIONS = ['ADD', 'UPDATE', 'KEEP', 'REMOVE', 'NEEDS_MATERIAL'] as const
export type LineAction = (typeof LINE_ACTIONS)[number]

export interface LinePlanEntry {
  readonly action: LineAction
  readonly sourceKey: string
  readonly rule: LineRule | null
  /** The line the rule made (UPDATE, KEEP, REMOVE). */
  readonly line: RuleLine | null
  /** The line as the rule wants it (ADD, UPDATE, KEEP). */
  readonly next: { readonly itemId: string; readonly qty: string; readonly uom: Uom; readonly section: LineSection } | null
  /** What changes (UPDATE): the material, the quantity, the section. */
  readonly changes: readonly ('itemId' | 'qty' | 'section')[]
  /** REMOVE: the rule is gone (or no longer applies), or a second line of one rule. */
  readonly why: 'RULE_GONE' | 'DUPLICATE' | null
  /** Why it cannot be done now (null: it can): the material is archived, blocked, of another company or counted wrong. */
  readonly held: string | null
}

/** Why a material cannot be on this style's rule line (null: it can). */
export function materialHeld(material: RuleMaterial | undefined, rule: Pick<LineRule, 'source' | 'words'>, companyId: string | null): string | null {
  if (!material) return 'The material the rule names is not in the library.'
  if (material.status !== 'ACTIVE') return `${material.code} is archived: the rule names a material no longer used.`
  if (material.approval === 'BLOCKED') return `${material.code} is blocked for use.`
  if (material.companyId !== null && material.companyId !== companyId) return `${material.code} belongs to another company.`
  if (rule.source === 'COMPLIANCE' && material.consumptionUom !== 'PCS') return `${material.code} is counted in ${material.consumptionUom}: a label or leaflet line counts one piece per garment.`
  return null
}

const sameQty = (a: string, b: string): boolean => decimalOf(a).equals(decimalOf(b))

/**
 * The plan: each rule against the line it made before (by sourceKey). `picked`: materials the person chose for compliance
 * rules (sourceKey → item id); `materials`: every material named, read. Lines made by rules that no longer apply are
 * removed; a second line of the same rule too. Lines typed by a person (no sourceKey) are never touched.
 */
export function planLabelLines(input: {
  readonly rules: readonly LineRule[]
  readonly lines: readonly RuleLine[]
  readonly picked: Readonly<Record<string, string>>
  readonly materials: ReadonlyMap<string, RuleMaterial>
  readonly companyId: string | null
}): LinePlanEntry[] {
  const out: LinePlanEntry[] = []
  const bySource = new Map<string, RuleLine[]>()
  for (const line of [...input.lines].sort((a, b) => a.seq - b.seq)) bySource.set(line.sourceKey, [...(bySource.get(line.sourceKey) ?? []), line])
  for (const rule of input.rules) {
    const [line, ...extra] = bySource.get(rule.sourceKey) ?? []
    bySource.delete(rule.sourceKey)
    const itemId = rule.itemId ?? input.picked[rule.sourceKey] ?? line?.itemId ?? null
    if (itemId === null) {
      out.push({ action: 'NEEDS_MATERIAL', sourceKey: rule.sourceKey, rule, line: null, next: null, changes: [], why: null, held: null })
    } else {
      const material = input.materials.get(itemId)
      const fresh = !line || line.itemId !== itemId
      const held = fresh ? materialHeld(material, rule, input.companyId) : null
      const next = { itemId, qty: rule.qty, uom: material?.consumptionUom ?? line?.uom ?? 'PCS', section: rule.section }
      if (!line) out.push({ action: 'ADD', sourceKey: rule.sourceKey, rule, line: null, next, changes: [], why: null, held })
      else {
        const changes: ('itemId' | 'qty' | 'section')[] = []
        if (line.itemId !== itemId) changes.push('itemId')
        if (!sameQty(line.qty, rule.qty) || (line.itemId !== itemId && line.uom !== next.uom)) changes.push('qty')
        if (line.section !== rule.section) changes.push('section')
        out.push({ action: changes.length > 0 ? 'UPDATE' : 'KEEP', sourceKey: rule.sourceKey, rule, line, next, changes, why: null, held: changes.length > 0 ? held : null })
      }
    }
    for (const duplicate of extra) out.push({ action: 'REMOVE', sourceKey: rule.sourceKey, rule, line: duplicate, next: null, changes: [], why: 'DUPLICATE', held: null })
  }
  for (const [sourceKey, lines] of bySource) {
    // A rule of a source this code does not know is left alone: another step's.
    if (sourceOf(sourceKey) === null) continue
    for (const line of lines) out.push({ action: 'REMOVE', sourceKey, rule: null, line, next: null, changes: [], why: 'RULE_GONE', held: null })
  }
  return out
}

/** Does the plan change anything that can be changed now? */
export const planChanges = (plan: readonly LinePlanEntry[]): LinePlanEntry[] => plan.filter((entry) => (entry.action === 'ADD' || entry.action === 'UPDATE' || entry.action === 'REMOVE') && entry.held === null)

// ---- the label reconciliation (MES-140) ---------------------------------------------------------------------------------

export const SPOIL_KINDS = ['SPOILED', 'RETURNED'] as const
export type SpoilKind = (typeof SPOIL_KINDS)[number]
export const SPOIL_REASON_MIN = 3
export const SPOIL_REASON_MAX = 200
/** At most this many labels in one entry (a print gives at most MAX_LABEL_COPIES). */
export const SPOIL_MAX = 500

export interface ReconcileCell {
  readonly cellId: string
  readonly colourwayCode: string
  readonly size: string
  /** Good garments at the final operation (null: no scanned operation). */
  readonly finished: number | null
  /** BATCH: labels of first prints; SERIAL: live serials (W1's `labelled`). */
  readonly labelled: number
}

export interface ReconcilePrint {
  readonly id: string
  readonly cellId: string
  readonly kind: 'PRINT' | 'REPRINT'
  readonly quantity: number
  readonly at: Date
}

export interface ReconcileSpoil {
  readonly printId: string
  readonly kind: SpoilKind
  readonly quantity: number
}

export interface Counted {
  readonly printed: number
  /** Labels on garments: the garments labelled, never more than are finished. */
  readonly used: number
  readonly spoiled: number
  readonly returned: number
  /** printed − used − spoiled − returned: above 0 labels not accounted for; below 0 more logged than printed beyond the garments. */
  readonly difference: number
}

export interface CellReconciliation extends Counted {
  readonly cellId: string
  readonly colourwayCode: string
  readonly size: string
  readonly balanced: boolean
}

export interface Reconciliation {
  readonly cells: CellReconciliation[]
  readonly total: Counted
  readonly balanced: boolean
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

/** Per size and in total: printed = used + spoiled + returned. */
export function reconcile(cells: readonly ReconcileCell[], prints: readonly ReconcilePrint[], spoils: readonly ReconcileSpoil[]): Reconciliation {
  const cellOfPrint = new Map(prints.map((print) => [print.id, print.cellId]))
  const rows = cells.map((cell): CellReconciliation => {
    const printed = sum(prints.filter((print) => print.cellId === cell.cellId).map((print) => print.quantity))
    const mine = spoils.filter((spoil) => cellOfPrint.get(spoil.printId) === cell.cellId)
    const spoiled = sum(mine.filter((spoil) => spoil.kind === 'SPOILED').map((spoil) => spoil.quantity))
    const returned = sum(mine.filter((spoil) => spoil.kind === 'RETURNED').map((spoil) => spoil.quantity))
    const used = Math.max(0, Math.min(cell.labelled, cell.finished ?? 0))
    const difference = printed - used - spoiled - returned
    return { cellId: cell.cellId, colourwayCode: cell.colourwayCode, size: cell.size, printed, used, spoiled, returned, difference, balanced: difference === 0 }
  })
  const total = {
    printed: sum(rows.map((row) => row.printed)),
    used: sum(rows.map((row) => row.used)),
    spoiled: sum(rows.map((row) => row.spoiled)),
    returned: sum(rows.map((row) => row.returned)),
    difference: sum(rows.map((row) => row.difference)),
  }
  return { cells: rows, total, balanced: rows.every((row) => row.balanced) }
}

/** The reconciliation of one size in words (API sentences are English; screens say their own from the figures). */
export function reconciliationWords(row: Pick<CellReconciliation, 'colourwayCode' | 'size' | 'printed' | 'used' | 'spoiled' | 'returned' | 'difference'>): string {
  const figures = `printed ${row.printed} = used ${row.used} + spoiled ${row.spoiled} + returned ${row.returned}`
  const what = `${row.colourwayCode} ${row.size}`
  if (row.difference === 0) return `${what}: the labels balance (${figures}).`
  if (row.difference > 0) return `${what}: ${row.difference} label${row.difference === 1 ? ' is' : 's are'} not accounted for (${figures.replace(' = ', ' ≠ ')}). Log them as spoiled or returned on the floor's Garment labels.`
  const over = -row.difference
  return `${what}: ${over} more label${over === 1 ? ' was' : 's were'} logged spoiled or returned than printed beyond the labelled garments (${figures.replace(' = ', ' ≠ ')}). Reprint the missing labels, or check the log.`
}

export interface SpoilAsk {
  readonly cellId: string
  readonly kind: SpoilKind
  readonly quantity: number
  readonly reason: string | null
}

export function spoilProblems(ask: SpoilAsk): Issue[] {
  const issues: Issue[] = []
  if (!Number.isInteger(ask.quantity) || ask.quantity < 1 || ask.quantity > SPOIL_MAX) issues.push({ path: 'body/quantity', message: `Count 1 to ${SPOIL_MAX} labels.` })
  const reason = ask.reason?.trim() ?? ''
  if (ask.kind === 'SPOILED' && reason.length < SPOIL_REASON_MIN) issues.push({ path: 'body/reason', message: 'Say why the labels are spoiled.' })
  if (reason.length > SPOIL_REASON_MAX) issues.push({ path: 'body/reason', message: `A reason is at most ${SPOIL_REASON_MAX} characters.` })
  return issues
}

/**
 * The rows one entry writes: the size's prints newest first, each up to what it gave and is not logged yet (the database's
 * rule per print). Null: the size's prints have fewer labels left than asked (`room` says how many).
 */
export function allocateSpoil(prints: readonly ReconcilePrint[], spoils: readonly ReconcileSpoil[], cellId: string, quantity: number): { readonly rows: { printId: string; quantity: number }[] } | { readonly rows: null; readonly room: number } {
  const accounted = new Map<string, number>()
  for (const spoil of spoils) accounted.set(spoil.printId, (accounted.get(spoil.printId) ?? 0) + spoil.quantity)
  const mine = prints.filter((print) => print.cellId === cellId).sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1))
  const rows: { printId: string; quantity: number }[] = []
  let left = quantity
  for (const print of mine) {
    if (left === 0) break
    const room = print.quantity - (accounted.get(print.id) ?? 0)
    if (room <= 0) continue
    const take = Math.min(room, left)
    rows.push({ printId: print.id, quantity: take })
    left -= take
  }
  if (left > 0) return { rows: null, room: quantity - left }
  return { rows }
}
