import { defineManifest } from '../../../core/manifest'

/**
 * Measurements by link (B-W2b-171; SAL-096, SAL-286; design links.measure, SCR-195).
 *
 * The link (link sessions of a MEASUREMENTS link, its one profile): opening the page is links.open; the notice's tick, the
 * photos and the send are links.submit (the notice and photos before the send: each refused until the notice was ticked).
 * The office: a link made, the day the photos go (sales.measurements.manage); who sent what and a photo opened
 * (sales.measurements.view, each opening recorded). The handlers check the profile's party (and company) with can().
 */
const open = { audiences: ['link'], permission: 'links.open', scope: 'record' } as const
const submit = { audiences: ['link'], permission: 'links.submit', scope: 'record' } as const
const view = { audiences: ['office'], permission: 'sales.measurements.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'sales.measurements.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /link/measure': open,
  'POST /link/measure': submit,
  'POST /link/measure/notice': submit,
  'POST /link/measure/photos': submit,
  'POST /link/measure/photos/:fileId/complete': submit,
  'GET /link/measure/photos/:fileId/preview': submit,

  'POST /sales/measure-links': manage,
  'GET /sales/measurement-profiles/:profileId/sent': view,
  'POST /sales/measurement-profiles/:profileId/photos/:fileId/open': view,
  'POST /sales/measurement-profiles/:profileId/photos-delete-after': manage,
})
