/**
 * Phase G — canonical API-key scope registry (web mirror).
 *
 * MUST stay byte-identical to apps/api/src/lib/api-key-auth.ts's
 * CANONICAL_SCOPES. Same drift-prevention pattern as the Italian
 * fiscal validators: when you add or rename a scope, change both
 * files in the same commit.
 */

export interface ScopeDef {
  value: string
  label: string
  description: string
  group: 'Catalog' | 'Sales' | 'Operations' | 'Analytics' | 'Admin'
}

export const CANONICAL_SCOPES: readonly ScopeDef[] = [
  {
    value: 'products:read',
    label: 'Read products',
    description: 'List + read product master data.',
    group: 'Catalog',
  },
  {
    value: 'products:write',
    label: 'Write products',
    description: 'Create, update, soft-delete products.',
    group: 'Catalog',
  },
  {
    value: 'listings:read',
    label: 'Read listings',
    description: 'View channel listings + coverage + sync status.',
    group: 'Catalog',
  },
  {
    value: 'listings:write',
    label: 'Write listings',
    description: 'Publish + edit channel listings, trigger syncs.',
    group: 'Catalog',
  },
  {
    value: 'orders:read',
    label: 'Read orders',
    description: 'List orders + line items + customer fields.',
    group: 'Sales',
  },
  {
    value: 'orders:write',
    label: 'Write orders',
    description: 'Fulfill, refund, edit orders.',
    group: 'Sales',
  },
  {
    value: 'stock:read',
    label: 'Read stock',
    description: 'Stock levels, lots, bins, replenishment forecasts.',
    group: 'Operations',
  },
  {
    value: 'stock:write',
    label: 'Write stock',
    description:
      'Adjust stock, create POs + receipts, lot tracking writes.',
    group: 'Operations',
  },
  {
    value: 'analytics:read',
    label: 'Read analytics',
    description: 'Reports, dashboards, profit + ad-spend rollups.',
    group: 'Analytics',
  },
  {
    value: 'admin',
    label: 'Admin',
    description:
      'Super-scope — implies every other scope. Use sparingly; rotate often.',
    group: 'Admin',
  },
] as const

export const SCOPE_VALUES = new Set(CANONICAL_SCOPES.map((s) => s.value))
