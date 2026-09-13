/**
 * MX — the VERB PREVIEW engine, pure, ONE implementation for both apps (`@nexus/shared/matrix-preview`).
 *
 * MX.1 (2026-09-13) moved this here from `apps/web/src/app/products/[id]/edit/_studio/matrix/preview.ts` (now a
 * one-line re-export). In preview mode the page runs THIS on its fixture read; in live mode the server runs THE SAME
 * FUNCTION on the live read (`POST …/studio/matrix/verbs` with `commit:false`) — identical output by construction,
 * pinned by `apps/api/src/services/pim/matrix-write.service.vitest.test.ts`, which feeds one read to both. Every
 * refusal names its cause; every change carries an operator-facing `fromLabel → toLabel`; the confirm level follows
 * the registry's impact rules (design §3.8). No arithmetic happens anywhere else in the frontend.
 *
 * The price verbs check `products.price.edit` — the financial permission Add 4(d) enforces on the price cells
 * server-side — so the page's `can` and the server's `can` ask the same question.
 */
import {
  MATRIX_COPY,
  type CoordinateKey,
  type MatrixCells,
  type MatrixCoordinate,
  type MatrixRead,
  type MatrixRowRead,
  type MatrixVerbId,
  type MatrixVerbRequest,
  type SyncCell,
  type VerbChange,
  type VerbPreview,
  type VerbRefusal,
} from './matrix-contract.js'

export interface PreviewContext {
  /** `has('products.edit')`-style permission check. */
  can: (permission: string) => boolean
  /** `true` when the read is a preview fixture. */
  simulated: boolean
}

const money = (v: number | null | undefined, currency: string): string =>
  v == null ? '—' : new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(v)
const round2 = (n: number) => Math.round(n * 100) / 100

export const syncLabel = (s: SyncCell | null | undefined): string => {
  if (!s) return '—'
  switch (s.kind) {
    case 'FOLLOW': return `Follow ${s.intended ?? '—'}`
    case 'PINNED': return `Pinned ${s.intended ?? '—'}`
    case 'PAUSED': return `Paused (${s.via === 'POLICY' ? 'policy' : 'listing'}) · ${s.mode === 'PINNED' ? 'Pinned' : 'Follow'}`
    case 'FBA_EXCLUDED': return MATRIX_COPY.amazonManaged
    case 'UNCOUNTED': return MATRIX_COPY.uncounted
    case 'CLOSED': return MATRIX_COPY.closed
  }
}

/** The FOLLOW number: pool − buffer, floored at 0; null when the pool is uncounted. Mirrors the resolver (preview only). */
export const followQty = (s: Pick<SyncCell, 'poolAvailable' | 'buffer'>): number | null =>
  s.poolAvailable == null ? null : Math.max(0, s.poolAvailable - Math.max(0, s.buffer))

function target(read: MatrixRead, t: { rowId: string; coordinateKey: CoordinateKey }): { row: MatrixRowRead; coord: MatrixCoordinate; cells: MatrixCells } | null {
  const row = read.rows.find(r => r.id === t.rowId)
  const coord = read.coordinates.find(c => c.key === t.coordinateKey)
  const cells = row?.cells[t.coordinateKey]
  if (!row || !coord || !cells) return null
  return { row, coord, cells }
}

/** Which coordinate carries a target's INVENTORY cells (a market in a shared region points at its region group). */
export function inventoryCoordinate(read: MatrixRead, key: CoordinateKey): CoordinateKey {
  const c = read.coordinates.find(x => x.key === key)
  return c?.inventoryOn ?? key
}

export function previewVerb(read: MatrixRead, req: MatrixVerbRequest, ctx: PreviewContext): VerbPreview {
  const verb: MatrixVerbId = req.params.verb
  const changes: VerbChange[] = []
  const refusals: VerbRefusal[] = []
  const notices = new Set<string>()
  const seen = new Set<string>()
  const refuse = (row: MatrixRowRead, key: CoordinateKey, kind: VerbRefusal['kind'], reason: string) => refusals.push({ rowId: row.id, sku: row.sku, coordinateKey: key, kind, reason })

  for (const t of req.targets) {
    /* Inventory verbs act on the coordinate that CARRIES the inventory — the region group for an EU market. */
    const inventoryVerb = ['pin-quantity', 'set-follow', 'set-buffer', 'pause-sync', 'resume-sync', 'push-now', 'set-fulfilment', 'retry-sync'].includes(verb)
    const key = inventoryVerb ? inventoryCoordinate(read, t.coordinateKey) : t.coordinateKey
    const dedupe = `${t.rowId}|${key}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    const hit = target(read, { rowId: t.rowId, coordinateKey: key })
    if (!hit) { const row = read.rows.find(r => r.id === t.rowId); if (row) refuse(row, key, 'no-listing', 'No listing on this coordinate'); continue }
    const { row, coord, cells } = hit
    if (row.role === 'parent') { refuse(row, key, 'not-applicable', 'The parent row has no listing of its own'); continue }
    if (coord.sharedInventoryWith) notices.add(MATRIX_COPY.euNotice(coord.sharedInventoryWith))
    const p = req.params
    const cur = money(cells.price?.value ?? null, coord.currency)

    switch (p.verb) {
      case 'set-price':
      case 'adjust-prices':
      case 'copy-prices': {
        if (!ctx.can('products.price.edit')) { refuse(row, key, 'permission', 'You do not have permission to change prices (products.price.edit)'); break }
        if (!cells.price) { refuse(row, key, 'not-applicable', 'This coordinate has no price'); break }
        if (cells.price.source === 'formula') { refuse(row, key, 'formula', 'A formula owns this cell — edit the formula'); break }
        if (cells.writable.price === false) { refuse(row, key, 'not-applicable', cells.writeBlockedReason.price ?? 'This price cannot be changed here'); break }
        let to: number | null = null
        let note: string | undefined
        if (p.verb === 'set-price') to = round2(p.value)
        else if (p.verb === 'adjust-prices') { if (cells.price.value == null) { refuse(row, key, 'not-applicable', 'No price to adjust'); break } to = round2(cells.price.value * (1 + p.percent / 100)) }
        else {
          const src = row.cells[p.fromCoordinateKey]
          const srcCoord = read.coordinates.find(c => c.key === p.fromCoordinateKey)
          if (!src?.price || src.price.value == null) { refuse(row, key, 'no-listing', 'No price on the source market'); break }
          if (srcCoord && srcCoord.currency !== coord.currency) { refuse(row, key, 'currency', `Different currencies (${srcCoord.currency} → ${coord.currency}) — set the price instead`); break }
          to = src.price.value
        }
        if (to == null || to < 0) { refuse(row, key, 'not-applicable', 'A price must be zero or more'); break }
        if (to === cells.price.value) break
        if (cells.price.source === 'master') note = 'Set here (was: follows the base price)'
        if (to === 0) note = 'A price of 0 is refused by every channel'
        changes.push({ rowId: row.id, sku: row.sku, coordinateKey: key, cell: 'price', from: cells.price.value, to, fromLabel: cur, toLabel: money(to, coord.currency), note })
        break
      }
      case 'pin-quantity':
      case 'set-follow':
      case 'set-buffer':
      case 'pause-sync':
      case 'resume-sync':
      case 'push-now':
      case 'retry-sync': {
        const s = cells.sync
        if (!s) { refuse(row, key, 'not-applicable', 'This coordinate carries no inventory'); break }
        if (s.kind === 'FBA_EXCLUDED') { refuse(row, key, 'amazon-managed', `${MATRIX_COPY.amazonManaged} — the quantity is never written`); break }
        if (s.kind === 'CLOSED' && p.verb !== 'resume-sync') { refuse(row, key, 'not-applicable', MATRIX_COPY.closedHint); break }
        const from = syncLabel(s)
        if (p.verb === 'pin-quantity') {
          if (!Number.isInteger(p.value) || p.value < 0) { refuse(row, key, 'not-applicable', 'A pinned quantity is a whole number, zero or more'); break }
          if (s.mode === 'PINNED' && s.intended === p.value && s.kind === 'PINNED') break
          changes.push({ rowId: row.id, sku: row.sku, coordinateKey: key, cell: 'syncQty', from: s.intended, to: p.value, fromLabel: from, toLabel: `Pinned ${p.value}`, note: s.kind === 'PAUSED' ? 'Still paused — resume to push' : undefined })
        } else if (p.verb === 'set-follow') {
          if (s.mode === 'FOLLOW') break /* already following — paused or not, nothing to change (resume is its own verb) */
          const to = followQty(s)
          changes.push({ rowId: row.id, sku: row.sku, coordinateKey: key, cell: 'syncMode', from: s.mode, to: 'FOLLOW', fromLabel: from, toLabel: to == null ? `Follow · ${MATRIX_COPY.uncounted}` : `Follow ${to}`, note: s.kind === 'PAUSED' ? 'Still paused — resume to push' : undefined })
        } else if (p.verb === 'set-buffer') {
          if (!Number.isInteger(p.value) || p.value < 0) { refuse(row, key, 'not-applicable', 'A buffer is a whole number, zero or more'); break }
          if (s.buffer === p.value) break
          const after = followQty({ poolAvailable: s.poolAvailable, buffer: p.value })
          changes.push({ rowId: row.id, sku: row.sku, coordinateKey: key, cell: 'syncBuffer', from: s.buffer, to: p.value, fromLabel: `Buffer ${s.buffer}`, toLabel: `Buffer ${p.value}`, note: s.mode === 'FOLLOW' ? `Follow pushes ${after ?? '—'}` : 'Stored — applies when this listing follows the pool' })
        } else if (p.verb === 'pause-sync') {
          if (s.kind === 'PAUSED' && s.via === 'POLICY') { refuse(row, key, 'not-applicable', 'Already held by the channel policy — manage it in Sync Control'); break }
          if (s.kind === 'PAUSED') break
          changes.push({ rowId: row.id, sku: row.sku, coordinateKey: key, cell: 'syncState', from: s.kind, to: 'PAUSED', fromLabel: from, toLabel: `Paused (listing) · ${s.mode === 'PINNED' ? 'Pinned' : 'Follow'}`, note: `Holds ${s.held ?? '—'} on the channel until resumed` })
        } else if (p.verb === 'resume-sync') {
          if (s.kind !== 'PAUSED') break
          if (s.via === 'POLICY') { refuse(row, key, 'not-applicable', 'Held by the channel policy — resuming here changes nothing; resume in Sync Control'); break }
          const to = s.mode === 'PINNED' ? `Pinned ${s.held ?? '—'}` : `Follow ${followQty(s) ?? MATRIX_COPY.uncounted}`
          changes.push({ rowId: row.id, sku: row.sku, coordinateKey: key, cell: 'syncState', from: 'PAUSED', to: s.mode, fromLabel: from, toLabel: to, note: 'Resume recascades and pushes immediately' })
        } else if (p.verb === 'push-now') {
          if (s.kind === 'PAUSED') { refuse(row, key, 'not-applicable', 'Paused — resume to push'); break }
          if (s.kind === 'UNCOUNTED') { refuse(row, key, 'not-applicable', MATRIX_COPY.uncountedHint); break }
          changes.push({ rowId: row.id, sku: row.sku, coordinateKey: key, cell: 'syncState', from: cells.queue?.state ?? 'never', to: 'queued', fromLabel: cells.queue?.state ?? 'never', toLabel: `Queued · ${s.intended ?? '—'}`, note: 'A fresh quantity push' })
        } else if (p.verb === 'retry-sync') {
          const q = cells.queue
          if (!q || (q.state !== 'failed' && q.state !== 'dead')) { refuse(row, key, 'not-applicable', 'Nothing to retry on this coordinate'); break }
          changes.push({ rowId: row.id, sku: row.sku, coordinateKey: key, cell: 'syncState', from: q.state, to: 'queued', fromLabel: q.state, toLabel: 'Queued', note: q.reason ?? undefined })
        }
        break
      }
      case 'set-fulfilment': {
        const f = cells.fulfilment
        if (!f) { refuse(row, key, 'not-applicable', 'This channel has no fulfilment method'); break }
        if (!coord.vocabulary.fulfilment?.includes(p.method)) { refuse(row, key, 'not-applicable', `${p.method} is not a method on ${coord.label}`); break }
        if (f.method === p.method && f.source === 'set') break
        const s = cells.sync
        if (f.method === 'FBA' && p.method === 'FBM' && s?.fbaAtAmazon != null && s.fbaAtAmazon > 0) { refuse(row, key, 'guard', `Refused — ${s.fbaAtAmazon} units of FBA stock on hand keep the guard closed; convert the offer in Seller Central first`); break }
        const pool = s?.poolAvailable ?? null
        const after = p.method === 'FBA' ? 'Amazon-managed · no merchant quantity is pushed' : pool == null ? `Follow → ${MATRIX_COPY.uncounted}` : `Follow → ${Math.max(0, pool - (s?.buffer ?? 0))} pushed from IT-MAIN`
        changes.push({ rowId: row.id, sku: row.sku, coordinateKey: key, cell: 'fulfilment', from: f.method, to: p.method, fromLabel: f.method ?? '—', toLabel: p.method, note: after })
        break
      }
    }
  }

  const priceVerb = verb === 'set-price' || verb === 'adjust-prices' || verb === 'copy-prices'
  const big = changes.length >= 100 || (verb === 'adjust-prices' && req.params.verb === 'adjust-prices' && req.params.percent <= -30)
  const confirm: VerbPreview['confirm'] = verb === 'set-fulfilment' ? 'type-to-confirm' : big ? 'type-to-confirm' : priceVerb || verb === 'pause-sync' || verb === 'resume-sync' || verb === 'push-now' ? 'confirm' : 'none'
  const confirmWord = confirm === 'type-to-confirm' ? (req.params.verb === 'set-fulfilment' ? req.params.method : 'APPLY') : null
  if (ctx.simulated) notices.add(MATRIX_COPY.simulated)
  return { verb, changes, refusals, notices: [...notices], confirm, confirmWord, simulated: ctx.simulated }
}
