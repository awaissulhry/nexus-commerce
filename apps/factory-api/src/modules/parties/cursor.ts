import { ValidationError } from '@nexus/factory-domain/core/errors'

/**
 * The VIES history's cursor (newest first): the last row's request time and id, as base64url JSON. An opaque value for
 * the client: it sends `nextCursor` back as it came. The party list pages by code (below).
 */

export interface InstantCursor {
  readonly at: Date
  readonly id: string
}

export const encodeInstantCursor = (cursor: InstantCursor): string => Buffer.from(JSON.stringify([cursor.at.toISOString(), cursor.id]), 'utf8').toString('base64url')

export function decodeInstantCursor(value: string | undefined): InstantCursor | null {
  if (value === undefined || value === '') return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      const at = new Date(parsed[0])
      if (!Number.isNaN(at.getTime())) return { at, id: parsed[1] }
    }
  } catch {
    // falls through to the refusal
  }
  throw new ValidationError('The cursor is not valid.', [{ path: 'querystring/cursor', message: 'Send back nextCursor as it came.' }])
}

/** The party list's cursor (by code): the last row's code and id. */
export interface CodeCursor {
  readonly code: string
  readonly id: string
}

export const encodeCodeCursor = (cursor: CodeCursor): string => Buffer.from(JSON.stringify([cursor.code, cursor.id]), 'utf8').toString('base64url')

export function decodeCodeCursor(value: string | undefined): CodeCursor | null {
  if (value === undefined || value === '') return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') return { code: parsed[0], id: parsed[1] }
  } catch {
    // falls through to the refusal
  }
  throw new ValidationError('The cursor is not valid.', [{ path: 'querystring/cursor', message: 'Send back nextCursor as it came.' }])
}

/** The rows after the cursor, in (code, id) order. */
export const afterCodeCursor = (cursor: CodeCursor | null) => (cursor ? { OR: [{ code: { gt: cursor.code } }, { code: cursor.code, id: { gt: cursor.id } }] } : {})

// ── B-CL-002 (customers list): the cursor of the list in another order — the sort and the last row's key, as base64url JSON ──
/** One part of a row's key in the needs or name order (./work needsKeyOf, nameKeyOf). */
export type KeyPart = string | number
/** The orders whose cursor is a key (the code order keeps its own cursor above). */
export type KeySort = 'needs' | 'name'

/** The key's shape per order: needs = [waiting, level, −priority, promise, code, id]; name = [name, code, id]. */
const KEY_SHAPES: Readonly<Record<KeySort, readonly ('number' | 'string')[]>> = Object.freeze({
  needs: ['number', 'number', 'number', 'string', 'string', 'string'],
  name: ['string', 'string', 'string'],
})

export const encodeKeyCursor = (sort: KeySort, key: readonly KeyPart[]): string => Buffer.from(JSON.stringify([sort, ...key]), 'utf8').toString('base64url')

/** The key of the row before this page, or null for the first page; a cursor of another order or shape is refused (400). */
export function decodeKeyCursor(value: string | undefined, sort: KeySort): readonly KeyPart[] | null {
  if (value === undefined || value === '') return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    const shape = KEY_SHAPES[sort]
    if (Array.isArray(parsed) && parsed[0] === sort && parsed.length === shape.length + 1 && shape.every((type, index) => typeof parsed[index + 1] === type)) return parsed.slice(1) as KeyPart[]
  } catch {
    // falls through to the refusal
  }
  throw new ValidationError('The cursor is not valid.', [{ path: 'querystring/cursor', message: 'Send back nextCursor as it came.' }])
}
// ── end B-CL-002 ──
