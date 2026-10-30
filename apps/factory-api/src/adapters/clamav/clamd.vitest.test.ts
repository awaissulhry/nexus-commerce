import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { EICAR } from '../../platform/files/scan/fake'
import { ScannerUnavailableError } from '../../platform/files/scan/port'
import { clamdScanner, engineOf, instreamFrames, verdictOf } from './clamd'

/**
 * The ClamAV adapter against a made-up clamd on a loopback port (the protocol as clamd speaks it: z-commands ending in
 * NUL, INSTREAM chunks with a 4-byte big-endian length, a zero length at the end, a NUL-ended reply). No real scanner,
 * no network beyond 127.0.0.1.
 */

interface FakeClamd {
  readonly port: number
  readonly streams: Buffer[]
  versions: number
  close(): Promise<void>
}

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** A clamd that answers VERSION and INSTREAM; `mode` makes it slow, silent or strict about size. */
async function fakeClamd(mode: 'normal' | 'silent' | 'slow' | 'hangup' | { maxBytes: number } = 'normal'): Promise<FakeClamd> {
  const state = { streams: [] as Buffer[], versions: 0 }
  const server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0)
    let command: string | null = null
    const body: Buffer[] = []
    let received = 0
    socket.on('error', () => undefined)
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data])
      if (command === null) {
        const end = buffer.indexOf(0)
        if (end < 0) return
        command = buffer.subarray(0, end).toString('latin1')
        buffer = buffer.subarray(end + 1)
        if (mode === 'silent') return
        if (mode === 'hangup') return void socket.destroy()
        if (command === 'zVERSION') {
          state.versions++
          return void socket.end('ClamAV 1.4.1/27450/Thu Oct 29 08:00:00 2026\0')
        }
      }
      if (command !== 'zINSTREAM' || mode === 'slow') return
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0)
        if (length === 0) {
          const file = Buffer.concat(body)
          state.streams.push(file)
          return void socket.end(file.includes(Buffer.from(EICAR, 'latin1')) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0')
        }
        if (buffer.length < 4 + length) return
        body.push(buffer.subarray(4, 4 + length))
        received += length
        buffer = buffer.subarray(4 + length)
        if (typeof mode === 'object' && received > mode.maxBytes) return void socket.end('INSTREAM size limit exceeded. ERROR\0')
      }
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return {
    port: (server.address() as AddressInfo).port,
    streams: state.streams,
    get versions() {
      return state.versions
    },
    set versions(value) {
      state.versions = value
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('clamd INSTREAM', () => {
  it('sends the file in chunks and reads CLEAN, with the engine from VERSION', async () => {
    const clamd = await fakeClamd()
    const scanner = clamdScanner({ host: '127.0.0.1', port: clamd.port })
    const bytes = Buffer.alloc(200_000, 7)
    expect(await scanner.scan(bytes)).toEqual({ verdict: 'CLEAN', engine: 'ClamAV 1.4.1/27450' })
    expect(clamd.streams[0]!.equals(bytes)).toBe(true)
  })

  it('reads INFECTED with the signature name', async () => {
    const clamd = await fakeClamd()
    const scanner = clamdScanner({ host: '127.0.0.1', port: clamd.port })
    expect(await scanner.scan(Buffer.from(EICAR, 'latin1'))).toEqual({ verdict: 'INFECTED', engine: 'ClamAV 1.4.1/27450', finding: 'Eicar-Test-Signature' })
  })

  it('reads a size refusal as FAILED, in words', async () => {
    const clamd = await fakeClamd({ maxBytes: 100_000 })
    const scanner = clamdScanner({ host: '127.0.0.1', port: clamd.port })
    expect(await scanner.scan(Buffer.alloc(300_000, 1))).toEqual({ verdict: 'FAILED', engine: 'ClamAV 1.4.1/27450', finding: 'The file is larger than the scanner takes.' })
  })

  it('asks the version once per 10 minutes', async () => {
    const clamd = await fakeClamd()
    let now = 0
    const scanner = clamdScanner({ host: '127.0.0.1', port: clamd.port, now: () => now })
    await scanner.scan(Buffer.from('a'))
    await scanner.scan(Buffer.from('b'))
    expect(clamd.versions).toBe(1)
    now += 10 * 60_000
    await scanner.scan(Buffer.from('c'))
    expect(clamd.versions).toBe(2)
  })

  it('a scanner that is not there is unavailable, never clean', async () => {
    const clamd = await fakeClamd()
    await clamd.close()
    servers.length = 0
    const scanner = clamdScanner({ host: '127.0.0.1', port: clamd.port, connectTimeoutMs: 500 })
    await expect(scanner.scan(Buffer.from('a'))).rejects.toBeInstanceOf(ScannerUnavailableError)
  })

  it('a scanner that hangs up without an answer is unavailable', async () => {
    const clamd = await fakeClamd('hangup')
    const scanner = clamdScanner({ host: '127.0.0.1', port: clamd.port })
    await expect(scanner.scan(Buffer.from('a'))).rejects.toBeInstanceOf(ScannerUnavailableError)
  })

  it('a scan that does not finish in time is FAILED; a scanner that does not even say its version is unavailable', async () => {
    const slow = await fakeClamd('slow')
    expect(await clamdScanner({ host: '127.0.0.1', port: slow.port, scanTimeoutMs: 200 }).scan(Buffer.from('a'))).toEqual({
      verdict: 'FAILED',
      engine: 'ClamAV 1.4.1/27450',
      finding: 'The scanner did not finish within 1 s.',
    })
    const silent = await fakeClamd('silent')
    await expect(clamdScanner({ host: '127.0.0.1', port: silent.port, scanTimeoutMs: 200 }).scan(Buffer.from('a'))).rejects.toBeInstanceOf(ScannerUnavailableError)
  })
})

describe('the protocol pieces', () => {
  it('frames a file: the command, 64 KiB chunks with their length, a zero length', () => {
    const frames = instreamFrames(Buffer.alloc(70_000, 2))
    expect(frames[0]!.toString('latin1')).toBe('zINSTREAM\0')
    expect(frames[1]!.readUInt32BE(0)).toBe(65_536)
    expect(frames[2]!.length).toBe(65_536)
    expect(frames[3]!.readUInt32BE(0)).toBe(70_000 - 65_536)
    expect(frames.at(-1)!.equals(Buffer.alloc(4))).toBe(true)
  })

  it('reads the replies', () => {
    expect(engineOf('ClamAV 1.4.1/27450/Thu Oct 29 08:00:00 2026')).toBe('ClamAV 1.4.1/27450')
    expect(engineOf('ClamAV 1.4.1')).toBe('ClamAV 1.4.1')
    expect(verdictOf('stream: OK', 'e')).toEqual({ verdict: 'CLEAN', engine: 'e' })
    expect(verdictOf('stream: Win.Test.EICAR_HDB-1 FOUND', 'e')).toEqual({ verdict: 'INFECTED', engine: 'e', finding: 'Win.Test.EICAR_HDB-1' })
    expect(verdictOf('Can\'t allocate memory ERROR', 'e')).toMatchObject({ verdict: 'FAILED', finding: expect.stringContaining('allocate memory') })
  })
})
