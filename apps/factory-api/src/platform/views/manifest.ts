import { defineManifest, SIGNED_IN } from '../../core/manifest'

/**
 * Saved views (B-W2a-23; PLT-163). Office only. Reading the views of a list needs no permission (a person sees their
 * own, those shared with everyone and those shared with a role they hold); writes need views.save, and the handler asks
 * views.manage for sharing with everyone, a role's default and the views others shared. Writes take an Idempotency-Key.
 */
export const manifest = defineManifest({
  'GET /views': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
  'POST /views': { audiences: ['office'], permission: 'views.save', scope: 'record' },
  'GET /views/:viewId': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
  'PATCH /views/:viewId': { audiences: ['office'], permission: 'views.save', scope: 'record' },
  'DELETE /views/:viewId': { audiences: ['office'], permission: 'views.save', scope: 'record' },
  // B-W2b-13 (bulk/): bulk edit with preview and inline edit; the handler asks the list's own write permission over the
  // screen's company and each row's command asks it again over the row (the apply takes an Idempotency-Key).
  'POST /views/bulk/preview': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'POST /views/bulk/apply': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
})
