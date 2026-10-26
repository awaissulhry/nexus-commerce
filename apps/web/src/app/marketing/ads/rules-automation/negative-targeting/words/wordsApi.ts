/**
 * Negative Targeting page, Words view (step 4) — the view's reads, each through a route that exists. Block word is the
 * page's own POST /waste/preview | apply (waste/wasteApi.ts through useWasteReview), with a word item.
 *
 *   GET  /api/advertising/waste/words?<scope>&show=&q=&sort=&page=&pageSize=   the Words view
 *   GET  /api/advertising/waste/words/ids?<same>                               "select all N that match", Prev / Next
 *   GET  /api/advertising/waste/word/:id?<scope lists>                         one word: its terms, places, products, history
 */
import { getBackendUrl } from '@/lib/backend-url'
import type { ScopeApi } from '../../_shared/scopeFilter/scopeFilterModel'
import type { IdsAnswer } from '../waste/wasteTypes'
import { wordSearch, wordsSearch, type WordsQuery } from './wordsModel'
import type { WordDetail, WordRow, WordsAnswer } from './wordsTypes'

const WASTE = '/api/advertising/waste'

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(`${getBackendUrl()}${path}`, { cache: 'no-store', signal })
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: unknown } | null
    throw new Error(typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : `HTTP ${r.status}`)
  }
  return (await r.json()) as T
}

export const readWords = (q: WordsQuery, signal?: AbortSignal) => getJson<WordsAnswer>(`${WASTE}/words${wordsSearch(q)}`, signal)
export const readWordIds = (q: WordsQuery, signal?: AbortSignal) => getJson<IdsAnswer>(`${WASTE}/words/ids${wordsSearch({ ...q, page: undefined, pageSize: undefined })}`, signal)
export const readWord = (id: string, lists: ScopeApi | null | undefined, signal?: AbortSignal) => getJson<WordDetail>(`${WASTE}/word/${encodeURIComponent(id)}${wordSearch(lists)}`, signal)

/** Every word the list matches, page by page (export, a ticked word on another page), at most `cap`. */
export async function readAllWords(q: WordsQuery, cap = 5000): Promise<WordRow[]> {
  const out: WordRow[] = []
  for (let page = 1; out.length < cap; page++) {
    const a = await readWords({ ...q, page, pageSize: 200 })
    out.push(...a.rows)
    if (!a.rows.length || out.length >= a.total) break
  }
  return out.slice(0, cap)
}
