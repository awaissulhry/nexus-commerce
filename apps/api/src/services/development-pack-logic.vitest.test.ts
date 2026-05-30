/**
 * FP.8 — verifier cases for factory-pack file assembly.
 */

import { describe, it, expect } from 'vitest'
import { classifyPackFile, partitionPackAttachments } from './development-pack-logic.js'

describe('classifyPackFile', () => {
  it('classifies images', () => {
    for (const n of ['a.jpg', 'a.JPEG', 'b.png', 'c.webp', 'd.gif', 'e.tiff']) expect(classifyPackFile(n)).toBe('image')
  })
  it('classifies pdfs', () => {
    expect(classifyPackFile('techpack.pdf')).toBe('pdf')
    expect(classifyPackFile('TechPack.PDF')).toBe('pdf')
  })
  it('classifies everything else as other', () => {
    for (const n of ['design.ai', 'pattern.dxf', 'notes.txt', 'noext', 'file.zip']) expect(classifyPackFile(n)).toBe('other')
  })
  it('handles query strings on the url', () => {
    expect(classifyPackFile('https://cdn/x/photo.png?v=2')).toBe('image')
    expect(classifyPackFile('https://cdn/x/pack.pdf?token=abc')).toBe('pdf')
  })
})

describe('partitionPackAttachments', () => {
  it('buckets images / pdfs / others and preserves caption', () => {
    const out = partitionPackAttachments([
      { url: 'u1', filename: 'shot.jpg', caption: 'logo placement' },
      { url: 'u2', filename: 'pack.pdf' },
      { url: 'u3', filename: 'art.ai' },
      { url: 'u4', filename: null }, // falls back to url for classification → other
    ])
    expect(out.images).toEqual([{ url: 'u1', caption: 'logo placement' }])
    expect(out.pdfUrls).toEqual(['u2'])
    expect(out.otherFiles.map((o) => o.url).sort()).toEqual(['u3', 'u4'])
  })
  it('uses url extension when filename is null', () => {
    const out = partitionPackAttachments([{ url: 'https://cdn/photo.png', filename: null }])
    expect(out.images.length).toBe(1)
  })
  it('returns empty buckets for an empty list', () => {
    expect(partitionPackAttachments([])).toEqual({ images: [], pdfUrls: [], otherFiles: [] })
  })
})
