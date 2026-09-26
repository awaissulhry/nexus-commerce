import type { PGlite } from '@electric-sql/pglite'

/**
 * Fixture compatibility for https://github.com/electric-sql/pglite/issues/958.
 * Extended-query errors emit a premature ReadyForQuery before Sync. pg treats
 * the extra Ready as completion of its NEXT query and corrupts its connection.
 * Preserve SQL errors and transaction behavior; only repair wire framing.
 */
export function fixExtendedQueryReady(db: Pick<PGlite, 'execProtocolRawStream'>): void {
  const original = db.execProtocolRawStream.bind(db)
  const extended = new Set([0x50, 0x42, 0x44, 0x45, 0x43, 0x48])
  db.execProtocolRawStream = async (message, options) => {
    const input = Buffer.from(message.buffer, message.byteOffset, message.byteLength)
    // The socket bridge dispatches one frontend frame at a time. Never filter a
    // combined Parse+Sync batch, whose Ready is legitimate, or startup/Q/S.
    if (!extended.has(input[0]) || input.length < 5 || input.readUInt32BE(1) + 1 !== input.length) {
      return original(message, options)
    }
    let pending = Buffer.alloc(0)
    await original(message, { ...options, onRawData(chunk) {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 5) {
        const size = pending.readUInt32BE(1)
        if (size < 4) throw new Error('Invalid PGlite backend frame length')
        if (pending.length < size + 1) break
        const frame = pending.subarray(0, size + 1)
        pending = pending.subarray(size + 1)
        if (frame[0] !== 0x5a) options.onRawData(frame)
      }
    } })
    if (pending.length) throw new Error('Incomplete PGlite backend frame')
  }
}
