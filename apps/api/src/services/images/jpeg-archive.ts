import JSZip from 'jszip'
import sharp from 'sharp'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'
import { fetchCatalogSource } from '../pim/catalog-source-fetch.js'

/** Each caller's own sentences: the studio's safety export chooses SKUs, the Media page's Amazon ZIP does not. */
export interface JpegArchiveWords {
  /** The build passed its deadline. */
  tooLong: string
  /** The archive would pass its size limit, in MB. */
  tooBig(mb: number): string
  /** Said after one photo's failure. */
  nothingSaved: string
}

class PastDeadline extends Error {}

/**
 * One ZIP of real JPEGs for Seller Central, from photo addresses (Images rebuild P4d; the engine of the studio's safety
 * export, now shared). Each address is downloaded once through the safe fetcher (public HTTP(S) only), 4 at a time,
 * decoded, turned upright, flattened on white and written as a JPEG (quality 100, 4:4:4). All or nothing: one failed
 * photo stops the archive with that photo's name, so an archive that looks complete never misses a file. The deadline
 * also stops a download in progress, so the server answers before a proxy in front of it gives up.
 */
export async function buildJpegArchive(files: ReadonlyArray<{ name: string; url: string; label: string }>, words: JpegArchiveWords, options: { deadlineMs?: number; maxBytes?: number } = {}) {
  const deadline = Date.now() + (options.deadlineMs ?? 90_000)
  const maxBytes = options.maxBytes ?? 100 * 1024 * 1024
  const tooBig = () => new WorkspaceScopeError(words.tooBig(Math.round(maxBytes / 1024 / 1024)), 422)
  const sources = [...new Set(files.map(f => f.url))]
  const images = new Map<string, Buffer>()
  let next = 0; let bytes = 0; let failed = false
  const convert = async (url: string) => {
    const { buffer } = await fetchCatalogSource(url)
    const decoded = sharp(buffer, { limitInputPixels: 64_000_000, failOn: 'warning' })
    const metadata = await decoded.metadata()
    if (!metadata.format || !['jpeg', 'png', 'webp', 'tiff', 'gif'].includes(metadata.format) || (metadata.pages ?? 1) !== 1) throw new Error('Use a single-frame JPEG, PNG, WebP, TIFF or GIF image.')
    // Preserve resolution and framing; standardize upload filenames to .jpg.
    const jpeg = await decoded.rotate().flatten({ background: '#ffffff' }).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer()
    if (jpeg.length > 10 * 1024 * 1024) throw new Error('The exported JPEG exceeds 10 MB. Use a smaller source image.')
    return jpeg
  }
  await Promise.all(Array.from({ length: Math.min(4, sources.length) }, async () => {
    while (!failed && next < sources.length) {
      const url = sources[next++]
      const file = files.find(f => f.url === url)!
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const work = convert(url)
        work.catch(() => undefined) // a download the deadline left behind must not fail the process later
        const jpeg = await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PastDeadline()), Math.max(0, deadline - Date.now())) })])
        bytes += jpeg.length * files.filter(f => f.url === url).length
        if (bytes > maxBytes) { failed = true; throw tooBig() }
        images.set(url, jpeg)
      } catch (error) {
        failed = true
        if (error instanceof WorkspaceScopeError) throw error
        if (error instanceof PastDeadline) throw new WorkspaceScopeError(words.tooLong, 422)
        const reason = (error instanceof Error ? error.message : '').trim() || 'Image download failed.'
        throw new WorkspaceScopeError(`${file.label}: ${/[.!?]$/.test(reason) ? reason : `${reason}.`} ${words.nothingSaved}`, 422)
      } finally { clearTimeout(timer) }
    }
  }))
  const zip = new JSZip()
  for (const file of files) zip.file(file.name, images.get(file.url)!)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
}
