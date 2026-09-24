/**
 * The messages the import host and its parse worker exchange.
 *
 * Kept in its own module so neither side imports the other: the worker must never pull in
 * Prisma, and the host must never pull in ExcelJS on the main thread. A shared type file is
 * the only thing they have in common.
 *
 * Every payload crosses a structured clone, so nothing here may carry a class instance —
 * `TransferRow`, `TransferIssue` and `EbayWorkbookTable` are plain data and survive it.
 */
import type { EbayWorkbookTable } from './catalog-ebay-workbook.js'
import type { AmazonTemplateParse } from '../amazon/template-workbook.js'
import type { SourceExclusion } from './catalog-source-mapping.js'
import type { TransferIssue, TransferRow } from '@nexus/shared/catalog-transfer'

export interface ParsedPart { rows: TransferRow[]; issues: TransferIssue[]; exclusions?: SourceExclusion[]; warnings?: string[] }

/** What one uploaded part turned out to be. `expandedBytes` feeds the host's batch budget. */
export type PartOutcome =
  | { kind: 'editing'; parsed: ParsedPart; expandedBytes: number }
  | { kind: 'wide'; parsed: ParsedPart; expandedBytes: number }
  | { kind: 'transfer'; parsed: ParsedPart; expandedBytes: number }
  | { kind: 'ebay'; table: EbayWorkbookTable; expandedBytes: number }
  /**
   * CFI-1 — Amazon's own template, read by the zip walker (`detectAmazonTemplate`, strict) because ExcelJS never
   * finishes these files. Plain data; the host maps it with Prisma (`resolveAmazonCatalogWorkbook`).
   */
  | { kind: 'amazon'; parsed: AmazonTemplateParse; expandedBytes: number }

/**
 * Per-part reading options the host passes through: the catalog page's "Blank cells" choice, and its chosen
 * marketplace — an eBay sheet named after its family states no market, so the operator's choice is the last hint.
 */
export interface PartOptions { blankPolicy?: 'ignore' | 'clear'; market?: string }

export type HostMessage =
  | { type: 'part'; partId: number; bytes: Uint8Array; filename: string; batchBudgetBytes: number; options?: PartOptions }
  | { type: 'answer'; askId: number; value?: unknown; error?: string }

export type WorkerMessage =
  | { type: 'ask'; askId: number; need: 'baseline'; exportId: string }
  | { type: 'part-done'; partId: number; outcome: PartOutcome; elapsedMs: number }
  | { type: 'part-failed'; partId: number; message: string; elapsedMs: number }
