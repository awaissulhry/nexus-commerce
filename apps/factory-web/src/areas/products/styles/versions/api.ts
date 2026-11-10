import { z } from 'zod'
import { styleVersionsView, type StyleVersionsView } from '@nexus/factory-domain/product/versions/contracts'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The Versions & changes tab's own read (B-W2b-220): every revision of the style, newest first, with its state, why it
 * changed, who released it and when, whether it is locked, and the records made from it (null: not in the reader's role).
 * The compare, the drift and the style's change requests and orders are read with Changes & versions' calls
 * (areas/products/changes/api.ts: readCompare, readDrift, listRequests, listOrders), never copied here.
 */

export type { StyleVersionsView }
export type VersionRow = StyleVersionsView['revisions'][number]

export function readVersions(api: ApiClient, styleId: string, signal?: AbortSignal): Promise<StyleVersionsView> {
  return api.get(`/product/styles/${encodeURIComponent(styleId)}/versions`, { schema: z.object({ versions: styleVersionsView }), signal }).then((answer) => answer.versions)
}
