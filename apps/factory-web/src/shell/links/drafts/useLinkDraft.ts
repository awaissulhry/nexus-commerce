'use client'

import { z } from 'zod'
import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { DRAFT_MAX_BYTES, DRAFT_SAVE_DELAY_MS, draftBandStep, draftBytes, idleBand, type DraftEvent, type LinkDraftBand } from './model'

const draftSchema = z.object({
  draft: z.object({ data: z.record(z.string(), z.unknown()), version: z.number(), savedAt: z.string(), purgeAfter: z.string() }).nullable(),
  link: z.object({ expiresAt: z.string() }),
})
const savedSchema = z.object({ draft: z.object({ version: z.number(), savedAt: z.string(), purgeAfter: z.string() }) })

type Data = Record<string, unknown>

/**
 * B-W2b-169 — the link frame's "Finish later" for a long form (design links.frame sec:drafts): reads the draft kept with
 * us once the page is `ready` (`GET /link/draft`; `restore` decides whether the form takes it), keeps every change
 * `DRAFT_SAVE_DELAY_MS` later (`PUT /link/draft`, each save its own Idempotency-Key; one save at a time, a change during
 * a save saves again after it; a stale save — 409 — reads the newer version and saves over it), saves at once on Finish
 * later, and stops on a dead link (404). Nothing is kept on the device. A form's send drops the draft on the API's side.
 */
export function useLinkDraft(api: ApiClient, options: { ready: boolean; restore: (data: Data, savedAt: string) => boolean }) {
  const [band, setBand] = useState<LinkDraftBand>(idleBand)
  const step = useCallback((event: DraftEvent) => setBand((now) => draftBandStep(now, event)), [])
  const version = useRef<number | null>(null)
  const latest = useRef<Data | null>(null)
  const saving = useRef(false)
  const again = useRef<{ later: boolean } | null>(null)
  const dead = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const restore = useRef(options.restore)
  restore.current = options.restore

  useEffect(() => {
    if (!options.ready) return
    let live = true
    api
      .get('/link/draft', { schema: draftSchema })
      .then((read) => {
        if (!live) return
        version.current = read.draft?.version ?? null
        const taken = read.draft ? restore.current(read.draft.data, read.draft.savedAt) : false
        step({ type: 'read', until: read.link.expiresAt, restoredAt: taken && read.draft ? read.draft.savedAt : null })
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [api, options.ready, step])

  const save = useCallback(
    async (later: boolean): Promise<void> => {
      const data = latest.current
      if (!data || dead.current || draftBytes(data) > DRAFT_MAX_BYTES) return
      if (saving.current) {
        again.current = { later: later || (again.current?.later ?? false) }
        return
      }
      saving.current = true
      step({ type: 'saving' })
      const put = () =>
        api.request('PUT', '/link/draft', { body: version.current === null ? { data } : { data, version: version.current }, schema: savedSchema, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.draft)
      try {
        let saved
        try {
          saved = await put()
        } catch (error) {
          if (!isApiError(error) || error.kind !== 'conflict') throw error
          // Saved meanwhile from another tab: take its version and save this one over it.
          const read = await api.get('/link/draft', { schema: draftSchema })
          version.current = read.draft?.version ?? null
          saved = await put()
        }
        version.current = saved.version
        step({ type: 'saved', at: saved.savedAt, later })
      } catch (error) {
        if (isApiError(error) && error.kind === 'not_found') {
          dead.current = true
          step({ type: 'dead' })
        } else step({ type: 'failed' })
      } finally {
        saving.current = false
      }
      const next = again.current
      again.current = null
      if (next) await save(next.later)
    },
    [api, step],
  )

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  /** A change of the form: kept with us a moment later. */
  const change = useCallback(
    (data: Data) => {
      latest.current = data
      step({ type: 'changed' })
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void save(false), DRAFT_SAVE_DELAY_MS)
    },
    [save, step],
  )

  /** Finish later: saved at once; the band then says the page may be closed. */
  const finishLater = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    void save(true)
  }, [save])

  return { band, change, finishLater, retry: () => void save(false), dismissRestored: () => step({ type: 'dismiss' }) }
}
