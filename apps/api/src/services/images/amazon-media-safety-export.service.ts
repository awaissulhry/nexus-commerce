import JSZip from 'jszip'
import sharp from 'sharp'
import { planAmazonSafetyExport } from '@nexus/shared/amazon-media'
import { WorkspaceScopeError, type WorkspaceDestination } from '../pim/workspace-destination.js'
import { fetchCatalogSource } from '../pim/catalog-source-fetch.js'
import { readAmazonMedia } from './amazon-media-workspace.service.js'

/** Export the exact saved PS assignments. No Amazon write or publication status is produced. */
export async function exportAmazonSafetyImages(destination: WorkspaceDestination, revision: string, listingIds: string[]) {
  const workspace = await readAmazonMedia(destination)
  if (workspace.revision !== revision) throw new WorkspaceScopeError('The saved images changed. Reload before exporting.')
  const plan = planAmazonSafetyExport(workspace, listingIds)
  if (plan.issues.length) throw new WorkspaceScopeError(plan.issues.join('\n'), 422)
  if (!plan.files.length) throw new WorkspaceScopeError('Choose SKUs with safety images to export.', 422)
  const started = Date.now()
  const sources = [...new Set(plan.files.map(f => f.url))]
  const images = new Map<string, Buffer>()
  let next = 0; let bytes = 0; let failed = false
  // Bound concurrent downloads and total archive size. A failed source blocks the
  // entire download so an apparently complete archive can never omit a PS image.
  await Promise.all(Array.from({ length: Math.min(4, sources.length) }, async () => {
    while (!failed && next < sources.length) {
      if (Date.now() - started > 90_000) throw new WorkspaceScopeError('Export took too long. Choose fewer SKUs and try again.', 422)
      const url = sources[next++]
      const file = plan.files.find(f => f.url === url)!
      try {
        const { buffer } = await fetchCatalogSource(url)
        const decoded = sharp(buffer, { limitInputPixels: 64_000_000, failOn: 'warning' })
        const metadata = await decoded.metadata()
        if (!metadata.format || !['jpeg', 'png', 'webp', 'tiff', 'gif'].includes(metadata.format) || (metadata.pages ?? 1) !== 1) throw new Error('Use a single-frame JPEG, PNG, WebP, TIFF or GIF image.')
        // Preserve resolution and framing; standardize upload filenames to .jpg.
        const jpeg = await decoded.rotate().flatten({ background: '#ffffff' }).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer()
        if (jpeg.length > 10 * 1024 * 1024) throw new Error('The exported JPEG exceeds 10 MB. Use a smaller source image.')
        bytes += jpeg.length * plan.files.filter(f => f.url === url).length
        if (bytes > 100 * 1024 * 1024) throw new Error('This export exceeds 100 MB. Choose fewer SKUs.')
        images.set(url, jpeg)
      } catch (error) {
        failed = true
        throw new WorkspaceScopeError(`${file.asin} · ${file.slot}: ${error instanceof Error ? error.message : 'Image download failed.'} No archive was generated.`, 422)
      }
    }
  }))
  const current = await readAmazonMedia(destination)
  if (current.revision !== revision) throw new WorkspaceScopeError('Images or listing identity changed during export. Reload and export the new saved draft.')
  const zip = new JSZip()
  for (const file of plan.files) zip.file(`${file.asin}.${file.slot}.jpg`, images.get(file.url)!)
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
  const market = workspace.destination.marketplace.replace(/[^A-Z0-9]/gi, '')
  return { buffer, filename: `amazon-${market}-safety-${revision.slice(0, 12)}.zip`, fileCount: plan.files.length }
}
