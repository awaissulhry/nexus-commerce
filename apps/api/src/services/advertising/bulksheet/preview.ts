/**
 * AX-IE.5 — the dry run. Compute what an upload WOULD do, before anything is written.
 *
 * The teardown found no competitor ships this: Perpetua and Amazon's own console
 * both validate *after* upload, so the first time you learn a file was wrong is
 * once it has been applied. This is the difference between a tool an operator
 * trusts at 3pm on Prime Day and one they don't.
 *
 * Three things come out of it:
 *
 *   A field-level diff — entity, field, current → new — resolved against LIVE
 *     state, not against what the file claims the current value was.
 *   Blast radius — the aggregate an operator actually fears. "4,312 rows will
 *     change" is not decision-useful; "this raises total daily budget by €1,240
 *     (+38%) and archives 12 entities, which is irreversible" is.
 *   Conflicts — rows whose `_baseline` no longer matches, i.e. somebody edited
 *     the same entity in Seller Central while the file was open. Those are
 *     surfaced for a decision, never silently clobbered.
 *
 * Writes nothing. The output is persisted with a token that apply must present.
 */

import type { PrismaClient } from '@prisma/client'
import { parseRowKey, rowKeyMatchesEntity, isAdTargetEntity } from '@nexus/shared/ads-bulksheet'
import { computeBaseline, baselineDrift, parseMoney, parseVocabulary } from '@nexus/shared/ads-bulksheet'
import { FIELDS_BY_KIND } from './field-map.js'

/** One field that would change. */
export interface FieldDiff {
  field: string
  current: string
  next: string
}

export interface PreviewRow {
  rowIndex: number
  entity: string
  operation: string
  rowKey: string
  /** Local entity id once resolved; null when the row points at nothing we hold. */
  targetId: string | null
  label: string
  status: 'CREATE' | 'UPDATE' | 'ARCHIVE' | 'UNCHANGED' | 'CONFLICT' | 'UNRESOLVED' | 'UNSUPPORTED'
  diffs: FieldDiff[]
  note?: string
}

export interface BlastRadius {
  /** Daily-budget movement across every campaign the file touches. */
  dailyBudget: { currentEur: number; nextEur: number; deltaEur: number; deltaPct: number | null; campaigns: number }
  /** Archive is terminal on Amazon — there is no unarchive, by API or by UI. */
  archives: number
  pauses: number
  enables: number
  bidChanges: number
  /** Bids moving by more than half — the ones that are usually a typo. */
  largeBidChanges: number
  /** Sum of |Δbid| so a thousand tiny moves reads differently from ten huge ones. */
  bidDeltaEur: number
  byEntity: Record<string, number>
}

export interface PreviewResult {
  counts: {
    total: number
    create: number
    update: number
    archive: number
    unchanged: number
    conflict: number
    unresolved: number
    unsupported: number
    errorRows: number
  }
  blastRadius: BlastRadius
  warnings: string[]
  conflicts: PreviewRow[]
  rows: PreviewRow[]
  planToken: string
}

/**
 * D2 — DERIVED from the apply mapper, never hand-maintained.
 *
 * These lists used to be written out here independently of apply.ts and drifted
 * from it: `Campaign name`, `Portfolio ID` and `Ad group name` were offered as
 * editable diffs that apply silently discarded. A column that cannot be written
 * can no longer appear in a diff, because there is only one list now.
 */
const CAMPAIGN_FIELDS = FIELDS_BY_KIND.campaign
const ADGROUP_FIELDS = FIELDS_BY_KIND.adGroup
const TARGET_FIELDS = FIELDS_BY_KIND.adTarget
const PORTFOLIO_FIELDS = FIELDS_BY_KIND.portfolio

const money = (raw: string): number | null => {
  const p = parseMoney(raw)
  return 'error' in p ? null : p.value
}
const fmtMoney = (n: number | null | undefined) => (n == null ? '' : n.toFixed(2))

/**
 * Stable fingerprint of the plan. Apply re-computes it and refuses if it moved —
 * so a preview an operator approved cannot be applied against a different plan.
 */
export function planFingerprint(rows: PreviewRow[]): string {
  let h = 0x811c9dc5
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  }
  for (const r of rows) {
    feed(`${r.rowIndex}|${r.entity}|${r.operation}|${r.targetId ?? ''}|${r.status}|`)
    for (const d of r.diffs) feed(`${d.field}=${d.current}>${d.next};`)
  }
  return h.toString(16).padStart(8, '0')
}

interface StagedParsed {
  entity: string | null
  operation: string | null
  rowKey: string
  baseline: string
  values: Record<string, string>
}

export async function buildPreview(prisma: PrismaClient, jobId: string): Promise<PreviewResult> {
  const staged = await prisma.importJobRow.findMany({
    where: { jobId },
    orderBy: { rowIndex: 'asc' },
    select: { rowIndex: true, status: true, parsedValues: true },
  })

  const actionable: Array<{ rowIndex: number; p: StagedParsed }> = []
  let errorRows = 0
  for (const s of staged) {
    if (s.status === 'FAILED') { errorRows++; continue }
    const p = s.parsedValues as unknown as StagedParsed
    if (!p?.operation || !p.entity) continue // blank Operation = read row
    actionable.push({ rowIndex: s.rowIndex, p })
  }

  // Batch-resolve everything the file points at, in three queries rather than
  // one per row — a 9k-row file must not become 9k round trips.
  const campIds = new Set<string>()
  const agIds = new Set<string>()
  const targetIds = new Set<string>()
  const pfIds = new Set<string>()
  for (const { p } of actionable) {
    const v = p.values
    if (p.entity === 'Campaign' || p.entity === 'Bidding adjustment') { if (v['Campaign ID']) campIds.add(v['Campaign ID']) }
    else if (p.entity === 'Portfolio') { if (v['Portfolio ID']) pfIds.add(v['Portfolio ID']) }
    else if (p.entity === 'Ad group') { if (v['Ad group ID']) agIds.add(v['Ad group ID']) }
    else {
      const id = v['Keyword ID'] || v['Product Targeting ID']
      if (id) targetIds.add(id)
    }
  }

  const [camps, ags, targets, portfolios] = await Promise.all([
    campIds.size ? prisma.campaign.findMany({
      where: { externalCampaignId: { in: [...campIds] } },
      select: { id: true, externalCampaignId: true, name: true, status: true, dailyBudget: true, biddingStrategy: true, portfolioId: true },
    }) : Promise.resolve([]),
    agIds.size ? prisma.adGroup.findMany({
      where: { externalAdGroupId: { in: [...agIds] } },
      select: { id: true, externalAdGroupId: true, name: true, status: true, defaultBidCents: true },
    }) : Promise.resolve([]),
    targetIds.size ? prisma.adTarget.findMany({
      where: { externalTargetId: { in: [...targetIds] } },
      select: { id: true, externalTargetId: true, expressionValue: true, expressionType: true, status: true, bidCents: true, isNegative: true },
    }) : Promise.resolve([]),
    pfIds.size ? prisma.amazonAdsPortfolio.findMany({
      where: { externalPortfolioId: { in: [...pfIds] } },
      select: { id: true, externalPortfolioId: true, name: true, budgetAmount: true, budgetCurrencyCode: true, budgetPolicy: true, startDate: true, endDate: true },
    }) : Promise.resolve([]),
  ])
  const campBy = new Map(camps.map((c) => [c.externalCampaignId!, c]))
  const agBy = new Map(ags.map((a) => [a.externalAdGroupId!, a]))
  const tgtBy = new Map(targets.map((t) => [t.externalTargetId!, t]))

  // AX-ZD.9 — resolve by _row_key first, ID column second.
  //
  // The schema called _row_key "the ONLY join key on import" and nothing joined
  // on it: every row was matched by its ID column alone. That column is the
  // fragile one — Amazon ids are 15-digit integers and a spreadsheet that treats
  // one as a number writes back `2.04055E+14`, after which the row cannot be
  // matched and silently previews as UNRESOLVED. The local id inside the row key
  // survives all of that, because nothing in Excel has a reason to touch it.
  const campById = new Map(camps.map((c) => [c.id, c]))
  const agById = new Map(ags.map((a) => [a.id, a]))
  const tgtById = new Map(targets.map((t) => [t.id, t]))

  /**
   * Look up by row key, but only when the key was minted for THIS entity —
   * otherwise a Campaign row carrying an ad group's key would resolve to the
   * wrong record and diff against fields it does not own.
   */
  const byRowKey = <T>(map: Map<string, T>, rowKey: string, entity: string): T | undefined => {
    if (!rowKeyMatchesEntity(rowKey, entity)) return undefined
    const parsed = parseRowKey(rowKey)
    return parsed ? map.get(parsed.localId) : undefined
  }

  const rows: PreviewRow[] = []
  const blast: BlastRadius = {
    dailyBudget: { currentEur: 0, nextEur: 0, deltaEur: 0, deltaPct: null, campaigns: 0 },
    archives: 0, pauses: 0, enables: 0, bidChanges: 0, largeBidChanges: 0, bidDeltaEur: 0, byEntity: {},
  }

  for (const { rowIndex, p } of actionable) {
    const v = p.values
    const op = p.operation!
    const entity = p.entity!
    const base: PreviewRow = { rowIndex, entity, operation: op, rowKey: p.rowKey ?? '', targetId: null, label: '', status: 'UNSUPPORTED', diffs: [] }

    // Only the entities the apply path can actually execute get a real diff. The
    // rest preview as UNSUPPORTED rather than implying they will be written.
    let current: Record<string, string> | null = null
    let fields: readonly string[] = []
    let immutableNote: string | undefined

    if (entity === 'Campaign') {
      const c = byRowKey(campById, base.rowKey, entity) ?? campBy.get(v['Campaign ID'] ?? '')
      if (!c) { rows.push({ ...base, status: 'UNRESOLVED', label: v['Campaign name'] ?? v['Campaign ID'] ?? '', note: 'No campaign with that Campaign ID, and no usable _row_key' }); continue }
      base.targetId = c.id
      base.label = c.name
      current = {
        State: (c.status ?? '').toLowerCase(),
        'Daily budget': fmtMoney(c.dailyBudget == null ? null : Number(c.dailyBudget)),
        'Campaign name': c.name,
        'Bidding strategy': parseVocabulary('biddingStrategy', c.biddingStrategy ?? '') ?? '',
        'Portfolio ID': c.portfolioId ?? '',
      }
      fields = CAMPAIGN_FIELDS
    } else if (entity === 'Ad group') {
      const a = byRowKey(agById, base.rowKey, entity) ?? agBy.get(v['Ad group ID'] ?? '')
      if (!a) { rows.push({ ...base, status: 'UNRESOLVED', label: v['Ad group name'] ?? v['Ad group ID'] ?? '', note: 'No ad group with that Ad group ID, and no usable _row_key' }); continue }
      base.targetId = a.id
      base.label = a.name
      current = {
        State: (a.status ?? '').toLowerCase(),
        'Ad group name': a.name,
        'Ad Group Default Bid': fmtMoney(a.defaultBidCents / 100),
      }
      fields = ADGROUP_FIELDS
    } else if (isAdTargetEntity(entity)) {
      const id = v['Keyword ID'] || v['Product Targeting ID']
      const t = byRowKey(tgtById, base.rowKey, entity) ?? (id ? tgtBy.get(id) : undefined)
      if (!t) {
        // A Create has no id yet — that is expected, not an error.
        if (op === 'Create') { rows.push({ ...base, status: 'CREATE', label: v['Keyword text'] || v['Product targeting expression'] || '' }); blast.byEntity[entity] = (blast.byEntity[entity] ?? 0) + 1; continue }
        rows.push({ ...base, status: 'UNRESOLVED', label: v['Keyword text'] ?? id ?? '', note: 'No target with that id' })
        continue
      }
      base.targetId = t.id
      base.label = t.expressionValue
      current = { State: (t.status ?? '').toLowerCase(), Bid: fmtMoney(t.bidCents / 100) }
      fields = TARGET_FIELDS
      // Match type is IMMUTABLE on Amazon. If the file asks to change it, say so
      // here — otherwise the row reports "unchanged" and the operator believes
      // they made an edit that silently did nothing.
      //
      // Positive keyword targets only, and never on an Archive. A NEGATIVE's
      // match type is derived on export (the DB stores PHRASE / _PHRASE, the
      // sheet says "Negative phrase"), so comparing the two shapes flagged every
      // negative row — including rows being archived, where match type is not
      // even in play. That is noise on the exact screen whose whole job is to be
      // trusted.
      const askedMt = !t.isNegative && op !== 'Archive' ? v['Match type'] : ''
      if (askedMt) {
        const wanted = parseVocabulary('matchType', askedMt)
        const held = parseVocabulary('matchType', t.expressionType ?? '')
        if (wanted && held && wanted !== held) {
          immutableNote = `Match type cannot be changed on an existing target (${held} → ${wanted}). Amazon treats it as immutable: archive this row and create a new one instead. Nothing else on this row is affected.`
        }
      }
    } else {
      rows.push({ ...base, label: v['Campaign ID'] ?? '', note: `${entity} rows are validated and previewed, but applying them is not wired up yet` })
      continue
    }

    // Baseline conflict: recompute the fingerprint from what the entity looks
    // like NOW. A mismatch means it changed since the file was produced.
    // Hash the entity as it stands NOW, over the same per-entity field list the
    // exporter used. Anything the file says is deliberately not consulted here —
    // that is the point of the check.
    const currentBaseline = computeBaseline(entity, (h) => current![h] ?? '')
    // Which fields is the operator actually changing? Drift outside that set is
    // worth mentioning but is NOT a conflict with their edit — blocking on it
    // would train people to click through the warning.
    const touched = fields.filter((f) => v[f] != null && v[f] !== '')
    const collided = baselineDrift(p.baseline ?? '', currentBaseline, touched)
    const driftedElsewhere = baselineDrift(p.baseline ?? '', currentBaseline).filter((f) => !collided.includes(f))

    if (collided.length) {
      const diffs = collided.map((f) => ({ field: f, current: current![f] ?? '', next: v[f] ?? '' }))
      rows.push({
        ...base, status: 'CONFLICT', diffs,
        note: `${collided.join(', ')} changed on Amazon after this file was downloaded. Choose whether to keep your value or theirs.`,
      })
      continue
    }

    const driftNote = [
      immutableNote,
      driftedElsewhere.length
        ? `Heads up: ${driftedElsewhere.join(', ')} changed on Amazon since you downloaded, but you are not editing ${driftedElsewhere.length === 1 ? 'it' : 'them'}, so this applies cleanly.`
        : undefined,
    ].filter(Boolean).join(' ') || undefined

    if (op === 'Archive') {
      rows.push({ ...base, status: 'ARCHIVE', diffs: [{ field: 'State', current: current.State ?? '', next: 'archived' }], note: driftNote })
      blast.archives++
      blast.byEntity[entity] = (blast.byEntity[entity] ?? 0) + 1
      continue
    }

    const diffs: FieldDiff[] = []
    for (const f of fields) {
      const raw = v[f]
      if (raw == null || raw === '') continue // absent = leave alone, not "clear it"
      const cur = current[f] ?? ''
      // Compare money numerically so "20" and "20.00" are not a change.
      const isMoney = f === 'Daily budget' || f === 'Bid' || f === 'Ad Group Default Bid'
      const next = isMoney ? fmtMoney(money(raw)) : raw
      if (next === cur) continue
      diffs.push({ field: f, current: cur, next })

      if (isMoney) {
        const c = Number(cur || 0), n = Number(next || 0)
        if (f === 'Daily budget') {
          blast.dailyBudget.currentEur += c
          blast.dailyBudget.nextEur += n
          blast.dailyBudget.campaigns++
        } else {
          blast.bidChanges++
          blast.bidDeltaEur += Math.abs(n - c)
          if (c > 0 && Math.abs(n - c) / c > 0.5) blast.largeBidChanges++
        }
      }
      if (f === 'State') {
        if (next === 'paused') blast.pauses++
        else if (next === 'enabled') blast.enables++
        else if (next === 'archived') blast.archives++
      }
    }

    if (!diffs.length) { rows.push({ ...base, status: 'UNCHANGED', note: driftNote }); continue }
    rows.push({ ...base, status: op === 'Create' ? 'CREATE' : 'UPDATE', diffs, note: driftNote })
    blast.byEntity[entity] = (blast.byEntity[entity] ?? 0) + 1
  }

  const d = blast.dailyBudget
  d.deltaEur = Number((d.nextEur - d.currentEur).toFixed(2))
  d.currentEur = Number(d.currentEur.toFixed(2))
  d.nextEur = Number(d.nextEur.toFixed(2))
  d.deltaPct = d.currentEur > 0 ? Number(((d.deltaEur / d.currentEur) * 100).toFixed(1)) : null
  blast.bidDeltaEur = Number(blast.bidDeltaEur.toFixed(2))

  const counts = {
    total: rows.length,
    create: rows.filter((r) => r.status === 'CREATE').length,
    update: rows.filter((r) => r.status === 'UPDATE').length,
    archive: rows.filter((r) => r.status === 'ARCHIVE').length,
    unchanged: rows.filter((r) => r.status === 'UNCHANGED').length,
    conflict: rows.filter((r) => r.status === 'CONFLICT').length,
    unresolved: rows.filter((r) => r.status === 'UNRESOLVED').length,
    unsupported: rows.filter((r) => r.status === 'UNSUPPORTED').length,
    errorRows,
  }

  // Warnings are written to be read out loud. A number without its consequence
  // is not a warning.
  const warnings: string[] = []
  if (blast.archives > 0) {
    warnings.push(`${blast.archives} row${blast.archives === 1 ? '' : 's'} will ARCHIVE an entity. Archive is irreversible on Amazon — there is no unarchive, by API or by UI.`)
  }
  if (d.deltaEur !== 0) {
    const dir = d.deltaEur > 0 ? 'raises' : 'lowers'
    const pct = d.deltaPct == null ? '' : ` (${d.deltaPct > 0 ? '+' : ''}${d.deltaPct}%)`
    warnings.push(`This ${dir} total daily budget by €${Math.abs(d.deltaEur).toFixed(2)}${pct}, across ${d.campaigns} campaign${d.campaigns === 1 ? '' : 's'}.`)
  }
  if (blast.pauses > 0) {
    warnings.push(`${blast.pauses} entit${blast.pauses === 1 ? 'y' : 'ies'} will be paused.`)
  }
  // House rule: campaigns are never paused — pausing resets Amazon's learning and
  // introduces delivery lag. Suppression is done with ~EUR 0.02 bids instead. An
  // operator can still do it deliberately from a file they authored, but it must
  // not be possible to do it without noticing.
  const campaignPauses = rows.filter((r) => r.entity === 'Campaign' && r.diffs.some((x) => x.field === 'State' && x.next === 'paused')).length
  if (campaignPauses > 0) {
    warnings.push(`${campaignPauses} CAMPAIGN${campaignPauses === 1 ? '' : 'S'} would be paused, which is against the house rule — pausing disrupts Amazon's algorithm and delays delivery. Suppress with ~EUR 0.02 bids instead unless this is deliberate.`)
  }
  if (blast.largeBidChanges > 0) {
    warnings.push(`${blast.largeBidChanges} bid${blast.largeBidChanges === 1 ? '' : 's'} change by more than 50% — worth checking for a decimal-point slip.`)
  }
  if (counts.conflict > 0) {
    warnings.push(`${counts.conflict} row${counts.conflict === 1 ? '' : 's'} changed on Amazon after you downloaded this file. Nothing will be overwritten until you choose.`)
  }
  if (counts.unresolved > 0) {
    warnings.push(`${counts.unresolved} row${counts.unresolved === 1 ? '' : 's'} point at entities we cannot find. They will be skipped.`)
  }
  if (counts.unsupported > 0) {
    warnings.push(`${counts.unsupported} row${counts.unsupported === 1 ? '' : 's'} are for entity types this build validates but cannot yet apply. They will be skipped.`)
  }
  if (!warnings.length && counts.create + counts.update + counts.archive === 0) {
    warnings.push('Nothing in this file changes anything. Every row is either blank-Operation or already matches.')
  }

  return { counts, blastRadius: blast, warnings, conflicts: rows.filter((r) => r.status === 'CONFLICT'), rows, planToken: planFingerprint(rows) }
}
