/**
 * Google Ads changes (2026-10-16, programme 2 group G14b) — the files of uploaded Display ads: an HTML5 ad's ZIP (a
 * MEDIA_BUNDLE asset of a display upload ad) fetched from an https link, and the sizes and weight Google takes for an
 * uploaded image ad. The bytes go to Google inside the change (MediaBundleAsset.data, "Media bundle (ZIP file) asset data
 * … This field is mutate only": base64 in Google's JSON), so the change is built on the file as it is now; the run fetches
 * it again and sends it only when its bytes are what was approved (the operations hold them).
 *
 * Fetched only through the one public-address fetch (net/safe-fetch.ts, as asset-images.ts's photos are): https only
 * (every redirect too), public internet addresses only, bounded time and bytes. Then Google's rules, checked 2026-10-16:
 *   reference/rpc/v25/DisplayUploadAdInfo  display_upload_product_type + media_asset oneof media_bundle (AdMediaBundleAsset
 *                    .asset: the MEDIA_BUNDLE asset's resource name). DisplayUploadProductType: HTML5_UPLOAD_AD ("requires the
 *                    upload_media_bundle field … to be set") — the only one a plain Display campaign takes; every
 *                    DYNAMIC_HTML5_* type "Can only be used in a" custom / education / flight / hotel / job / local / real
 *                    estate / travel campaign (dynamic remarketing feeds), so Nexus does not make them.
 *   reference/rpc/v25/MediaBundleAsset  data (bytes, mutate only); AssetType MEDIA_BUNDLE; Asset.media_bundle_asset Immutable.
 *   google-ads-python examples/advanced_operations/add_display_upload_ad.py  an Asset (type MEDIA_BUNDLE, a name, the
 *                    ZIP's bytes) and an ad (name, final_urls, display_upload_ad {media_bundle.asset,
 *                    display_upload_product_type HTML5_UPLOAD_AD}); "This feature is only available to allowlisted accounts."
 *   support.google.com/google-ads/answer/1722096 (Uploaded display ads specifications, read 2026-10-16): HTML5 — "a ZIP file
 *                    containing a single HTML document … and up to 39 media assets", HTML and optionally CSS, JS, GIF, PNG,
 *                    JPG, JPEG, SVG, "600 KB or smaller", "no more than 40 files", the size meta tag
 *                    `<meta name="ad.size" content="width=300,height=250">` in the head, one of the listed ad sizes; access
 *                    to HTML5 ads needs the account to be eligible (open > 90 days, lifetime spend, policy history) and to
 *                    apply. Image ads — GIF, JPG, PNG, "Max. size 150KB", the same listed sizes (plus regional ones).
 *   reference/rpc/v25/AdErrorEnum  MISSING_IMAGE_OR_MEDIA_BUNDLE, PRODUCT_TYPE_NOT_SUPPORTED_IN_THIS_CAMPAIGN (Google's check
 *                    judges the campaign).
 *
 * Reads the web; writes nothing.
 */
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { safeFetch, SafeFetchError } from '../../net/safe-fetch.js'

/** "Supported file size: 600 KB or smaller" (HTML5). */
export const HTML5_ZIP_MAX_BYTES = 600 * 1024
/** "no more than 40 files may be included in a ZIP folder". */
export const HTML5_ZIP_MAX_FILES = 40
/** "ZIP containing HTML and optionally CSS, JS, GIF, PNG, JPG, JPEG, SVG". */
export const HTML5_FILE_TYPES = ['html', 'htm', 'css', 'js', 'gif', 'png', 'jpg', 'jpeg', 'svg'] as const
/** "Max. size 150KB" (uploaded image ads). */
export const IMAGE_AD_MAX_BYTES = 150 * 1024

/**
 * The ad sizes Google lists for uploaded image and HTML5 ads (answer 1722096: the main table and the regionally available
 * sizes — PL billboards 750×100 / 750×200 / 750×300; the other regional ones are in the main table too).
 */
export const DISPLAY_AD_SIZES = [
  '200x200', '240x400', '250x250', '250x360', '300x250', '336x280', '580x400', '120x600', '160x600', '300x600', '300x1050',
  '468x60', '728x90', '930x180', '970x90', '970x250', '980x120', '300x50', '320x50', '320x100', '750x100', '750x200', '750x300',
] as const
const SIZES_TEXT = DISPLAY_AD_SIZES.map((s) => s.replace('x', '×')).join(', ')
/** Why an uploaded display ad of this size is refused by Google, or null. */
export const displaySizeProblem = (where: string, width: number | null, height: number | null): string | null =>
  !width || !height
    ? `${where}: Nexus could not read its width and height`
    : (DISPLAY_AD_SIZES as readonly string[]).includes(`${width}x${height}`)
      ? null
      : `${where} is ${width}×${height}: Google takes uploaded display ads of ${SIZES_TEXT} only`

/** A ZIP ready to send: its bytes (base64) and what Nexus read from it (never the bytes in a record). */
export interface PreparedBundle {
  /** The https link it was read from (after redirects). */
  source: string
  /** A name for the asset: the file name of the link. */
  label: string | null
  bytes: number
  sha256: string
  files: number
  /** The primary HTML document's path inside the ZIP. */
  html: string
  width: number
  height: number
  /** The bytes, base64 (Google's JSON for a bytes field). */
  data: string
}

interface ZipEntry { name: string; method: number; flags: number; compressed: number; size: number; offset: number }

/** The entries of a ZIP's central directory, or why it is not a ZIP Google takes (ZIP64, encrypted, broken). */
export function zipEntries(buf: Buffer): ZipEntry[] | { problem: string } {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) return { problem: 'it is not a ZIP file' }
  // The end of central directory record: within the last 22 + 65,535 bytes (its comment is at most 65,535).
  let end = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break }
  }
  if (end < 0) return { problem: 'its ZIP directory is missing (the file is cut off or broken)' }
  const count = buf.readUInt16LE(end + 10)
  const size = buf.readUInt32LE(end + 12)
  const start = buf.readUInt32LE(end + 16)
  if (count === 0xffff || start === 0xffffffff) return { problem: 'it is a ZIP64 file: save it as a plain ZIP' }
  if (start + size > end) return { problem: 'its ZIP directory is broken' }
  const out: ZipEntry[] = []
  let at = start
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) return { problem: 'its ZIP directory is broken' }
    const nameLength = buf.readUInt16LE(at + 28)
    const next = at + 46 + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32)
    if (next > buf.length) return { problem: 'its ZIP directory is broken' }
    out.push({
      name: buf.subarray(at + 46, at + 46 + nameLength).toString('utf8'),
      flags: buf.readUInt16LE(at + 8),
      method: buf.readUInt16LE(at + 10),
      compressed: buf.readUInt32LE(at + 20),
      size: buf.readUInt32LE(at + 24),
      offset: buf.readUInt32LE(at + 42),
    })
    at = next
  }
  return out
}

/** One entry's content (stored or deflated), at most `max` bytes, or null when it cannot be read. */
function entryContent(buf: Buffer, e: ZipEntry, max: number): Buffer | null {
  if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) return null
  const from = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28)
  const raw = buf.subarray(from, from + e.compressed)
  if (raw.length !== e.compressed) return null
  try {
    if (e.method === 0) return raw.subarray(0, max)
    if (e.method === 8) return inflateRawSync(raw, { maxOutputLength: max })
  } catch { /* larger than `max`, or not deflate: said by the caller */ }
  return null
}

const AD_SIZE = /<meta\b[^>]*\bname\s*=\s*["']ad\.size["'][^>]*>/i
const SIZE_VALUE = /\bcontent\s*=\s*["']\s*width\s*=\s*(\d{1,5})\s*,\s*height\s*=\s*(\d{1,5})\s*["']/i

/**
 * What Google's HTML5 rules say of a ZIP (above): every problem at once, or the primary HTML document and its ad size.
 * Pure (the bytes in, words out).
 */
export function inspectHtml5Zip(buf: Buffer): { files: number; html: string; width: number; height: number } | { problems: string[] } {
  if (buf.length > HTML5_ZIP_MAX_BYTES) return { problems: [`it is ${Math.ceil(buf.length / 1024)} KB: Google takes an HTML5 ZIP of at most 600 KB`] }
  const entries = zipEntries(buf)
  if ('problem' in entries) return { problems: [entries.problem] }
  const problems: string[] = []
  const files = entries.filter((e) => !e.name.endsWith('/'))
  if (files.length > HTML5_ZIP_MAX_FILES) problems.push(`it holds ${files.length} files: Google takes at most ${HTML5_ZIP_MAX_FILES}`)
  if (files.some((e) => e.flags & 1)) problems.push('it is encrypted: Google cannot read it')
  const other = files.filter((e) => !(HTML5_FILE_TYPES as readonly string[]).includes(e.name.slice(e.name.lastIndexOf('.') + 1).toLowerCase()))
  if (other.length) problems.push(`it holds ${other.slice(0, 3).map((e) => `"${e.name.slice(0, 60)}"`).join(', ')}${other.length > 3 ? ` and ${other.length - 3} more` : ''}: Google takes HTML, CSS, JS, GIF, PNG, JPG, JPEG and SVG files only`)
  const html = files.filter((e) => /\.html?$/i.test(e.name))
  if (html.length !== 1) problems.push(html.length ? `it holds ${html.length} HTML documents: Google takes ONE (the primary asset)` : 'it holds no HTML document (the primary asset)')
  if (problems.length) return { problems }
  const text = entryContent(buf, html[0], 2 * 1024 * 1024)
  if (!text) return { problems: [`Nexus could not read "${html[0].name}" inside it`] }
  const meta = text.toString('utf8').match(AD_SIZE)
  const size = meta?.[0].match(SIZE_VALUE)
  if (!size) return { problems: [`"${html[0].name}" has no size tag: Google needs <meta name="ad.size" content="width=300,height=250"> (the ad's size) in its head`] }
  const width = Number(size[1])
  const height = Number(size[2])
  const p = displaySizeProblem('the ad (its ad.size tag)', width, height)
  return p ? { problems: [p] } : { files: files.length, html: html[0].name, width, height }
}

const fileNameOf = (link: URL): string | null => {
  const last = link.pathname.split('/').filter(Boolean).pop() ?? ''
  try { return decodeURIComponent(last).replace(/\.zip$/i, '').slice(0, 80) || null } catch { return null }
}

/** Fetch an HTML5 ad's ZIP from an https link and check it, or say why it cannot be one (nothing was sent to Google). */
export async function prepareMediaBundle(link: string): Promise<PreparedBundle | { problem: string }> {
  let url: URL
  try { url = new URL(link.trim()) } catch { return { problem: `"${link.slice(0, 80)}" is not a web address` } }
  if (url.protocol !== 'https:') return { problem: `${url.host}: only an https:// link is fetched` }
  let fetched: Awaited<ReturnType<typeof safeFetch>>
  try {
    // Google's cap is the fetch's own: a file over 600 KB stops there, nothing more is read.
    fetched = await safeFetch(url.toString(), { maxBytes: HTML5_ZIP_MAX_BYTES, timeoutMs: 15_000, maxRedirects: 3, httpsOnly: true })
  } catch (error) {
    if (error instanceof SafeFetchError) {
      if (error.reason === 'too_large') return { problem: `${url.host}: the ZIP is larger than 600 KB (Google takes at most 600 KB)` }
      if (error.reason === 'refused') return { problem: `${url.host}: ${error.message}` }
      return { problem: `${url.host}: the link answered HTTP ${error.status ?? '?'}` }
    }
    return { problem: `${url.host}: the link could not be read (${error instanceof Error ? error.message : String(error)})` }
  }
  const where = fetched.url.toString()
  const checked = inspectHtml5Zip(fetched.buffer)
  if ('problems' in checked) return { problem: `${where}: ${checked.problems.join('; ')}` }
  return {
    source: where,
    label: fileNameOf(fetched.url),
    bytes: fetched.buffer.byteLength,
    sha256: createHash('sha256').update(fetched.buffer).digest('hex'),
    ...checked,
    data: fetched.buffer.toString('base64'),
  }
}
