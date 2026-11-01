import { defineManifest, PUBLIC } from '../../../core/manifest'

/**
 * Clock in and out (B-W2b-33; MES-223, MES-224, MES-239, MES-199). Floor only. The signed-in worker's own clock at the
 * device's site (`site`, floor.work: every floor role holds it). The tablet's clock is public like the floor sign-in:
 * the handler checks the device token and the CSRF double submit itself, then the badge (or the name and PIN) proves
 * the person; per-device rate limit. Before any of them reads or records a person's time, the site's ATTENDANCE legal
 * gate (B-W2b-27; Statuto dei Lavoratori art. 4 c.2-3). The automatic clock-out (MES-227) is the scheduler's.
 */
export const manifest = defineManifest({
  'GET /people/clock/floor': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'POST /people/clock/floor': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'POST /people/clock/scan': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
})
