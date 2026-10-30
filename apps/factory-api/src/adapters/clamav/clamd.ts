import { createConnection, type Socket } from 'node:net'
import { ScannerUnavailableError, type ScanVerdict, type VirusScanner } from '../../platform/files/scan/port'

/**
 * The ClamAV adapter (PLT-245; B-W2a-42): clamd's own protocol over TCP, with no npm package (node:net only).
 *
 *   zVERSION\0                       → "ClamAV 1.4.1/27450/<signature date>\0": the engine and signature version, kept
 *                                       as the file's scanEngine ("ClamAV 1.4.1/27450"); asked again every 10 minutes
 *   zINSTREAM\0 <len><bytes>… <0000> → "stream: OK\0" (CLEAN) | "stream: <signature> FOUND\0" (INFECTED) |
 *                                       "… ERROR\0" (FAILED: "INSTREAM size limit exceeded" when the file is larger than
 *                                       clamd's StreamMaxLength, an archive it cannot open…)
 * Each chunk is a 4-byte big-endian length and its bytes (64 KiB chunks); a zero length ends the stream.
 *
 * The scanner is platform infrastructure (a ClamAV container in the API's private network, one per environment), not a
 * tenant's integration account: it is called directly from here, like the KMS key provider, without an IntegrationCall
 * row. A connection that is refused, cannot be made in `connectTimeoutMs` or closes without an answer throws
 * ScannerUnavailableError (the file stays held); a scan that does not finish in `scanTimeoutMs` is FAILED.
 * Live use needs the Owner's spend yes (GATE-SPEND: the scanner service).
 */

export interface ClamdOptions {
  readonly host: string
  readonly port: number
  /** Default 5 s. */
  readonly connectTimeoutMs?: number
  /** Default 30 s, for one file. */
  readonly scanTimeoutMs?: number
  /** Tests: the clock of the version cache. */
  readonly now?: () => number
}

const CHUNK = 64 * 1024
const VERSION_TTL_MS = 10 * 60_000
const MAX_REPLY = 4096

class ScanTimedOut extends Error {
  override name = 'ScanTimedOut'
}

/** One command on a fresh connection: the reply up to its NUL (or the end of the stream). */
function exchange(options: ClamdOptions, write: (socket: Socket) => void): Promise<string> {
  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000
  const scanTimeoutMs = options.scanTimeoutMs ?? 30_000
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: options.host, port: options.port })
    const chunks: Buffer[] = []
    let size = 0
    let connected = false
    let settled = false
    const done = (error: Error | null, reply?: string) => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      clearTimeout(scanTimer)
      socket.destroy()
      if (error) reject(error)
      else resolve(reply ?? '')
    }
    const connectTimer = setTimeout(() => done(new ScannerUnavailableError(`The virus scanner did not answer within ${connectTimeoutMs} ms.`)), connectTimeoutMs)
    let scanTimer: ReturnType<typeof setTimeout> | undefined
    socket.on('connect', () => {
      connected = true
      clearTimeout(connectTimer)
      scanTimer = setTimeout(() => done(new ScanTimedOut(`The scanner did not finish within ${Math.max(1, Math.round(scanTimeoutMs / 1000))} s.`)), scanTimeoutMs)
      try {
        write(socket)
      } catch (error) {
        done(error as Error)
      }
    })
    socket.on('data', (data: Buffer) => {
      chunks.push(data)
      size += data.length
      const all = Buffer.concat(chunks)
      const end = all.indexOf(0)
      if (end >= 0) done(null, all.subarray(0, end).toString('utf8').trim())
      else if (size > MAX_REPLY) done(new ScannerUnavailableError('The virus scanner gave an answer it should not.'))
    })
    socket.on('end', () => done(chunks.length > 0 ? null : new ScannerUnavailableError('The virus scanner closed the connection without an answer.'), Buffer.concat(chunks).toString('utf8').replace(/\0+$/, '').trim()))
    socket.on('error', (error: NodeJS.ErrnoException) => {
      done(connected && chunks.length > 0 ? null : new ScannerUnavailableError(`The virus scanner is not reachable (${error.code ?? error.name}).`), Buffer.concat(chunks).toString('utf8').trim())
    })
  })
}

/** The engine from a VERSION reply: "ClamAV 1.4.1/27450/Wed Oct 29 08:00:00 2026" → "ClamAV 1.4.1/27450". */
export function engineOf(reply: string): string {
  const parts = reply.trim().split('/')
  const engine = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0] ?? ''
  return engine.trim().slice(0, 80) || 'ClamAV'
}

/** What an INSTREAM reply says about the file. */
export function verdictOf(reply: string, engine: string): ScanVerdict {
  const text = reply.trim()
  if (/^stream: OK$/i.test(text)) return { verdict: 'CLEAN', engine }
  const found = /^stream: (.+) FOUND$/i.exec(text)
  if (found) return { verdict: 'INFECTED', engine, finding: found[1]!.trim().slice(0, 200) }
  if (/size limit exceeded/i.test(text)) return { verdict: 'FAILED', engine, finding: 'The file is larger than the scanner takes.' }
  return { verdict: 'FAILED', engine, finding: `The scanner could not read this file (${text.replace(/\s*ERROR$/i, '').slice(0, 160) || 'no answer'}).` }
}

/** The stream of a file: `zINSTREAM\0`, the chunks, the zero length. */
export function instreamFrames(bytes: Uint8Array): Buffer[] {
  const frames: Buffer[] = [Buffer.from('zINSTREAM\0', 'latin1')]
  for (let at = 0; at < bytes.byteLength; at += CHUNK) {
    const chunk = bytes.subarray(at, Math.min(at + CHUNK, bytes.byteLength))
    const length = Buffer.alloc(4)
    length.writeUInt32BE(chunk.byteLength, 0)
    frames.push(length, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
  }
  frames.push(Buffer.alloc(4))
  return frames
}

export function clamdScanner(options: ClamdOptions): VirusScanner {
  const now = options.now ?? Date.now
  let version: { engine: string; at: number } | null = null
  const engine = async (): Promise<string> => {
    if (version && now() - version.at < VERSION_TTL_MS) return version.engine
    try {
      version = { engine: engineOf(await exchange(options, (socket) => socket.write('zVERSION\0'))), at: now() }
    } catch (error) {
      throw error instanceof ScannerUnavailableError ? error : new ScannerUnavailableError('The virus scanner did not say its version.')
    }
    return version.engine
  }
  return {
    kind: 'clamav',
    async scan(bytes) {
      const name = await engine()
      try {
        const reply = await exchange(options, (socket) => {
          for (const frame of instreamFrames(bytes)) socket.write(frame)
        })
        return verdictOf(reply, name)
      } catch (error) {
        if (error instanceof ScanTimedOut) return { verdict: 'FAILED', engine: name, finding: error.message }
        throw error
      }
    },
  }
}
