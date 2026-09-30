/**
 * P2 review (2026-09-30) — the channel sheet's bookkeeping after a save: which saves were settled in place, when the one
 * quiet read is owed, and whether readiness must be read for the whole family. Kept out of the adapter so each rule can
 * be tested without a grid.
 */
import type { SheetWriteRequest } from '@/design-system/grid'
import { changeTarget } from './useChannelSheet'
import type { ChannelSheetRow } from './types'

/** What one part of a row's save reports (`ChannelWriteCoord.onStored`). */
export type SettleOutcome = { patched: ChannelSheetRow[]; columns: string[] } | { read: string }

/**
 * One row's save (review 1). A row's save can leave in several parts — a variation theme by its own route, a Shopify
 * field by the Shopify writer, master and listing cells as two guarded writes, one part per language — and only some of
 * them settle in place. The row is settled in place only when EVERY cell it sent was reported patched; a part that
 * reports nothing (the theme, a Shopify field) or asks for a read makes the sheet read.
 */
export function rowSettle(req: Pick<SheetWriteRequest<ChannelSheetRow>, 'cells' | 'row'>) {
  const covered = new Set<string>()
  const rows = new Set<ChannelSheetRow>()
  let readReason: string | null = null
  return {
    onStored(outcome: SettleOutcome): void {
      if ('read' in outcome) { readReason ??= outcome.read; return }
      for (const row of outcome.patched) rows.add(row)
      for (const col of outcome.columns) covered.add(col)
    },
    /** The rows and columns to repaint when the whole save was settled in place; `null` when the sheet must read. */
    inPlace(ok: boolean): { rows: Set<ChannelSheetRow>; columns: Set<string> } | null {
      if (!ok || readReason !== null) return null
      return req.cells.every((cell) => covered.has(cell.colId)) ? { rows, columns: covered } : null
    },
    /**
     * Review 4 — a cell that writes the shared record (a master field on a channel sheet, a content edit saved to every
     * channel) moves the Shared chip and every channel that follows it: readiness is read for the whole family.
     */
    touchesMaster(): boolean {
      return req.cells.some((cell) => changeTarget(req.row?.values?.[cell.colId], cell.intent) !== 'channel')
    },
  }
}

export interface FollowUpReadDeps {
  /** Nothing pending, nothing unconfirmed, no open editor: a read may replace the rows. */
  idle: () => boolean
  /** The sheet's quiet read; resolves true when it replaced the rows. */
  read: (canApply: () => boolean) => Promise<boolean>
  /** The write sequence: a write started after the read began makes the read's answer stale. */
  sequence: () => number
  /** `setTimeout`, returning its cancel. */
  schedule: (run: () => void, ms: number) => () => void
}

/**
 * The one quiet read a save that was not settled in place still owes (review 3). It stays owed until a read has actually
 * replaced the rows: a read that is dropped (an editor open, a newer write, a refused cell, a failed fetch) is tried
 * again when the sheet is idle, and a read that cannot start yet waits instead of fetching.
 */
export class FollowUpRead {
  private owed = false
  private attempts = 0
  private cancel: (() => void) | null = null

  constructor(private readonly deps: FollowUpReadDeps, private readonly retryMs = 1500, private readonly maxAttempts = 40) {}

  get isOwed(): boolean { return this.owed }

  /** A save could not be settled in place. */
  owe(): void {
    this.owed = true
    this.attempts = 0
  }

  /** A batch settled (or a retry came due): read now if a read is owed and the sheet is idle. */
  settle(): void {
    this.cancel?.()
    this.cancel = null
    if (!this.owed) return
    if (!this.deps.idle()) { this.retry(); return }
    this.owed = false
    const sequence = this.deps.sequence()
    this.deps.read(() => this.deps.sequence() === sequence && this.deps.idle()).then(
      (applied) => { if (applied) this.attempts = 0; else this.dropped() },
      () => this.dropped(),
    )
  }

  dispose(): void {
    this.cancel?.()
    this.cancel = null
  }

  private dropped(): void {
    this.owed = true
    this.retry()
  }

  private retry(): void {
    if (this.attempts >= this.maxAttempts) return
    this.attempts++
    this.cancel = this.deps.schedule(() => { this.cancel = null; this.settle() }, this.retryMs)
  }
}
