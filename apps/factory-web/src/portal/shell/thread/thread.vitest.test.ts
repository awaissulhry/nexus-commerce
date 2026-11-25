import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { partnerThreadSchema } from '../api'

/**
 * pt-w2 (lane pt-, ONE SHARED THREAD): the portal's thread — its reads (W2.1), its host (W2.3). The thread tests of the portal frame
 * live here now (they left portal/shell/record/record-frame.vitest.test.ts with the face).
 */

const api = readFileSync(new URL('../api.ts', import.meta.url), 'utf8')
const threadBlock = api.slice(api.indexOf("// ── a record's conversation"), api.indexOf('// ── the portal terms'))

// ---- W2.1: the reads -------------------------------------------------------------------------------------------------------------------
describe('pt-w2 W2.1 — the portal thread’s reads', () => {
  it('WALL: the portal’s thread schema reads no field the partner contract never sends (authorId, audience, mail, amount)', () => {
    expect(threadBlock.length).toBeGreaterThan(1000)
    expect(threadBlock).not.toMatch(/\b(authorId|audience|amount|mail|email|forFloor|pinnedBy|readBy|seenBy)\s*:/)
    // Even when an answer carried office fields, the schema drops them (it reads only what it names).
    const read = partnerThreadSchema.parse({
      record: { type: 'SalesOrder', id: 'o1', theirRef: 'PO-1', ourRef: 'SO-1', subtitle: null, status: null },
      thread: { id: 't1', status: 'OPEN' },
      messages: [
        {
          id: 'm2',
          side: 'PARTNER',
          channel: 'PORTAL',
          author: { name: 'Lia Modello', mine: true, id: 'u-9' },
          body: 'The sizes are fine.',
          attachments: [{ id: 'f1', originalName: 'Price list.pdf', sizeBytes: 900, kind: 'DOCUMENT', contentType: 'application/pdf', status: 'AVAILABLE', locked: 'PRICED' }],
          replyTo: { id: 'm1', authorName: 'Bea Esempio', excerpt: 'Are the sizes fine?', at: '2026-11-17T09:00:00.000Z', authorKind: 'USER', authorId: 'u-1', audience: 'OFFICE' },
          audience: 'PARTNER',
          amount: { value: 12, currency: 'EUR' },
          at: '2026-11-17T09:05:00.000Z',
        },
      ],
      nextCursor: null,
      composer: { canPost: true, reason: null, words: null, replyByEmail: true, hint: null },
    })
    const message = read.messages[0]!
    expect(message).not.toHaveProperty('audience')
    expect(message).not.toHaveProperty('amount')
    expect(message.author).toEqual({ name: 'Lia Modello', mine: true })
    expect(message.replyTo).toEqual({ id: 'm1', authorName: 'Bea Esempio', excerpt: 'Are the sizes fine?', at: '2026-11-17T09:00:00.000Z', authorKind: 'USER' })
    expect(message.attachments[0]).toMatchObject({ locked: 'PRICED', contentType: 'application/pdf' })
    // An older answer (no link, no file type) still reads.
    expect(partnerThreadSchema.parse({ ...read, messages: [{ id: 'm3', side: 'COMPANY', channel: 'EMAIL', author: { name: null, mine: false }, body: 'x', attachments: [{ id: 'f2', originalName: 'a.pdf', sizeBytes: 1 }], at: '2026-11-17T09:06:00.000Z' }] }).messages[0]!.replyTo).toBeUndefined()
  })

  it('a jump reads the same page read (no new route), in pages of up to 200; Reply posts the message it answers, never a correction', () => {
    expect(threadBlock).toContain('export const fetchThread = (api: ApiClient, type: string, id: string, cursor?: string | null, signal?: AbortSignal, limit: number = THREAD_PAGE) =>')
    expect(threadBlock).toContain('export const THREAD_PAGE = 50')
    expect(threadBlock).toContain("...(options.replyToMessageId ? { replyToMessageId: options.replyToMessageId } : {})")
    expect(threadBlock).not.toContain('correctsMessageId')
  })
})
// ---- end W2.1
