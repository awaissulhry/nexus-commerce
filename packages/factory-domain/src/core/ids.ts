import { randomFillSync } from 'node:crypto'

/**
 * Ids (plan A1 §2.1 and D4, feature PLT-124): every record gets a UUIDv7 made by the app (RFC 9562 §5.7), not by the
 * database, so the factory does not depend on PostgreSQL 18's uuidv7(). Layout: 48 bits of Unix time in
 * milliseconds, the version (7), 12 bits of counter, the variant (10), then 62 random bits.
 *
 * Ids of one generator stay in order, also inside one millisecond: the 12 bits after the version hold a counter that
 * starts at a random value below 2048 in each new millisecond and counts up (RFC 9562 §6.2, method 1). When it would
 * overflow, or when the clock steps back, the generator keeps using the last millisecond plus one, so an id is never
 * smaller than the one before it.
 */

export type IdGenerator = () => string

export interface IdGeneratorOptions {
  /** Milliseconds since the Unix epoch. Default `Date.now`. */
  readonly now?: () => number
  /** Fills a buffer with random bytes. Default `node:crypto` randomFillSync. */
  readonly random?: (bytes: Uint8Array) => void
}

const MAX_COUNTER = 0xfff
const MAX_TIME = 2 ** 48 - 1
const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'))

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** A UUID generator with its own clock and counter. Use `newId`; this is for tests and special clocks. */
export function createIdGenerator(options: IdGeneratorOptions = {}): IdGenerator {
  const now = options.now ?? Date.now
  const random = options.random ?? ((bytes: Uint8Array) => void randomFillSync(bytes))
  let lastTime = -1
  let counter = 0
  const bytes = new Uint8Array(16)
  const entropy = new Uint8Array(10)

  return function nextId(): string {
    random(entropy)
    const seed = ((entropy[8]! << 8) | entropy[9]!) & 0x7ff
    let time = Math.floor(now())
    if (!Number.isSafeInteger(time) || time < 0 || time > MAX_TIME) throw new RangeError(`clock out of range: ${time}`)
    if (time > lastTime) {
      counter = seed
    } else {
      time = lastTime
      counter++
      if (counter > MAX_COUNTER) {
        time++
        counter = seed
      }
    }
    lastTime = time

    let rest = time
    for (let index = 5; index >= 0; index--) {
      bytes[index] = rest % 256
      rest = Math.floor(rest / 256)
    }
    bytes[6] = 0x70 | (counter >> 8)
    bytes[7] = counter & 0xff
    bytes[8] = 0x80 | (entropy[0]! & 0x3f)
    for (let index = 1; index < 8; index++) bytes[8 + index] = entropy[index]!

    let text = ''
    for (let index = 0; index < 16; index++) {
      if (index === 4 || index === 6 || index === 8 || index === 10) text += '-'
      text += HEX[bytes[index]!]
    }
    return text
  }
}

/** A new UUIDv7, in lower case. */
export const newId: IdGenerator = createIdGenerator()

/** A UUID as PostgreSQL's uuid type prints it (lower case, versions 1 to 8, RFC variant). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

export function isUuidV7(value: unknown): value is string {
  return typeof value === 'string' && UUID_V7.test(value)
}

/** The time a UUIDv7 was made (millisecond precision). */
export function idTime(id: string): Date {
  if (!isUuidV7(id)) throw new TypeError('not a UUIDv7')
  const hex = id.slice(0, 8) + id.slice(9, 13)
  return new Date(Number.parseInt(hex, 16))
}
