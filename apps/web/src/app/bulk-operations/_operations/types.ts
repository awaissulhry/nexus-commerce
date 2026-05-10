'use client'

import type * as React from 'react'

/**
 * W1.7 — types shared by every bulk-operation config.
 *
 * SCHEMA_FIELD_UPDATE is intentionally NOT in OperationType. It maps
 * to a separate POST /api/products/bulk-schema-update flow that does
 * NOT persist a BulkActionJob row — see the W1.2 audit notes in
 * bulk-action.service.ts for context. The modal still surfaces it as
 * a tab, but the value lives in `BulkOperationModal`'s local
 * `OperationType` extension, not here.
 */
export type OperationType =
  | 'PRICING_UPDATE'
  | 'INVENTORY_UPDATE'
  | 'STATUS_UPDATE'
  | 'ATTRIBUTE_UPDATE'
  | 'LISTING_SYNC'
  | 'MARKETPLACE_OVERRIDE_UPDATE'
  // W11/W12 operator-facing surfaces. Mirror BulkActionType in
  // apps/api/src/services/bulk-action.service.ts; isKnownBulkActionType
  // there enforces the runtime allowlist.
  | 'AI_TRANSLATE_PRODUCT'
  | 'AI_SEO_REGEN'
  | 'AI_ALT_TEXT'
  | 'CHANNEL_BATCH'

export interface OperationConfig {
  type: OperationType
  label: string
  description: string
  /** Default action payload. */
  initialPayload: Record<string, unknown>
  /** True if the user must provide non-empty values to proceed. */
  isPayloadValid: (p: Record<string, unknown>) => boolean
  /** Render parameter inputs. */
  renderParams: (
    payload: Record<string, unknown>,
    setPayload: (next: Record<string, unknown>) => void,
  ) => React.ReactNode
}
