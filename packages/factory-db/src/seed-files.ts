import { createHash } from 'node:crypto'
import { isLegalKey, isStorageKey, storageKeyFor } from '@nexus/factory-domain/files/keys'
import type { Prisma } from './generated/prisma/client'

/**
 * The bytes of the seeded files (B-W2b-F59). A seed writes StoredFile rows only; their objects are put in the store of a
 * seeded stack afterwards, through the files platform's own code (apps/factory-api platform/files/seed-bytes: the gateway's
 * files.put, so the local folder of a FAKE R2 account, FACTORY_LOCAL_FILES_DIR, on a local test server). Both sides make the
 * bytes with seedFileBytes, so the row's SHA-256 (seedFile) and the stored object always agree:
 *
 *   seedFileBytes   a small valid file of the row's content type, written whole by this module (no compression library, so
 *                   the same row gives the same bytes on every machine and Node version), padded to the row's sizeBytes
 *                   exactly in a place the format ignores (a comment, a padding box or element, spaces):
 *                     image/png          a 64 × 64 swatch of one colour (from the name), the name in a tEXt chunk
 *                     image/jpeg         a 32 × 32 grey baseline JPEG, the name in COM segments
 *                     application/pdf    one A4 page that names the file and says it is made-up seed data
 *                     video/mp4          one 32 × 32 frame (H.264), a `free` box after it
 *                     audio/webm         0.2 s of silence (Opus), a Void element at the end of its Segment
 *                     application/zip    one stored README.txt; application/xml an XML document; text/csv a header and
 *                                        one row; application/dxf an empty drawing; anything else plain text
 *   seedFile        the row with the SHA-256 of those bytes, after checking its key is one the files platform's key rule
 *                   (factory-domain files/keys.ts) makes for that row: its company (or the tenant), `legal/` exactly for the
 *                   fiscal archive, the year it was uploaded (createdAt). A seed that breaks the rule fails at once.
 *   seedFileKey     a key made by that rule, for a seed that builds a new one.
 *
 * Every name and text is made up. Nothing here touches a store or the database.
 */

/** What the bytes are made from: the row's own columns, so a stored row is enough to make them again. */
export interface SeedFileFacts {
  readonly id: string
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
}

const ascii = (text: string): string => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '?')

// ---- CRC-32 and Adler-32 (PNG, ZIP) -----------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function adler32(data: Uint8Array): number {
  let a = 1
  let b = 0
  for (const byte of data) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

const u32 = (value: number): Buffer => {
  const out = Buffer.alloc(4)
  out.writeUInt32BE(value >>> 0)
  return out
}

/** Exactly `size` bytes or a refusal in words: the row's size must hold the smallest valid file of its type. */
function fit(file: SeedFileFacts, build: (pad: number) => Buffer): Buffer {
  const base = build(0).length
  if (file.sizeBytes < base) {
    throw new Error(`Seed file ${file.id} (${file.originalName}): ${file.sizeBytes} bytes cannot hold a valid ${file.contentType} file; it needs at least ${base}.`)
  }
  // Padding grows a file byte for byte, apart from a counter that gains a digit or a segment that starts: a few rounds.
  let pad = file.sizeBytes - base
  for (let round = 0; round < 8; round += 1) {
    const bytes = build(pad)
    if (bytes.length === file.sizeBytes) return bytes
    pad = Math.max(0, pad + file.sizeBytes - bytes.length)
  }
  throw new Error(`Seed file ${file.id} (${file.originalName}): no padding gives exactly ${file.sizeBytes} bytes.`)
}

// ---- PNG: a swatch of one colour (colour type 3, one palette entry, 1 bit per pixel, stored deflate blocks) ------------

function png(file: SeedFileFacts, label: string): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), data])
    return Buffer.concat([u32(data.length), typed, u32(crc32(typed))])
  }
  const side = 64
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(side, 0)
  ihdr.writeUInt32BE(side, 4)
  ihdr.set([1, 3, 0, 0, 0], 8)
  const digest = createHash('sha256').update(file.originalName).digest()
  // A muted colour from the name: every channel between 64 and 191.
  const palette = Buffer.from([64 + (digest[0]! % 128), 64 + (digest[1]! % 128), 64 + (digest[2]! % 128)])
  const raw = Buffer.alloc(side * (1 + side / 8))
  const stored = Buffer.concat([Buffer.from([0x78, 0x01, 0x01]), Buffer.from([raw.length & 0xff, raw.length >> 8, ~raw.length & 0xff, (~raw.length >> 8) & 0xff]), raw, u32(adler32(raw))])
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return fit(file, (pad) =>
    Buffer.concat([
      signature,
      chunk('IHDR', ihdr),
      chunk('PLTE', palette),
      chunk('tEXt', Buffer.from(`Comment\0${label}${' '.repeat(pad)}`, 'latin1')),
      chunk('IDAT', stored),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}

// ---- JPEG: a 32 × 32 grey baseline picture (ffmpeg, its comment removed), the name in COM segments ---------------------

const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAgAAAQABAAD/2wBDAAgQEBMQExYWFhYWFhoYGhsbGxoaGhobGxsdHR0iIiIdHR0bGx0dICAiIiUmJSMjIiMmJigoKDAwLi44ODpFRVP/xABMAAEBAAAAAAAAAAAAAAAAAAAABQEBAQAAAAAAAAAAAAAAAAAAAAMQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAgACADASIAAhEAAxEA/9oADAMBAAIRAxEAPwC8AomAAAAAA//Z',
  'base64',
)

function jpeg(file: SeedFileFacts, label: string): Buffer {
  const text = Buffer.from(label, 'latin1')
  const comments = (pad: number): Buffer => {
    // One COM segment holds 65 533 bytes; the name opens the first, spaces fill the rest.
    const data = Buffer.concat([text, Buffer.alloc(pad, 0x20)])
    const segments: Buffer[] = []
    for (let at = 0; at < data.length; at += 65_533) {
      const part = data.subarray(at, at + 65_533)
      const length = Buffer.alloc(2)
      length.writeUInt16BE(part.length + 2)
      segments.push(Buffer.concat([Buffer.from([0xff, 0xfe]), length, part]))
    }
    return Buffer.concat(segments)
  }
  // After the JFIF APP0 segment, which must follow the start marker.
  const app0End = 4 + JPEG.readUInt16BE(4)
  return fit(file, (pad) => Buffer.concat([JPEG.subarray(0, app0End), comments(pad), JPEG.subarray(app0End)]))
}

// ---- PDF: one A4 page with two lines of Helvetica, a classic cross-reference table ------------------------------------

const pdfText = (text: string): string => ascii(text).replace(/[\\()]/g, (c) => `\\${c}`)

function pdf(file: SeedFileFacts, label: string): Buffer {
  const build = (pad: number): Buffer => {
    const content = `BT /F1 14 Tf 56 780 Td (${pdfText(file.originalName)}) Tj 0 -22 Td /F1 10 Tf (Made-up seed file - synthetic data, no real company or person.) Tj 0 -16 Td (${pdfText(label)}) Tj ET`
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      `<< /Title (${pdfText(file.originalName)}) /Producer (factory seed) >>`,
    ]
    // Padding: comment lines of spaces before the first object (a reader skips comments); a last single byte is a newline.
    const padding = Buffer.alloc(pad, 0x20)
    const lines = Math.floor(pad / 72)
    for (let line = 0; line < lines; line += 1) {
      padding[line * 72] = 0x25 // %
      padding[line * 72 + 71] = 0x0a
    }
    const rest = pad - lines * 72
    if (rest >= 2) {
      padding[lines * 72] = 0x25
      padding[pad - 1] = 0x0a
    } else if (rest === 1) padding[lines * 72] = 0x0a
    const head = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')
    let body = ''
    const offsets: number[] = []
    const start = head.length + padding.length
    objects.forEach((object, index) => {
      offsets.push(start + body.length)
      body += `${index + 1} 0 obj\n${object}\nendobj\n`
    })
    const xref = start + body.length
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
    body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return Buffer.concat([head, padding, Buffer.from(body, 'latin1')])
  }
  return fit(file, build)
}

// ---- MP4: one 32 × 32 frame (ffmpeg, H.264, no SEI), a `free` box at the end -------------------------------------------

const MP4 = Buffer.from(
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAALzbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAkJ0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAACAAAAAgAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAG6bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABZW1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASVzdGJsAAAAwXN0c2QAAAAAAAAAAQAAALFhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAACAAIABIAAAASAAAAAAAAAABDExhdmMgbGlieDI2NAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAN2F2Y0MBZAAK/+EAGWdkAAqscgRJbARAAAADAEAAAAMAg8SJYRgBAAdo6EODksiw/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAADAAAAAAAAAABhzdHRzAAAAAAAAAAEAAAABAABAAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAAAYAAAAAQAAABRzdGNvAAAAAAAAAAEAAAMjAAAAPXVkdGEAAAA1bWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAIaWxzdAAAAAhmcmVlAAAAIG1kYXQAAAAUZYiBAAK//p674FHisAsyIg+wlfk=',
  'base64',
)

const mp4 = (file: SeedFileFacts, label: string): Buffer =>
  fit(file, (pad) => {
    const payload = Buffer.from(`${label}${' '.repeat(pad)}`, 'latin1')
    return Buffer.concat([MP4, u32(payload.length + 8), Buffer.from('free', 'latin1'), payload])
  })

// ---- WebM: 0.2 s of silence (ffmpeg, Opus), a Void element added at the end of its Segment ------------------------------

const WEBM = Buffer.from(
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAAI2EU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHGTbuMU6uEElTDZ1OsggEwTbuMU6uEHFO7a1OsggIg7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmoCrXsYMPQkBNgIRMYXZmV0GETGF2ZkSJiEBqAAAAAAAAFlSua+WuAQAAAAAAAFzXgQFzxYgAAAAAAAAAAZyBACK1nIN1bmSIgQCGhkFfT1BVU1aqg2MuoFa7hATEtACDgQLhkZ+BAbWIQOdwAAAAAABiZIEQY6KTT3B1c0hlYWQBATgBgLsAAAAAABJUw2fRc3POY8CLY8WIAAAAAAAAAAFnyJlFo4dFTkNPREVSRIeMTGF2YyBsaWJvcHVzZ8ihRaOIRFVSQVRJT05Eh5MwMDowMDowMC4yMDgwMDAwMDAAH0O2dUCU54EAo4uBAACACAvmOyOrYKOKgQAVgAgIrLMOxqOKgQApgAgIrLMOxqOKgQA9gAgIrLMOxqOKgQBRgAgIrLMOxqOKgQBlgAgIrLMOxqOKgQB5gAgIrLMOxqOKgQCNgAgIrLMOxqOKgQChgAgIrLMOxqOKgQC1gAgIrLMOxqCWoYqBAMkACAissw7Gm4EHdaKEAM3+YBxTu2uRu4+zgQC3iveBAfGCAYbwgQM=',
  'base64',
)
/** Where the Segment's 8-byte size is (after the EBML header and the Segment's id), and where its data starts. */
const WEBM_SEGMENT_SIZE_AT = WEBM.indexOf(Buffer.from([0x18, 0x53, 0x80, 0x67])) + 4
const WEBM_SEGMENT_DATA_AT = WEBM_SEGMENT_SIZE_AT + 8

function webm(file: SeedFileFacts, label: string): Buffer {
  const segmentSize = Number(WEBM.readBigUInt64BE(WEBM_SEGMENT_SIZE_AT) & 0x00ff_ffff_ffff_ffffn)
  if (WEBM[WEBM_SEGMENT_SIZE_AT] !== 0x01 || WEBM.length !== WEBM_SEGMENT_DATA_AT + segmentSize) throw new Error('The seed WebM is not laid out as expected.')
  return fit(file, (pad) => {
    const payload = Buffer.from(`${label}${' '.repeat(pad)}`, 'latin1')
    const voidSize = Buffer.alloc(8)
    voidSize.writeBigUInt64BE(BigInt(payload.length) | 0x0100_0000_0000_0000n)
    const voidElement = Buffer.concat([Buffer.from([0xec]), voidSize, payload])
    const out = Buffer.concat([WEBM, voidElement])
    out.writeBigUInt64BE(BigInt(segmentSize + voidElement.length) | 0x0100_0000_0000_0000n, WEBM_SEGMENT_SIZE_AT)
    return out
  })
}

// ---- ZIP: one stored README.txt ------------------------------------------------------------------------------------------

function zip(file: SeedFileFacts, label: string): Buffer {
  return fit(file, (pad) => {
    const name = Buffer.from('README.txt', 'latin1')
    const data = Buffer.from(`${ascii(file.originalName)}\nMade-up seed file - synthetic data, no real company or person.\n${label}\n${' '.repeat(pad)}`, 'latin1')
    const crc = crc32(data)
    // 1 January 2026, 00:00 in MS-DOS form.
    const time = 0
    const date = ((2026 - 1980) << 9) | (1 << 5) | 1
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(10, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(10, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(0, 42)
    const centralAt = local.length + name.length + data.length
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(1, 8)
    end.writeUInt16LE(1, 10)
    end.writeUInt32LE(central.length + name.length, 12)
    end.writeUInt32LE(centralAt, 16)
    return Buffer.concat([local, name, data, central, name, end])
  })
}

// ---- text formats ------------------------------------------------------------------------------------------------------

const xmlText = (text: string): string => ascii(text).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)

const xml = (file: SeedFileFacts, label: string): Buffer =>
  fit(file, (pad) =>
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Made-up seed file - synthetic data, no real company or person. -->\n<SeedFile name="${xmlText(file.originalName)}" ref="${xmlText(label)}"/>\n${'\n'.repeat(pad)}`,
      'latin1',
    ),
  )

const csvCell = (text: string): string => `"${ascii(text).replace(/"/g, '""')}"`

const csv = (file: SeedFileFacts, label: string): Buffer =>
  fit(file, (pad) => Buffer.from(`file;note\r\n${csvCell(file.originalName)};"Made-up seed file ${xmlText(label)}${' '.repeat(pad)}"\r\n`, 'latin1'))

const dxf = (file: SeedFileFacts, label: string): Buffer =>
  fit(file, (pad) => Buffer.from(`999\n${ascii(file.originalName)} - made-up seed file ${label}${' '.repeat(pad)}\n0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n`, 'latin1'))

const text = (file: SeedFileFacts, label: string): Buffer =>
  fit(file, (pad) => Buffer.from(`${ascii(file.originalName)}\nMade-up seed file - synthetic data, no real company or person.\n${label}\n${' '.repeat(pad)}`, 'latin1'))

const MAKERS: Readonly<Record<string, (file: SeedFileFacts, label: string) => Buffer>> = Object.freeze({
  'image/png': png,
  'image/jpeg': jpeg,
  'application/pdf': pdf,
  'video/mp4': mp4,
  'audio/webm': webm,
  'application/zip': zip,
  'application/xml': xml,
  'text/xml': xml,
  'text/csv': csv,
  'application/dxf': dxf,
})

/** The bytes of a seeded file: a valid file of its type, exactly sizeBytes long, the same every time. */
export function seedFileBytes(file: SeedFileFacts): Buffer {
  const contentType = file.contentType.split(';')[0]!.trim().toLowerCase()
  const label = `seed file ${file.id}`
  return (MAKERS[contentType] ?? text)(file, label)
}

/** The SHA-256 of seedFileBytes (lower-case hex), the row's `sha256`. */
export function seedFileSha256(file: SeedFileFacts): string {
  const memo = `${file.id}\u0000${file.originalName}\u0000${file.contentType}\u0000${file.sizeBytes}`
  let sha = SHA_MEMO.get(memo)
  if (sha === undefined) {
    sha = createHash('sha256').update(seedFileBytes(file)).digest('hex')
    SHA_MEMO.set(memo, sha)
  }
  return sha
}

/** The hashes made in this process (a seed runs twice in its tests, and some rows are built twice: made once). */
const SHA_MEMO = new Map<string, string>()

/** A key made by the files platform's rule (factory-domain files/keys.ts) for a seeded file uploaded at `at`. */
export function seedFileKey(input: { readonly tenantId: string; readonly companyId: string | null; readonly kind: string; readonly at: Date; readonly random: string }): string {
  return storageKeyFor({ tenantId: input.tenantId, companyId: input.companyId, kind: input.kind, now: input.at, random: input.random })
}

/** The problem with a seeded file's key against the files platform's rule, or null (seedFile throws it; the seed tests list it). */
export function seedFileKeyProblem(tenantId: string, row: { readonly id: string; readonly companyId?: string | null; readonly kind: string; readonly storageKey: string; readonly createdAt?: Date | string | null }): string | null {
  const key = row.storageKey
  if (!isStorageKey(key)) return `Seed file ${row.id}: ${key} is not a key the files platform makes.`
  const random = key.slice(key.lastIndexOf('/') + 1)
  const at = row.createdAt === undefined || row.createdAt === null ? null : new Date(row.createdAt)
  const year = Number(key.split('/').at(-2))
  const expected = storageKeyFor({ tenantId, companyId: row.companyId ?? null, kind: row.kind, now: at ?? new Date(Date.UTC(year, 0, 1)), random })
  if (key !== expected) return `Seed file ${row.id}: ${key} is not the key an upload makes for it (${expected}).`
  if ((row.kind === 'FISCAL_ARCHIVE') !== isLegalKey(key)) return `Seed file ${row.id}: only a fiscal archive file is kept under legal/.`
  return null
}

/**
 * The seeded row with the SHA-256 of its bytes, its key checked against the files platform's rule first (throws). A copy
 * of another seeded file (sourceFileId: the database checks the two hashes match) holds that file's bytes: pass its row.
 */
export function seedFile(tenantId: string, row: Omit<Prisma.StoredFileCreateManyInput, 'sha256'>, options: { readonly bytesOf?: SeedFileFacts } = {}): Prisma.StoredFileCreateManyInput {
  const problem = seedFileKeyProblem(tenantId, row)
  if (problem) throw new Error(problem)
  return { ...row, sha256: seedFileSha256(options.bytesOf ?? row) }
}
