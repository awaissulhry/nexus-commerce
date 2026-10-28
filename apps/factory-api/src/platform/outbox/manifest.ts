import { defineManifest, SIGNED_IN } from '../../core/manifest'

/**
 * The outbox's routes (plan A1 §3.5). `GET /live` is the live-screen stream: any signed-in office or floor session of a
 * tenant; what each event needs (its definition's live permission, the floor's own site) is checked per event and per
 * viewer by liveViewFor.
 */
export const manifest = defineManifest({
  'GET /live': { audiences: ['office', 'floor'], permission: SIGNED_IN, scope: 'tenant' },
})
