/**
 * The scrap and rework reasons of the operation screen (design floor.operation "counts": Scrap or Rework opens the short
 * reason tiles, text + icon; floor.reasons is W2a; MES-090, QHS-007: one code, shown in each worker's language, read in
 * the office's own). W1 holds one fixed list, the same for every factory: W2a's "Floor rules & codes" (Production ›
 * Floor rules & codes) edits them per tenant. The API reads them through ONE seam (apps/factory-api
 * modules/production/scans/reasons-store.ts), which is where the seeded ScrapReason table replaces this list, so the
 * screens and the scan rules never read this constant directly.
 *
 * A reason belongs to one kind: a SCRAP reason says why a garment is lost at the operation, a REWORK reason why it goes
 * back to be made again. Codes are stable (scans and reports keep them); the labels are what a worker reads.
 */

export const DEFECT_KINDS = ['SCRAP', 'REWORK'] as const
export type DefectKind = (typeof DEFECT_KINDS)[number]

export interface ScanReason {
  readonly kind: DefectKind
  /** Upper-case letters, digits and underscores; unique per kind. */
  readonly code: string
  readonly label: { readonly it: string; readonly en: string }
  /** Tiles are shown in this order (lower first). */
  readonly sortOrder: number
  readonly active: boolean
}

const reason = (kind: DefectKind, sortOrder: number, code: string, it: string, en: string): ScanReason => Object.freeze({ kind, code, label: Object.freeze({ it, en }), sortOrder, active: true })

/** W1's list (made-up wording, no business data): seven scrap and six rework reasons, OTHER last in each. */
export const W1_SCAN_REASONS: readonly ScanReason[] = Object.freeze([
  reason('SCRAP', 10, 'LEATHER_FLAW', 'Difetto della pelle', 'Leather flaw'),
  reason('SCRAP', 20, 'CUT_WRONG', 'Taglio sbagliato', 'Cut wrong'),
  reason('SCRAP', 30, 'STITCHING', 'Cucitura irrecuperabile', 'Stitching beyond repair'),
  reason('SCRAP', 40, 'STAIN', 'Macchia', 'Stain'),
  reason('SCRAP', 50, 'TEAR', 'Strappo o foro', 'Tear or hole'),
  reason('SCRAP', 60, 'MACHINE', 'Danno della macchina', 'Machine damage'),
  reason('SCRAP', 90, 'OTHER', 'Altro', 'Other'),
  reason('REWORK', 10, 'RESTITCH', 'Cucitura da rifare', 'Stitching to redo'),
  reason('REWORK', 20, 'ALIGNMENT', 'Pezzi non allineati', 'Panels not aligned'),
  reason('REWORK', 30, 'HARDWARE', 'Zip o accessorio', 'Zip or hardware'),
  reason('REWORK', 40, 'PROTECTOR', 'Protezione da sistemare', 'Protector to refit'),
  reason('REWORK', 50, 'CLEANING', 'Da pulire', 'Needs cleaning'),
  reason('REWORK', 90, 'OTHER', 'Altro', 'Other'),
])

export const REASON_CODE = /^[A-Z][A-Z0-9_]{1,39}$/
