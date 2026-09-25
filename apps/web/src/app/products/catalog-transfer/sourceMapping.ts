import type { TransferRow, TransferCell, TransferIssue, TransferMode, TransferPreview, ProductTransferBoundary } from '@nexus/shared/catalog-transfer'

export type SourceReference = { column: string } | { value: string }
export interface SourceBinding {
  source: string; entity: TransferRow['entity']; field: string; format: 'text' | 'json'; action?: TransferRow['action']; actionColumn?: string; versionColumn?: string
  channel?: SourceReference; accountId?: SourceReference; marketplace?: SourceReference; aliasKey?: SourceReference; locale?: SourceReference
}
export interface SourceMapping {
  kind: 'catalog-source-v1'; skuColumn: string; market: string; mode: TransferMode; bindings: SourceBinding[]
  policy: { shared: 'replace' | 'fill-empty' | 'exclude'; overrides: 'replace' | 'preserve' | 'exclude' }; execution?: 'review' | 'automatic'
}
export interface TransferOptions {
  listings?: ProductTransferBoundary['listings']
  channelCategories?: { channel: string; marketplace: string | null; productType: string; label?: string | null }[]
  families: { id: string; code: string; label: string }[]
  accounts: { id: string; channelType: string; marketplace: string | null; displayName: string | null }[]
  markets: { channel: string; code: string; name: string; language?: string }[]
}
export interface SourceInspection { sourceId: string; filename: string; headers: string[]; total: number; hash: string; sample: Record<string, string>[] }
export interface SourcePreset { id: string; name: string; columnMapping: SourceMapping; updatedAt: string; source: string; sourceUrl: string; enabled: boolean; cronExpression?: string; lastJobId?: string; lastStatus?: string; lastError?: string; nextRunAt?: string }
export interface TransferJob {
  hasChangeFilter?: boolean
  /** `skipped` is present only when a review of ready records skipped the refused ones (CFI-7). */
  receipt?: { saved: number; unchanged: number; failed: number; excluded: number; unprocessed: number; skipped?: number }
  boundary?: ProductTransferBoundary
  jobId: string; state: string; processed: number; total: number; mode: TransferMode; filename: string; reviewToken?: string; expiresAt: string
  counts: TransferPreview['counts'] & { productsAffected?: number; listingsAffected?: number; newOverrides?: number; preservedOverrides?: number; excluded?: number
    /** CFI (channel files): blank full-update cells already empty in Nexus / not checkable / cleared, listings ended, prices recorded without sending. */
    alreadyEmpty?: number; clearUnchecked?: number; cleared?: number; ended?: number; pricesRecorded?: number }
  /** CFI-4 — identity proposals from a channel file; confirming one re-checks the same file. */
  links?: { fileSku: string; proposedSku: string; reason: string }[]
  /**
   * CFI-3 — listings the file deletes on the channel; `confirmed` = they will be marked ended in Nexus.
   * `fileSku` is the SKU as written in the file — the identity a confirmation names; `sku` is the Nexus SKU.
   */
  deletes?: { fileSku: string; sku: string; channel: string; marketplace: string; accountId: string; evidence?: string; confirmed: boolean }[]
  readyOnly?: boolean
  warnings: string[]; unmappedColumns?: string[]; policy?: SourceMapping['policy']; cells?: TransferCell[]; issues?: TransferIssue[]; error?: string
}
export interface TransferOutcome { id: string; index: number; status: string; identity?: TransferRow; cells: TransferCell[]; preserved?: TransferCell[]; issues: TransferIssue[]; exclusions: TransferIssue[]; error?: string }
export interface OutcomePage { total: number; page: number; pageSize: number; rows: TransferOutcome[] }
export const defaultSourceMapping = (headers: string[], market: string, mode: TransferMode): SourceMapping => ({ kind: 'catalog-source-v1', skuColumn: headers.find(h => /^sku$/i.test(h)) ?? '', market, mode, bindings: [], policy: { shared: 'replace', overrides: 'preserve' } })
