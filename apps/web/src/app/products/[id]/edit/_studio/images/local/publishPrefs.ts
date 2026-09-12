/**
 * PES.7 — the three browser-local publish preferences (inventory §2.6).
 *
 * Auto-publish (PB.11), the approval gate (PB.12) and rollback snapshots (PB.9). Each was
 * localStorage in the old tab, each has a named server-side successor that was never built, and
 * each therefore keeps saying "this browser only" here.
 *
 * 🔴 **Rollback is the one where browser-local scope is a real hazard**, not a footnote. The other
 * two are per-operator choices, and a choice that does not follow you to another machine is merely
 * inconvenient. A *rollback point* that does not follow you is a safety net that is not there when
 * you reach for it — and you only find out at the moment you need it. `snapshotWarning()` exists to
 * say that where the restore control lives, not in a settings page nobody reads.
 */
import {
  asArrayOf, asBoolean, asNumber, asRecord, asString,
  readLocal, removeLocal, storageKey, writeLocal,
} from './browserStore'

/* ── auto-publish ─────────────────────────────────────────────────────────────── */

export type AutoPublishMap = Record<string, boolean>

export function readAutoPublish(productId: string): AutoPublishMap {
  return readLocal(storageKey('autoPublish', productId), (raw) => {
    const rec = asRecord(raw)
    if (!rec) return null
    const out: AutoPublishMap = {}
    for (const [channel, value] of Object.entries(rec)) {
      // Only a real boolean counts. A channel stored as anything else is dropped, so a corrupted
      // entry can never read as "on".
      if (typeof value === 'boolean') out[channel] = value
    }
    return out
  }) ?? {}
}

export function setAutoPublish(productId: string, channel: string, enabled: boolean): boolean {
  const next = { ...readAutoPublish(productId), [channel]: enabled }
  return writeLocal(storageKey('autoPublish', productId), next)
}

/* ── approval gate ────────────────────────────────────────────────────────────── */

export interface ApprovalRequest {
  id: string
  channel: string
  marketplace: string | null
  requestedAt: string
  note: string | null
}

export interface ApprovalState {
  required: boolean
  queue: ApprovalRequest[]
}

function parseRequest(raw: unknown): ApprovalRequest | null {
  const r = asRecord(raw)
  if (!r) return null
  const id = asString(r.id)
  const channel = asString(r.channel)
  const requestedAt = asString(r.requestedAt)
  // An entry missing any of its three identifying fields is not a request; it is debris.
  if (!id || !channel || !requestedAt) return null
  return { id, channel, marketplace: asString(r.marketplace), requestedAt, note: asString(r.note) }
}

export function readApproval(productId: string): ApprovalState {
  return readLocal(storageKey('approval', productId), (raw) => {
    const r = asRecord(raw)
    if (!r) return null
    return { required: asBoolean(r.required), queue: asArrayOf(r.queue, parseRequest) }
  }) ?? { required: false, queue: [] }
}

export function writeApproval(productId: string, state: ApprovalState): boolean {
  return writeLocal(storageKey('approval', productId), state)
}

export function queueApproval(productId: string, req: ApprovalRequest): boolean {
  const state = readApproval(productId)
  // Idempotent by id: re-requesting the same publish must not stack duplicates in the queue.
  const queue = [...state.queue.filter((q) => q.id !== req.id), req]
  return writeApproval(productId, { ...state, queue })
}

export function resolveApproval(productId: string, id: string): boolean {
  const state = readApproval(productId)
  return writeApproval(productId, { ...state, queue: state.queue.filter((q) => q.id !== id) })
}

/* ── rollback snapshots ───────────────────────────────────────────────────────── */

export interface SnapshotRow {
  slot: string
  groupValue: string | null
  url: string
  position: number
}

export interface Snapshot {
  id: string
  takenAt: string
  channel: string
  marketplace: string | null
  rows: SnapshotRow[]
}

/**
 * How many snapshots to keep per channel+market.
 *
 * Small on purpose. `localStorage` is a few MB for the WHOLE origin, shared with every other
 * feature that uses it; a rollback history that grows without bound eventually makes some unrelated
 * write fail. Rows are URLs and positions — never image bytes.
 */
export const MAX_SNAPSHOTS = 5

function parseSnapshotRow(raw: unknown): SnapshotRow | null {
  const r = asRecord(raw)
  if (!r) return null
  const slot = asString(r.slot)
  const url = asString(r.url)
  const position = asNumber(r.position)
  if (!slot || !url || position === null) return null
  return { slot, groupValue: asString(r.groupValue), url, position }
}

function parseSnapshot(raw: unknown): Snapshot | null {
  const r = asRecord(raw)
  if (!r) return null
  const id = asString(r.id)
  const takenAt = asString(r.takenAt)
  const channel = asString(r.channel)
  if (!id || !takenAt || !channel) return null
  const rows = asArrayOf(r.rows, parseSnapshotRow)
  // A snapshot with no readable rows cannot restore anything, so it is not offered as if it could.
  if (rows.length === 0) return null
  return { id, takenAt, channel, marketplace: asString(r.marketplace), rows }
}

export function readSnapshots(productId: string, channel: string, marketplace: string | null): Snapshot[] {
  return readLocal(
    storageKey('snapshots', productId, channel, marketplace),
    (raw) => asArrayOf(raw, parseSnapshot),
  ) ?? []
}

export function saveSnapshot(productId: string, snapshot: Snapshot): boolean {
  const existing = readSnapshots(productId, snapshot.channel, snapshot.marketplace)
  // Newest first, capped. The oldest is dropped rather than the write being refused.
  const next = [snapshot, ...existing].slice(0, MAX_SNAPSHOTS)
  return writeLocal(storageKey('snapshots', productId, snapshot.channel, snapshot.marketplace), next)
}

export function clearSnapshots(productId: string, channel: string, marketplace: string | null): boolean {
  return removeLocal(storageKey('snapshots', productId, channel, marketplace))
}

/** What changed between a snapshot and what is on the channel now. */
export interface SnapshotDiff {
  added: SnapshotRow[]
  removed: SnapshotRow[]
  moved: Array<{ row: SnapshotRow; from: number; to: number }>
  unchanged: number
}

const coordOf = (r: SnapshotRow) => `${r.groupValue ?? '*'}|${r.slot}|${r.url}`

/**
 * Diff by (bucket, slot, url) — the identity of a placed picture — and treat position separately.
 *
 * Keying on position too would report every reorder as a wholesale replacement: N removals and N
 * additions for what an operator did as one drag.
 */
export function diffSnapshot(snapshot: readonly SnapshotRow[], current: readonly SnapshotRow[]): SnapshotDiff {
  const before = new Map(snapshot.map((r) => [coordOf(r), r]))
  const after = new Map(current.map((r) => [coordOf(r), r]))

  const added: SnapshotRow[] = []
  const removed: SnapshotRow[] = []
  const moved: SnapshotDiff['moved'] = []
  let unchanged = 0

  for (const [key, row] of after) {
    const was = before.get(key)
    if (!was) { added.push(row); continue }
    if (was.position !== row.position) moved.push({ row, from: was.position, to: row.position })
    else unchanged++
  }
  for (const [key, row] of before) {
    if (!after.has(key)) removed.push(row)
  }
  return { added, removed, moved, unchanged }
}

export function isEmptyDiff(d: SnapshotDiff): boolean {
  return d.added.length === 0 && d.removed.length === 0 && d.moved.length === 0
}

/**
 * The warning shown where a restore is offered. Stronger than the generic scope note, because the
 * consequence is different in kind.
 */
export function snapshotWarning(count: number): string {
  return count === 0
    ? 'No restore points are stored in this browser. One is recorded only when you press the button '
      + 'below — nothing takes them for you, and they do not travel, so work done on another machine '
      + 'left nothing here you can go back to.'
    : `${count} restore point${count === 1 ? '' : 's'}, held in this browser only. They are not on `
      + 'your account and did not come from anyone else, so do not rely on one being here when you '
      + 'need it.'
}

/**
 * The rows a channel+market layer holds now, in snapshot shape.
 *
 * 🔴 Takes each row's OWN `position`, never its index in the array. Using the index made an
 * unrelated insertion shift every later row, so a snapshot compare reported a phantom "moved" on a
 * row nothing had touched — caught on screen, not by a test, which is why this now has one. An
 * array index is a fact about the array, not about the data.
 */
export function layerRows(
  listing: readonly {
    platform: string | null
    marketplace: string | null
    amazonSlot: string | null
    variantGroupValue: string | null
    url: string
    position: number
  }[],
  channel: string,
  market: string | null,
): SnapshotRow[] {
  return listing
    .filter((r) => r.platform === channel && (r.marketplace ?? null) === market && r.amazonSlot)
    .map((r) => ({
      slot: r.amazonSlot as string,
      groupValue: r.variantGroupValue,
      url: r.url,
      position: r.position,
    }))
}
