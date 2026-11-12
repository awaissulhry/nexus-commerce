import { defineManifest } from '../../../core/manifest'

/**
 * Transfers between sites (B-W2b-326; SCM-219, SCM-220; design warehouse.transfers, SCR-360 and SCR-361). Office only,
 * scoped by record: a transfer belongs to its two sites (and maybe two companies), so every handler checks the end it acts
 * at with can() — reading at either end (inventory.stock.view), drafting, shipping and cancelling at the sending site,
 * receiving and settling at the receiving site (inventory.transfers.manage) — and the list filters by the sites the caller
 * sees. W1's POST /inventory/transfers (a move between two places of one site) is the ledger's and unchanged. Writes take
 * an Idempotency-Key.
 */
export const manifest = defineManifest({
  'GET /inventory/transfer-orders': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/transfer-orders/options': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'POST /inventory/transfer-orders': { audiences: ['office'], permission: 'inventory.transfers.manage', scope: 'record' },
  'GET /inventory/transfer-orders/:transferId': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'PATCH /inventory/transfer-orders/:transferId': { audiences: ['office'], permission: 'inventory.transfers.manage', scope: 'record' },
  'GET /inventory/transfer-orders/:transferId/stock': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'POST /inventory/transfer-orders/:transferId/lines': { audiences: ['office'], permission: 'inventory.transfers.manage', scope: 'record' },
  'PATCH /inventory/transfer-orders/:transferId/lines/:lineId': { audiences: ['office'], permission: 'inventory.transfers.manage', scope: 'record' },
  'POST /inventory/transfer-orders/:transferId/lines/:lineId/remove': { audiences: ['office'], permission: 'inventory.transfers.manage', scope: 'record' },
  'POST /inventory/transfer-orders/:transferId/ship': { audiences: ['office'], permission: 'inventory.transfers.manage', scope: 'record' },
  'POST /inventory/transfer-orders/:transferId/receive': { audiences: ['office'], permission: 'inventory.transfers.manage', scope: 'record' },
  'POST /inventory/transfer-orders/:transferId/lines/:lineId/settle': { audiences: ['office'], permission: 'inventory.transfers.manage', scope: 'record' },
  'POST /inventory/transfer-orders/:transferId/cancel': { audiences: ['office'], permission: 'inventory.transfers.manage', scope: 'record' },
  'GET /inventory/transfer-orders/:transferId/ddt/pdf': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'POST /inventory/transfer-orders/:transferId/ddt/pdf': { audiences: ['office'], permission: 'inventory.transfers.manage', scope: 'record' },
})
