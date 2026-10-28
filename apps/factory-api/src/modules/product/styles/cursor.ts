import { ValidationError } from '@nexus/factory-domain/core/errors'

/**
 * The lists' cursor (styles and size scales are listed by code): the last row's code and id, as base64url JSON. An
 * opaque value for the client: it sends `nextCursor` back as it came.
 */

export interface Cursor {
  readonly code: string
  readonly id: string
}

export const encodeCursor = (cursor: Cursor): string => Buffer.from(JSON.stringify([cursor.code, cursor.id]), 'utf8').toString('base64url')

export function decodeCursor(value: string | undefined): Cursor | null {
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
export const afterCursor = (cursor: Cursor | null) => (cursor ? { OR: [{ code: { gt: cursor.code } }, { code: cursor.code, id: { gt: cursor.id } }] } : {})
