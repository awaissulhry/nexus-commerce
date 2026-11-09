import { deflateRawSync } from 'node:zlib'

/**
 * A zip file written in memory (B-W2b-201; design portal.guest.accountant "Download period (zip)", "Download all XML of the
 * period as one zip"): no package (the repository adds none), PKWARE APPNOTE 4.5 without ZIP64 — the accountant's zips stay
 * far below 4 GB and 65 535 entries (files.ts GUEST_ZIP). Each entry is deflated when that makes it smaller, else stored;
 * names are UTF-8 (general purpose bit 11); times are the zip's moment in UTC (DOS time has no zone).
 */

export interface ZipEntry {
  /** The path inside the zip (`e-invoices/sales/IT0…_00001.xml`), forward slashes, no leading slash. */
  readonly path: string
  readonly bytes: Uint8Array
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 (IEEE 802.3), as zip stores it. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index++) crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** MS-DOS date and time of an instant (UTC), 1980 at the earliest. */
function dosTime(at: Date): { readonly time: number; readonly date: number } {
  const year = Math.max(1980, at.getUTCFullYear())
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  }
}

const UTF8_NAMES = 0x0800
const VERSION = 20

/** The zip of these entries (in this order), dated `at`. */
export function writeZip(entries: readonly ZipEntry[], at: Date): Buffer {
  if (entries.length > 0xffff) throw new RangeError('A zip without ZIP64 holds at most 65 535 entries.')
  const { time, date } = dosTime(at)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8')
    const raw = Buffer.from(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength)
    const deflated = deflateRawSync(raw, { level: 6 })
    const stored = deflated.length >= raw.length
    const data = stored ? raw : deflated
    const crc = crc32(raw)
    const method = stored ? 0 : 8

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(VERSION, 4)
    local.writeUInt16LE(UTF8_NAMES, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(VERSION, 4)
    central.writeUInt16LE(VERSION, 6)
    central.writeUInt16LE(UTF8_NAMES, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    // extra 0, comment 0, disk 0, internal 0, external 0
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + data.length
    if (offset > 0xffffffff) throw new RangeError('A zip without ZIP64 holds at most 4 GB.')
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/** The CSV index the zip carries first: each file's path, what it is, its fingerprint, and whether it was there. */
export function indexCsv(rows: readonly { readonly path: string; readonly what: string; readonly number: string; readonly date: string; readonly sha256: string; readonly sizeBytes: number; readonly included: boolean }[]): Uint8Array {
  const cell = (value: string | number): string => {
    const text = String(value)
    return /[",;\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines = [['path', 'what', 'number', 'date', 'sha256', 'bytes', 'included'], ...rows.map((row) => [row.path, row.what, row.number, row.date, row.sha256, row.sizeBytes, row.included ? 'yes' : 'no: not in the file store'])]
  return Buffer.from(`\uFEFF${lines.map((line) => line.map(cell).join(',')).join('\r\n')}\r\n`, 'utf8')
}
