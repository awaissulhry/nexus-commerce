import { describe, expect, it } from 'vitest'
import { isPicture, isStrippable, orientationSegment, readExif, stripImageMetadata } from './strip'

// Made-up pictures built byte by byte: the stripper never decodes the image data, so a few bytes of "scan data" stand in.
const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0))
const latin1 = (bytes: Uint8Array): string => Array.from(bytes, (b) => String.fromCharCode(b)).join('')
const segment = (marker: number, data: number[]): number[] => [0xff, marker, ((data.length + 2) >> 8) & 0xff, (data.length + 2) & 0xff, ...data]

/** A little-endian TIFF block: IFD0 with the orientation and, optionally, a GPS pointer plus a made-up position. */
function tiff(orientation: number, gps: boolean): number[] {
  const entries = gps ? 2 : 1
  const out = [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, entries, 0x00]
  out.push(0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00)
  if (gps) out.push(0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x30, 0x00, 0x00, 0x00)
  out.push(0x00, 0x00, 0x00, 0x00)
  // The "GPS block": a made-up latitude text the copy must not carry.
  out.push(...ascii('GPSLAT 45.4642 N'))
  return out
}

const SCAN = [0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a]
function jpeg(): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    ...segment(0xe0, [...ascii('JFIF\0'), 1, 2, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xe1, [...ascii('Exif\0\0'), ...tiff(6, true)]),
    ...segment(0xe1, [...ascii('http://ns.adobe.com/xap/1.0/\0'), ...ascii('<x:xmpmeta><exif:GPSLatitude>45,27.85N</exif:GPSLatitude><dc:creator>Made Up</dc:creator></x:xmpmeta>')]),
    ...segment(0xe2, [...ascii('ICC_PROFILE\0'), 1, 1, 0xaa, 0xbb]),
    ...segment(0xed, [...ascii('Photoshop 3.0\0'), ...ascii('8BIM made-up caption')]),
    ...segment(0xfe, ascii('taken by a made-up phone')),
    ...segment(0xdb, [0, ...Array.from({ length: 64 }, (_, i) => i + 1)]),
    ...segment(0xc0, [8, 0, 16, 0, 16, 1, 1, 0x11, 0]),
    ...segment(0xda, [1, 1, 0, 0, 63, 0]),
    ...SCAN,
    0xff, 0xd9,
    ...ascii('trailing made-up depth map'),
  ])
}

describe('JPEG', () => {
  it('drops EXIF with its GPS block, XMP, IPTC, comments and the trailer; keeps JFIF, ICC, the tables and the scan data; keeps the orientation', () => {
    const input = jpeg()
    const result = stripImageMetadata(input, 'image/jpeg')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.location).toBe(true)
    expect(result.removed).toEqual(['EXIF', 'GPS', 'XMP', 'IPTC', 'COMMENT', 'TRAILER'])
    const text = latin1(result.bytes)
    for (const gone of ['GPSLAT', 'GPSLatitude', 'Made Up', '8BIM', 'made-up phone', 'depth map', 'xap/1.0']) expect(text).not.toContain(gone)
    expect(text).toContain('JFIF')
    expect(text).toContain('ICC_PROFILE')
    // Starts and ends as a JPEG, and the scan data is copied byte for byte (stuffed 0xFF00 and the restart marker included).
    expect([...result.bytes.subarray(0, 2)]).toEqual([0xff, 0xd8])
    expect([...result.bytes.subarray(-2)]).toEqual([0xff, 0xd9])
    expect(latin1(result.bytes)).toContain(latin1(Uint8Array.from(SCAN)))
    // The orientation (6: turned) comes back as an EXIF block of its own, with nothing else in it.
    const kept = result.bytes.indexOf(0xe1, 2)
    expect(readExif(result.bytes.subarray(kept + 9, kept + 9 + 26))).toEqual({ orientation: 6, gps: false })
    expect(latin1(result.bytes)).toContain(latin1(orientationSegment(6)))
    // Stripping the copy again changes nothing.
    const again = stripImageMetadata(result.bytes, 'image/jpeg')
    expect(again.ok && [...again.bytes]).toEqual([...result.bytes])
  })

  it('writes no EXIF block at all when the picture stands upright', () => {
    const input = Uint8Array.from([0xff, 0xd8, ...segment(0xe1, [...ascii('Exif\0\0'), ...tiff(1, false)]), ...segment(0xda, [1, 1, 0, 0, 63, 0]), 1, 2, 3, 0xff, 0xd9])
    const result = stripImageMetadata(input, 'image/jpeg; charset=binary')
    expect(result.ok && result.location).toBe(false)
    expect(result.ok && latin1(result.bytes)).not.toContain('Exif')
  })

  it('refuses a damaged or cut-short JPEG instead of guessing', () => {
    expect(stripImageMetadata(Uint8Array.from([0x00, 0x01, 0x02]), 'image/jpeg')).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(stripImageMetadata(jpeg().subarray(0, 60), 'image/jpeg')).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(stripImageMetadata(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00, 1, 2]), 'image/jpeg')).toMatchObject({ ok: false, reason: 'unreadable' })
  })
})

function chunk(type: string, data: number[]): number[] {
  const length = data.length
  return [(length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff, ...ascii(type), ...data, 0, 0, 0, 0]
}

describe('PNG', () => {
  it('keeps the image and display chunks and drops eXIf (with GPS), text, XMP, time and private chunks', () => {
    const input = Uint8Array.from([
      137, 80, 78, 71, 13, 10, 26, 10,
      ...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
      ...chunk('sRGB', [0]),
      ...chunk('eXIf', tiff(1, true)),
      ...chunk('tEXt', ascii('Author\0Made Up')),
      ...chunk('iTXt', ascii('XML:com.adobe.xmp\0\0\0\0\0<exif:GPSLongitude>9,11E</exif:GPSLongitude>')),
      ...chunk('tIME', [7, 234, 11, 5, 10, 0, 0]),
      ...chunk('prVt', ascii('a made-up private note')),
      ...chunk('IDAT', [1, 2, 3, 4]),
      ...chunk('IEND', []),
      ...ascii('after the end'),
    ])
    const result = stripImageMetadata(input, 'image/png')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.location).toBe(true)
    expect(result.removed).toEqual(['EXIF', 'GPS', 'TEXT', 'TIME', 'prVt', 'TRAILER'])
    const text = latin1(result.bytes)
    for (const kept of ['IHDR', 'sRGB', 'IDAT', 'IEND']) expect(text).toContain(kept)
    for (const gone of ['eXIf', 'Made Up', 'GPSLongitude', 'tIME', 'private note', 'after the end']) expect(text).not.toContain(gone)
  })
})

describe('WebP', () => {
  it('drops the EXIF and XMP chunks, clears their flags and writes the RIFF size again', () => {
    const body = [
      ...ascii('VP8X'), 10, 0, 0, 0, 0x0c | 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ...ascii('ALPH'), 3, 0, 0, 0, 1, 2, 3, 0,
      ...ascii('VP8 '), 4, 0, 0, 0, 9, 8, 7, 6,
      ...ascii('EXIF'), ...[tiff(3, true).length, 0, 0, 0], ...tiff(3, true),
      ...ascii('XMP '), 9, 0, 0, 0, ...ascii('<x:made/>'), 0,
    ]
    const size = body.length + 4
    const input = Uint8Array.from([...ascii('RIFF'), size & 0xff, (size >> 8) & 0xff, 0, 0, ...ascii('WEBP'), ...body])
    const result = stripImageMetadata(input, 'image/webp')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.removed).toEqual(['EXIF', 'GPS', 'XMP'])
    expect(result.location).toBe(true)
    const text = latin1(result.bytes)
    expect(text).not.toContain('GPSLAT')
    expect(text).not.toContain('x:made')
    expect(result.bytes[20]! & 0x0c).toBe(0)
    expect(result.bytes[20]! & 0x10).toBe(0x10)
    expect(new DataView(result.bytes.buffer).getUint32(4, true)).toBe(result.bytes.length - 8)
  })
})

describe('what is stripped', () => {
  it('handles JPEG, PNG and WebP; a HEIC or anything else has no stripped copy', () => {
    expect(['image/jpeg', 'image/png', 'image/webp'].every(isStrippable)).toBe(true)
    expect(isStrippable('image/heic')).toBe(false)
    expect(isPicture('image/heic')).toBe(true)
    expect(isPicture('application/pdf')).toBe(false)
    expect(stripImageMetadata(Uint8Array.from([0, 0, 0, 24]), 'image/heic')).toMatchObject({ ok: false, reason: 'unsupported' })
  })
})
