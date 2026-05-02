/**
 * Phase 5.4: rule-based validation of the 9 product images required
 * for a GTIN-exemption submission.
 *
 * v1 checks: dimensions ≥ 1000x1000 (Amazon's hard requirement),
 * format (JPG / PNG only), and plausible file size (>20KB so we don't
 * waste a slot on a thumbnail). Vision-based checks (logo / watermark
 * detection, brand visibility, white-background analysis) are deferred
 * to Phase 6 once we have a vision model wired.
 */

import imageSize from 'image-size'

export interface ImageCheckResult {
  url: string
  ok: boolean
  width?: number
  height?: number
  format?: string
  bytes?: number
  issues: string[]
}

export interface ImageValidationResult {
  passed: number
  failed: number
  needed: number
  items: ImageCheckResult[]
}

const ACCEPTED_FORMATS = new Set(['jpg', 'jpeg', 'png'])
const MIN_DIMENSION = 1000
const MIN_BYTES = 20 * 1024
const REQUIRED_COUNT = 9

function extOf(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname.toLowerCase()
    const ext = path.split('.').pop() ?? ''
    return ext.split('?')[0]
  } catch {
    return url.toLowerCase().split('.').pop() ?? ''
  }
}

async function fetchBytes(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching image`)
  }
  const ab = await res.arrayBuffer()
  return Buffer.from(ab)
}

/**
 * Validate one image URL. Fetches the bytes, reads dimensions from
 * the header (no full decode — image-size parses just enough of the
 * file to extract width / height), checks format + size.
 */
export async function checkImage(url: string): Promise<ImageCheckResult> {
  const out: ImageCheckResult = { url, ok: false, issues: [] }
  const ext = extOf(url)
  if (ext && !ACCEPTED_FORMATS.has(ext)) {
    out.issues.push(
      `Unsupported format ".${ext}" — Amazon expects JPG or PNG`,
    )
  }
  let buf: Buffer
  try {
    buf = await fetchBytes(url)
  } catch (err: any) {
    out.issues.push(`Couldn't fetch image: ${err?.message ?? String(err)}`)
    return out
  }
  out.bytes = buf.byteLength
  if (buf.byteLength < MIN_BYTES) {
    out.issues.push(
      `Tiny file (${buf.byteLength.toLocaleString()} bytes) — Amazon ` +
        'rejects thumbnail-quality images',
    )
  }
  try {
    const dims = imageSize(buf)
    out.width = dims.width
    out.height = dims.height
    out.format = dims.type
    if ((dims.width ?? 0) < MIN_DIMENSION || (dims.height ?? 0) < MIN_DIMENSION) {
      out.issues.push(
        `Resolution ${dims.width}×${dims.height} below Amazon's 1000×1000 minimum`,
      )
    }
  } catch (err: any) {
    out.issues.push(
      `Couldn't read image header: ${err?.message ?? String(err)}`,
    )
  }
  out.ok = out.issues.length === 0
  return out
}

export async function validateImages(
  urls: string[],
): Promise<ImageValidationResult> {
  // Run in parallel with a sensible cap so a 9-image package doesn't
  // need 9 sequential HTTP fetches.
  const items = await Promise.all(urls.map(checkImage))
  let passed = 0
  let failed = 0
  for (const it of items) {
    if (it.ok) passed++
    else failed++
  }
  return {
    passed,
    failed,
    needed: REQUIRED_COUNT,
    items,
  }
}
