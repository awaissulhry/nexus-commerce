import type { MaterialWhereUsedView } from '@nexus/factory-domain/product/materials-depth/contracts'
import type { ListKey } from '../../../../list-frame/model'

/**
 * Where a material is used (B-W2b-238; SCR-048 Where used), pure: a row's key (a line, or an alternate on it: one line may
 * name the material as both), the revision tones, the list's own keys (none: the frame's).
 */

export type WhereUsedRow = MaterialWhereUsedView['rows'][number]

export const rowKey = (row: Pick<WhereUsedRow, 'lineId' | 'priority'>): string => `${row.lineId}:${row.priority ?? 0}`

export const REVISION_TONE: Readonly<Record<string, 'info' | 'success' | 'neutral'>> = { DRAFT: 'info', RELEASED: 'success', OBSOLETE: 'neutral' }

export const whereUsedKeys: readonly ListKey[] = []
