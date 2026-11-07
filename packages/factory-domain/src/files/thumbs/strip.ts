/**
 * The stripped copy of a picture (COL-058; B-W2b-160), pure: the same picture with every block of data about the camera,
 * the person and the place removed — EXIF (with its GPS position), XMP, IPTC, comments, embedded previews and whatever
 * follows the picture's end — and nothing else changed: the compressed image data is copied byte for byte, so the
 * picture looks exactly the same. The one fact kept from EXIF is the orientation (a phone's photo would otherwise show
 * on its side), written back as a new EXIF block holding that tag only. Colour profiles (ICC) and the Adobe colour-transform
 * block stay: they say how to show the colours, nothing about who or where.
 *
 *   JPEG   segments walked from the start marker to the end marker; APP0 JFIF, APP2 ICC_PROFILE and APP14 Adobe kept,
 *          every other APPn segment and COM dropped; the scan data copied as it is
 *   PNG    critical chunks and the known display chunks kept (tRNS, gAMA, cHRM, sRGB, iCCP, sBIT, pHYs, bKGD, hIST, sPLT,
 *          and the animation chunks); eXIf, tEXt, zTXt, iTXt (XMP), tIME and any other chunk dropped
 *   WebP   the EXIF and XMP chunks dropped and their flags cleared in VP8X; the RIFF size written again
 *
 * HEIC (and any other type) is not handled: no stripped copy is made, so a portal or a link is never shown it (the API's
 * rule). The picture is not resized: making it smaller needs an image codec, which is not part of the factory API (see
 * the step's notes). The database records that the copy was made (StoredFile.exifStrippedAt); it cannot check the bytes.
 */

export const STRIPPABLE_TYPES: readonly string[] = Object.freeze(['image/jpeg', 'image/png', 'image/webp'])

const normalised = (contentType: string): string => contentType.split(';')[0]!.trim().toLowerCase()

/** A picture this module can strip. */
export const isStrippable = (contentType: string): boolean => STRIPPABLE_TYPES.includes(normalised(contentType))

/** A picture: what a portal or a link is shown only through its stripped copy. */
export const isPicture = (contentType: string): boolean => normalised(contentType).startsWith('image/')

export type StripResult =
  | {
      readonly ok: true
      readonly bytes: Uint8Array
      /** The kinds of block removed, in the order met: EXIF, GPS, XMP, IPTC, COMMENT, MPF, TEXT, TIME, TRAILER, APPn, … */
      readonly removed: readonly string[]
      /** The picture held a position (EXIF GPS, or GPS in XMP): it is gone from the copy. */
      readonly location: boolean
    }
  | { readonly ok: false; readonly reason: 'unsupported' | 'unreadable'; readonly message: string }

const unreadable = (message: string): StripResult => ({ ok: false, reason: 'unreadable', message })
const ascii = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0))
const startsWith = (data: Uint8Array, prefix: string): boolean => data.length >= prefix.length && [...prefix].every((c, i) => data[i] === c.charCodeAt(0))
const latin1 = (data: Uint8Array): string => Array.from(data, (b) => String.fromCharCode(b)).join('')

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** What a TIFF/EXIF block says that matters here: the orientation (1..8) and whether it points to a GPS block. */
export function readExif(tiff: Uint8Array): { readonly orientation: number | null; readonly gps: boolean } {
  const none = { orientation: null, gps: false }
  if (tiff.length < 8) return none
  const little = tiff[0] === 0x49 && tiff[1] === 0x49
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return none
  const u16 = (at: number): number => (little ? tiff[at]! | (tiff[at + 1]! << 8) : (tiff[at]! << 8) | tiff[at + 1]!)
  const u32 = (at: number): number => (little ? (tiff[at]! | (tiff[at + 1]! << 8) | (tiff[at + 2]! << 16) | (tiff[at + 3]! << 24)) >>> 0 : ((tiff[at]! << 24) | (tiff[at + 1]! << 16) | (tiff[at + 2]! << 8) | tiff[at + 3]!) >>> 0)
  if (u16(2) !== 42) return none
  const ifd = u32(4)
  if (ifd + 2 > tiff.length) return none
  let orientation: number | null = null
  let gps = false
  const count = u16(ifd)
  for (let index = 0; index < count; index++) {
    const entry = ifd + 2 + index * 12
    if (entry + 12 > tiff.length) break
    const tag = u16(entry)
    if (tag === 0x0112 && u16(entry + 2) === 3) {
      const value = u16(entry + 8)
      orientation = value >= 1 && value <= 8 ? value : null
    }
    if (tag === 0x8825) gps = true
  }
  return { orientation, gps }
}

/** An APP1 segment holding an EXIF block with the orientation only (big-endian TIFF, one IFD, one entry). */
export function orientationSegment(orientation: number): Uint8Array {
  return Uint8Array.of(
    0xff, 0xe1, 0x00, 0x22,
    ...ascii('Exif\0\0'),
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01,
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, (orientation >> 8) & 0xff, orientation & 0xff, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  )
}

const XMP = 'http://ns.adobe.com/xap/1.0/\0'
const XMP_EXTENSION = 'http://ns.adobe.com/xmp/extension/\0'
/** GPS written in XMP (exif:GPSLatitude …). */
const xmpHasPosition = (data: Uint8Array): boolean => /GPS(Latitude|Longitude|Altitude)/.test(latin1(data))

function stripJpeg(input: Uint8Array): StripResult {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return unreadable('This is not a JPEG picture (no start marker).')
  const out: Uint8Array[] = [input.subarray(0, 2)]
  const removed: string[] = []
  const remove = (kind: string): void => {
    if (!removed.includes(kind)) removed.push(kind)
  }
  let location = false
  let pos = 2
  let ended = false
  while (pos < input.length) {
    if (input[pos] !== 0xff) return unreadable(`The JPEG picture is damaged (no marker at byte ${pos}).`)
    while (pos + 1 < input.length && input[pos + 1] === 0xff) pos++
    if (pos + 1 >= input.length) break
    const marker = input[pos + 1]!
    if (marker === 0xd9) {
      out.push(Uint8Array.of(0xff, 0xd9))
      pos += 2
      ended = true
      break
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(input.subarray(pos, pos + 2))
      pos += 2
      continue
    }
    if (pos + 4 > input.length) break
    const length = (input[pos + 2]! << 8) | input[pos + 3]!
    const end = pos + 2 + length
    if (length < 2 || end > input.length) return unreadable('The JPEG picture is damaged (a block runs past its end).')
    const segment = input.subarray(pos, end)
    const data = input.subarray(pos + 4, end)
    if (marker === 0xe1) {
      if (startsWith(data, 'Exif\0\0')) {
        const exif = readExif(data.subarray(6))
        remove('EXIF')
        if (exif.gps) {
          remove('GPS')
          location = true
        }
        if (exif.orientation !== null && exif.orientation !== 1) out.push(orientationSegment(exif.orientation))
      } else if (startsWith(data, XMP) || startsWith(data, XMP_EXTENSION)) {
        remove('XMP')
        if (xmpHasPosition(data)) location = true
      } else {
        remove('APP1')
      }
    } else if (marker === 0xe0) {
      if (startsWith(data, 'JFIF\0')) out.push(segment)
      else remove('APP0')
    } else if (marker === 0xe2) {
      if (startsWith(data, 'ICC_PROFILE\0')) out.push(segment)
      else remove(startsWith(data, 'MPF\0') ? 'MPF' : 'APP2')
    } else if (marker === 0xee) {
      if (startsWith(data, 'Adobe')) out.push(segment)
      else remove('APP14')
    } else if (marker >= 0xe3 && marker <= 0xef) {
      remove(marker === 0xed ? 'IPTC' : `APP${marker - 0xe0}`)
    } else if (marker === 0xfe) {
      remove('COMMENT')
    } else {
      out.push(segment)
      if (marker === 0xda) {
        // The scan's coded data runs to the next marker that is neither a stuffed 0xFF00 nor a restart marker.
        let scan = end
        while (scan < input.length) {
          if (input[scan] === 0xff && scan + 1 < input.length) {
            const next = input[scan + 1]!
            if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
              scan += 2
              continue
            }
            break
          }
          scan++
        }
        out.push(input.subarray(end, scan))
        pos = scan
        continue
      }
    }
    pos = end
  }
  if (!ended) return unreadable('The JPEG picture is cut short (no end marker).')
  if (pos < input.length) remove('TRAILER')
  return { ok: true, bytes: concat(out), removed, location }
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
/** Ancillary chunks that only say how to show the picture (or animate it). */
const PNG_DISPLAY = new Set(['tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs', 'bKGD', 'hIST', 'sPLT', 'acTL', 'fcTL', 'fdAT'])
const PNG_LABEL: Readonly<Record<string, string>> = { eXIf: 'EXIF', tEXt: 'TEXT', zTXt: 'TEXT', iTXt: 'TEXT', tIME: 'TIME' }

function stripPng(input: Uint8Array): StripResult {
  if (input.length < 8 || PNG_SIGNATURE.some((byte, index) => input[index] !== byte)) return unreadable('This is not a PNG picture (no signature).')
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  const out: Uint8Array[] = [input.subarray(0, 8)]
  const removed: string[] = []
  let location = false
  let pos = 8
  let ended = false
  while (pos + 12 <= input.length) {
    const length = view.getUint32(pos)
    const end = pos + 12 + length
    if (end > input.length) return unreadable('The PNG picture is damaged (a chunk runs past its end).')
    const type = latin1(input.subarray(pos + 4, pos + 8))
    const critical = (input[pos + 4]! & 0x20) === 0
    if (critical || PNG_DISPLAY.has(type)) {
      out.push(input.subarray(pos, end))
    } else {
      const label = PNG_LABEL[type] ?? type
      if (!removed.includes(label)) removed.push(label)
      const data = input.subarray(pos + 8, pos + 8 + length)
      if (type === 'eXIf' && readExif(data).gps) {
        if (!removed.includes('GPS')) removed.push('GPS')
        location = true
      }
      if (type === 'iTXt' && xmpHasPosition(data)) location = true
    }
    pos = end
    if (type === 'IEND') {
      ended = true
      break
    }
  }
  if (!ended) return unreadable('The PNG picture is cut short (no end chunk).')
  if (pos < input.length) removed.push('TRAILER')
  return { ok: true, bytes: concat(out), removed, location }
}

function stripWebp(input: Uint8Array): StripResult {
  if (input.length < 12 || !startsWith(input, 'RIFF') || latin1(input.subarray(8, 12)) !== 'WEBP') return unreadable('This is not a WebP picture (no RIFF header).')
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  const riffEnd = Math.min(input.length, 8 + view.getUint32(4, true))
  const out: Uint8Array[] = []
  const removed: string[] = []
  let location = false
  let pos = 12
  while (pos + 8 <= riffEnd) {
    const type = latin1(input.subarray(pos, pos + 4))
    const size = view.getUint32(pos + 4, true)
    const end = pos + 8 + size + (size % 2)
    if (pos + 8 + size > riffEnd) return unreadable('The WebP picture is damaged (a chunk runs past its end).')
    const data = input.subarray(pos + 8, pos + 8 + size)
    if (type === 'EXIF') {
      removed.push('EXIF')
      if (readExif(startsWith(data, 'Exif\0\0') ? data.subarray(6) : data).gps) {
        removed.push('GPS')
        location = true
      }
    } else if (type === 'XMP ') {
      removed.push('XMP')
      if (xmpHasPosition(data)) location = true
    } else if (type === 'VP8X' && size >= 1) {
      const chunk = input.slice(pos, Math.min(end, riffEnd))
      chunk[8] = chunk[8]! & ~0x0c
      out.push(chunk)
    } else {
      out.push(input.subarray(pos, Math.min(end, riffEnd)))
    }
    pos = end
  }
  if (riffEnd < input.length) removed.push('TRAILER')
  const body = concat(out)
  const header = new Uint8Array(12)
  header.set(ascii('RIFF'), 0)
  new DataView(header.buffer).setUint32(4, body.length + 4, true)
  header.set(ascii('WEBP'), 8)
  return { ok: true, bytes: concat([header, body]), removed, location }
}

/** The picture without its metadata (see the top of this file), or why not. */
export function stripImageMetadata(bytes: Uint8Array, contentType: string): StripResult {
  switch (normalised(contentType)) {
    case 'image/jpeg':
      return stripJpeg(bytes)
    case 'image/png':
      return stripPng(bytes)
    case 'image/webp':
      return stripWebp(bytes)
    default:
      return { ok: false, reason: 'unsupported', message: `A ${normalised(contentType)} picture has no stripped copy: it is not shown outside the office.` }
  }
}
