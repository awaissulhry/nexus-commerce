/**
 * Amazon serves the same image at any size via URL modifiers — e.g.
 *   …/images/I/41rem1s06zL._SL75_.jpg   (75px thumbnail)
 * is a sized variant of the full-resolution
 *   …/images/I/41rem1s06zL.jpg
 *
 * The modifier block (`_SL75_`, `_AC_SX466_`, `_UF1000,1000_`, …) sits between
 * the image id and the extension; an Amazon image id never contains a dot, so
 * stripping the middle dot-segment(s) yields the base full-res URL.
 *
 * No-op for non-Amazon URLs and for URLs that are already clean (so it's safe
 * to run over every ProductImage row — Cloudinary/DAM/other URLs pass through).
 */

const AMAZON_IMAGE_RE = /^(https?:\/\/[^/]*amazon[^/]*)(\/images\/I\/)([^/?#]+)(\?[^#]*)?(#.*)?$/i

export function normalizeAmazonImageUrl(url: string): string {
  if (typeof url !== 'string' || url.length === 0) return url
  const m = url.match(AMAZON_IMAGE_RE)
  if (!m) return url
  const [, host, path, filename, query = '', hash = ''] = m
  const parts = filename.split('.')
  // `<id>.<ext>` (2 parts) is already clean; `<id>.<transform…>.<ext>` strips.
  if (parts.length <= 2) return url
  const id = parts[0]
  const ext = parts[parts.length - 1]
  if (!id || !ext) return url
  return `${host}${path}${id}.${ext}${query}${hash}`
}
