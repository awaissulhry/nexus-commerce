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
