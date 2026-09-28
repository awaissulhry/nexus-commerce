import { planAmazonSafetyExport } from '@nexus/shared/amazon-media'
import { WorkspaceScopeError, type WorkspaceDestination } from '../pim/workspace-destination.js'
import { buildJpegArchive } from './jpeg-archive.js'
import { readAmazonMedia } from './amazon-media-workspace.service.js'
import { isOnMediaPlan } from './media-plan-switch.js'

/** Export the exact saved PS assignments. No Amazon write or publication status is produced. */
export async function exportAmazonSafetyImages(destination: WorkspaceDestination, revision: string, listingIds: string[]) {
  // Images rebuild P4d — a family on the photo plan exports from the Media page; this store's PS images are not its photos.
  if (await isOnMediaPlan(destination.familyId)) throw new WorkspaceScopeError('This product\'s photos are managed on the Media page. Export its safety images there: open Amazon, then Export ZIP for Seller Central.', 409)
  const workspace = await readAmazonMedia(destination)
  if (workspace.revision !== revision) throw new WorkspaceScopeError('The saved images changed. Reload before exporting.')
  const plan = planAmazonSafetyExport(workspace, listingIds)
  if (plan.issues.length) throw new WorkspaceScopeError(plan.issues.join('\n'), 422)
  if (!plan.files.length) throw new WorkspaceScopeError('Choose SKUs with safety images to export.', 422)
  const buffer = await buildJpegArchive(plan.files.map(f => ({ name: `${f.asin}.${f.slot}.jpg`, url: f.url, label: `${f.asin} · ${f.slot}` })),
    { tooLong: 'Export took too long. Choose fewer SKUs and try again.', tooBig: mb => `This export exceeds ${mb} MB. Choose fewer SKUs.`, nothingSaved: 'No archive was generated.' })
  const current = await readAmazonMedia(destination)
  if (current.revision !== revision) throw new WorkspaceScopeError('Images or listing identity changed during export. Reload and export the new saved draft.')
  const market = workspace.destination.marketplace.replace(/[^A-Z0-9]/gi, '')
  return { buffer, filename: `amazon-${market}-safety-${revision.slice(0, 12)}.zip`, fileCount: plan.files.length }
}
