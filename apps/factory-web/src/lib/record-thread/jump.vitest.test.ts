import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../i18n/locales'
import { createTranslator, messagesFor } from '../i18n/messages'
import { JUMP_LIMIT, JUMP_PAGE, jumpRefusal, pageBack } from './jump'

/** pt-w1 W1.4 (lane pt-, S5; ONE SHARED THREAD): the jump both doors run — pages of 200 until the message is there, at most 1,000. */

type Message = { readonly id: string }
/** A thread of `total` older messages behind the loaded ones, read newest first in pages after a cursor ("c0", "c200", …). */
const olderThread = (total: number, failAt: number | null = null) => {
  const asked: Array<{ cursor: string; size: number }> = []
  const readPage = async (cursor: string, size: number): Promise<{ messages: Message[]; nextCursor: string | null }> => {
    asked.push({ cursor, size })
    const from = Number(cursor.slice(1))
    if (failAt !== null && from >= failAt) throw new Error('the page could not be read')
    const to = Math.min(total, from + size)
    return { messages: Array.from({ length: to - from }, (_, index) => ({ id: `m${from + index}` })), nextCursor: to < total ? `c${to}` : null }
  }
  return { asked, readPage }
}
const loaded = new Set(['new-1', 'new-2'])
const has = (id: string) => loaded.has(id)

describe('pt-w1 W1.4 — the jump both doors run', () => {
  it('a jump reads pages of 200 until the message is there, at most 1,000, and says why when it is not: a page failed, too far back, out of reach', async () => {
    expect([JUMP_PAGE, JUMP_LIMIT]).toEqual([200, 1000])
    const ask = (id: string, total: number, failAt: number | null = null) => {
      const thread = olderThread(total, failAt)
      return { thread, back: pageBack({ id, has, cursor: 'c0', readPage: thread.readPage, page: JUMP_PAGE, limit: JUMP_LIMIT }) }
    }

    // Loaded already: nothing is read.
    const there = ask('new-1', 5000)
    expect(await there.back).toEqual({ read: [], cursor: 'c0', found: true, failed: false, pages: 0 })
    expect(there.thread.asked).toEqual([])
    expect(jumpRefusal(await there.back)).toBeNull()

    // 450 messages back: three pages of 200, then it is there; the host applies every page read in ONE render.
    const back = ask('m450', 5000)
    const found = await back.back
    expect(back.thread.asked).toEqual([{ cursor: 'c0', size: 200 }, { cursor: 'c200', size: 200 }, { cursor: 'c400', size: 200 }])
    expect(found).toMatchObject({ found: true, failed: false, pages: 3, cursor: 'c600' })
    expect(found.read).toHaveLength(600)
    expect(jumpRefusal(found)).toBeNull()

    // Past 1,000 older messages with more left: five pages, then "Too far back to open here."
    const far = await ask('m4000', 5000).back
    expect(far).toMatchObject({ found: false, failed: false, pages: 5, cursor: 'c1000' })
    expect(jumpRefusal(far)).toEqual({ ns: 'record-thread', key: 'notice.messageGone' })

    // A page could not be read: it stops there and says so; what was read before it is still handed to the host.
    const failed = await ask('m700', 5000, 400).back
    expect(failed).toMatchObject({ found: false, failed: true, pages: 2, cursor: 'c400' })
    expect(failed.read).toHaveLength(400)
    expect(jumpRefusal(failed)).toEqual({ ns: 'record-thread-feed', key: 'older.failed' })

    // The whole thread read and no such message for this reader: "That message is out of your reach."
    const gone = await ask('someone-elses', 300).back
    expect(gone).toMatchObject({ found: false, failed: false, pages: 2, cursor: null })
    expect(jumpRefusal(gone)).toEqual({ ns: 'record-thread', key: 'notice.outOfReach' })

    // No older page at all.
    expect(await pageBack({ id: 'm1', has, cursor: null, readPage: olderThread(10).readPage, page: JUMP_PAGE, limit: JUMP_LIMIT })).toEqual({ read: [], cursor: null, found: false, failed: false, pages: 0 })
  })

  // Moved from areas/_shared/record-thread/use-record-thread.vitest.test.ts (tw- W1.4, B10) with jumpRefusal.
  it('B10: the words when a jump does not reach its message — a page failed, too far back (more left past 1,000), out of reach', () => {
    expect(jumpRefusal({ found: true, failed: false, cursor: 'c' })).toBeNull()
    expect(jumpRefusal({ found: false, failed: true, cursor: 'c' })).toEqual({ ns: 'record-thread-feed', key: 'older.failed' })
    expect(jumpRefusal({ found: false, failed: false, cursor: 'c' })).toEqual({ ns: 'record-thread', key: 'notice.messageGone' })
    expect(jumpRefusal({ found: false, failed: false, cursor: null })).toEqual({ ns: 'record-thread', key: 'notice.outOfReach' })
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['record-thread'])['record-thread']!)
      expect(t('notice.messageGone')).toBe(locale === 'en' ? 'Too far back to open here.' : 'Troppo indietro per aprirlo qui.')
      expect(t('notice.outOfReach')).toBe(locale === 'en' ? 'That message is out of your reach.' : 'Quel messaggio è fuori dalla tua portata.')
      expect(t('notice.viewAll')).toBe(locale === 'en' ? 'Showing all messages' : 'Mostro tutti i messaggi')
    }
  })

  it('the jump imports no office, portal or session code, fetches nothing itself and never scrolls the page', () => {
    const source = readFileSync(new URL('./jump.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/from '[^']*(areas|portal|shell|record-panels|lib\/api|lib\/session)\//)
    expect(source).not.toMatch(/\bfetch\(|scrollIntoView\(/)
    expect(source).toContain('centreInList(target) // tw- fx2 (G-3): the list scrolls, never the page')
  })
})
