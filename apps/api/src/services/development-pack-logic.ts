/**
 * FP.8 — pure factory-pack assembly rules, extracted from the route so
 * they can be verified independently. classifyPackFile decides how each
 * attachment is treated in the pack (image → embedded, pdf → merged
 * appendix, other → QR file index); partitionPackAttachments buckets a
 * project's attachments accordingly.
 */

export type PackFileClass = 'image' | 'pdf' | 'other'

export function classifyPackFile(nameOrUrl: string): PackFileClass {
  if (/\.(jpe?g|png|webp|gif|bmp|tiff?)($|\?)/i.test(nameOrUrl)) return 'image'
  if (/\.pdf($|\?)/i.test(nameOrUrl)) return 'pdf'
  return 'other'
}

export interface PackAttachmentLike {
  url: string
  filename: string | null
  caption?: string | null
}

export function partitionPackAttachments(atts: PackAttachmentLike[]): {
  images: Array<{ url: string; caption: string | null }>
  pdfUrls: string[]
  otherFiles: Array<{ url: string; filename: string | null }>
} {
  const images: Array<{ url: string; caption: string | null }> = []
  const pdfUrls: string[] = []
  const otherFiles: Array<{ url: string; filename: string | null }> = []
  for (const a of atts) {
    switch (classifyPackFile(a.filename ?? a.url)) {
      case 'image': images.push({ url: a.url, caption: a.caption ?? null }); break
      case 'pdf': pdfUrls.push(a.url); break
      default: otherFiles.push({ url: a.url, filename: a.filename })
    }
  }
  return { images, pdfUrls, otherFiles }
}
