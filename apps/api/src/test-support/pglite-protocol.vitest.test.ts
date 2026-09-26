import { describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { fixExtendedQueryReady } from './pglite-protocol.js'

type StreamOptions = Parameters<PGlite['execProtocolRawStream']>[1]

function frame(type: string, payload: Uint8Array = Buffer.alloc(0)): Buffer {
  const result = Buffer.alloc(5 + payload.length)
  result[0] = type.charCodeAt(0)
  result.writeUInt32BE(4 + payload.length, 1)
  result.set(payload, 5)
  return result
}

const READY = frame('Z', Buffer.from('E'))
const ERROR = frame('E', Buffer.from('SERROR\0C23514\0MBusiness ownership cannot be reassigned\0\0'))
const NOTICE = frame('N', Buffer.from('SNOTICE\0Mdo not discard this notice\0\0'))
const COMPLETE = frame('C', Buffer.from('ROLLBACK\0'))

function fixture(chunks: Uint8Array[], failure?: Error) {
  const calls: Array<{ message: Uint8Array; options: StreamOptions; receiver: unknown }> = []
  const db = {
    async execProtocolRawStream(message: Uint8Array, options: StreamOptions) {
      calls.push({ message, options, receiver: this })
      for (const chunk of chunks) options!.onRawData(chunk)
      if (failure) throw failure
    },
  }
  // Only this method is used by the wrapper. No fake SQL semantics or database state.
  fixExtendedQueryReady(db as unknown as PGlite)
  const execute = async (message: Uint8Array) => {
    const output: Buffer[] = []
    await db.execProtocolRawStream(message, { syncToFs: false, onRawData: bytes => output.push(Buffer.from(bytes)) })
    return Buffer.concat(output)
  }
  return { db, calls, execute }
}

describe('PGlite extended-query ReadyForQuery repair', () => {
  it.each(['P', 'B', 'D', 'E', 'C', 'H'])(
    'removes premature Ready after frontend %s while retaining the actual error and other frames', async type => {
      const { execute } = fixture([Buffer.concat([NOTICE, ERROR, READY, COMPLETE])])
      expect(await execute(frame(type))).toEqual(Buffer.concat([NOTICE, ERROR, COMPLETE]))
    },
  )

  it.each(['S', 'Q'])('preserves every byte of a frontend %s response including Ready', async type => {
    const response = Buffer.concat([ERROR, READY])
    const { execute } = fixture([response.subarray(0, 3), response.subarray(3)])
    expect(await execute(frame(type))).toEqual(response)
  })

  it('preserves startup responses unchanged', async () => {
    const startup = Buffer.alloc(8)
    startup.writeUInt32BE(8, 0)
    startup.writeUInt32BE(196608, 4)
    const response = Buffer.concat([frame('R', Buffer.alloc(4)), READY])
    const { execute } = fixture([response])
    expect(await execute(startup)).toEqual(response)
  })

  it('does not classify a combined Parse and Sync buffer as one extended message', async () => {
    const { execute } = fixture([ERROR, READY])
    expect(await execute(Buffer.concat([frame('P'), frame('S')]))).toEqual(Buffer.concat([ERROR, READY]))
  })

  it('reassembles headers and payloads split at every possible byte boundary', async () => {
    const response = Buffer.concat([NOTICE, ERROR, READY, COMPLETE])
    const expected = Buffer.concat([NOTICE, ERROR, COMPLETE])
    for (let split = 1; split < response.length; split++) {
      const { execute } = fixture([response.subarray(0, split), response.subarray(split)])
      expect(await execute(frame('P')), `response split at byte ${split}`).toEqual(expected)
    }
    const { execute } = fixture(Array.from(response, byte => Uint8Array.of(byte)))
    expect(await execute(frame('P'))).toEqual(expected)
  })

  it('preserves a large data frame including Z bytes inside its payload', async () => {
    const data = frame('D', Buffer.alloc(256 * 1024, 'Z'))
    const response = Buffer.concat([data, COMPLETE, READY])
    const chunks = []
    for (let offset = 0; offset < response.length; offset += 997) chunks.push(response.subarray(offset, offset + 997))
    const { execute } = fixture(chunks)
    expect(await execute(frame('E'))).toEqual(Buffer.concat([data, COMPLETE]))
  })

  it.each([
    ['truncated header', ERROR.subarray(0, 4)],
    ['truncated payload', ERROR.subarray(0, ERROR.length - 1)],
    ['invalid length', Uint8Array.of('E'.charCodeAt(0), 0, 0, 0, 3)],
  ])('fails explicitly for a %s instead of silently accepting partial protocol output', async (_description, bytes) => {
    const { execute } = fixture([bytes])
    await expect(execute(frame('P'))).rejects.toThrow()
  })

  it('preserves the stream error even when no final protocol frame arrives', async () => {
    const failure = new Error('backend stream failed')
    const { execute } = fixture([ERROR], failure)
    await expect(execute(frame('P'))).rejects.toBe(failure)
  })

  it('preserves the original receiver, frontend input and other stream options', async () => {
    const input = frame('P')
    const { db, calls, execute } = fixture([ERROR, READY])
    await execute(input)
    expect(calls).toHaveLength(1)
    expect(calls[0].receiver).toBe(db)
    expect(calls[0].message).toBe(input)
    expect(calls[0].options!.syncToFs).toBe(false)
  })
})
