'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { DEFAULT_TIME_ZONE } from '../../../../lib/i18n/format'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { failedRead, problemKey, qualityCan, ready, reading, type Read } from '../../_shared/model'
import { holdPeople, holdReasons, placeHold, previewHold, type HoldPreview, type Person } from '../api'
import { fieldOf, placeBody, placeDraftOf, placeProblems, type PlaceDraft, type PlaceHoldPrefill } from '../model'
import { PlaceHoldDialog } from './view/PlaceHoldDialog'

export type { PlaceHoldPrefill } from '../model'

/** The office's day in the site's zone (`YYYY-MM-DD`): the earliest expected release. */
export function officeToday(now = new Date(), timeZone = DEFAULT_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** A refusal of POST /quality/holds in our words: the key, the API's sentences (data) and the fields it names. */
export function placeRefusal(error: unknown): { problem: string; lines: string[]; fields: string[] } {
  if (!isApiError(error)) return { problem: problemKey(error), lines: [], fields: [] }
  const lines = error.issues.map((issue) => issue.message ?? '').filter(Boolean)
  const fields = [...new Set(error.issues.map((issue) => fieldOf(issuePath(issue))).filter(Boolean))]
  const problem = error.kind === 'invalid' ? 'place.problem.refused' : error.kind === 'forbidden' ? 'place.problem.forbidden' : error.kind === 'conflict' ? 'place.problem.conflict' : problemKey(error)
  return { problem, lines: lines.length > 0 ? lines : error.message ? [error.message] : [], fields }
}

/**
 * The ONE Place hold dialog (design quality.holds/pop:qh-place) as a self-contained container: the Holds page (its
 * primary, `c`, `?new=1`) and other lists (an inspection's "Place hold": the work order and the inspection as its source)
 * render it with a prefill. It reads the HOLD reasons when it opens, the preview after each change of the records (a
 * short pause after the typing), the owner picker of the records' site, and places the hold with an Idempotency-Key per
 * attempt (the same key again after a refused network answer).
 */
export function PlaceHold({ open, prefill, onClose, onPlaced }: { open: boolean; prefill: PlaceHoldPrefill | null; onClose: () => void; onPlaced?: (hold: { id: string; workOrdersHeld: number }) => void }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = qualityCan(session.permissions)
  const [draft, setDraft] = useState<PlaceDraft>(() => placeDraftOf(prefill))
  const [preview, setPreview] = useState<Read<HoldPreview> | null>(null)
  const [reasons, setReasons] = useState<Read<readonly { code: string; labelIt: string; labelEn: string; needsDetail: boolean }[]>>(reading())
  const [people, setPeople] = useState<Record<string, Read<readonly Person[]>>>({})
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<{ problem: string; lines: string[]; fields: string[] } | null>(null)
  const key = useRef<string | null>(null)
  const today = officeToday()
  const prefillKey = prefill ? JSON.stringify(prefill) : ''

  // A new opening (or another prefill) starts a new draft and a new key.
  useEffect(() => {
    if (!open) return
    setDraft(placeDraftOf(prefill))
    setPreview(null)
    setRefusal(null)
    key.current = null
  }, [open, prefillKey])

  useEffect(() => {
    if (!open || reasons.value !== null) return
    holdReasons(api)
      .then((list) => setReasons(ready(list.map((entry) => ({ code: entry.code, labelIt: entry.labelIt, labelEn: entry.labelEn, needsDetail: entry.needsDetail })))))
      .catch((error: unknown) => setReasons(failedRead(problemKey(error))))
  }, [api, open, reasons.value])

  // The preview after a pause in the typing; an older answer never replaces a newer one.
  const records = `${draft.subjectType}|${draft.ids.join(',')}|${draft.codes.join(',')}`
  useEffect(() => {
    if (!open || !can.holdsPlace) return
    if (draft.ids.length + draft.codes.length === 0) {
      setPreview(null)
      return
    }
    setPreview(reading())
    const controller = new AbortController()
    const timer = setTimeout(() => {
      previewHold(api, { subjectType: draft.subjectType, ...(draft.ids.length > 0 ? { subjectIds: draft.ids } : {}), ...(draft.codes.length > 0 ? { codes: draft.codes } : {}) }, controller.signal)
        .then((answer) => {
          if (controller.signal.aborted) return
          setPreview(ready(answer))
          setDraft((current) => (current.quarantineLocationId === null && answer.quarantinePlaces.length === 1 ? { ...current, quarantineLocationId: answer.quarantinePlaces[0]!.id } : current))
        })
        .catch((error: unknown) => {
          if ((error as { name?: string } | null)?.name === 'AbortError' || controller.signal.aborted) return
          setPreview(failedRead(problemKey(error)))
        })
    }, 300)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [api, open, can.holdsPlace, records])

  const siteId = preview?.value?.siteId ?? null
  useEffect(() => {
    if (!open || !siteId || people[siteId]) return
    setPeople((current) => ({ ...current, [siteId]: reading() }))
    holdPeople(api, siteId)
      .then((list) => setPeople((current) => ({ ...current, [siteId]: ready(list) })))
      .catch((error: unknown) => setPeople((current) => ({ ...current, [siteId]: failedRead(problemKey(error)) })))
  }, [api, open, siteId, people])

  const place = useCallback(async () => {
    const found = preview?.value
    if (!found || placeProblems(draft, found, reasons.value ?? [], today).length > 0) return
    setBusy(true)
    setRefusal(null)
    key.current ??= newIdempotencyKey()
    try {
      const answer = await placeHold(api, placeBody(draft, found), key.current)
      key.current = null
      onPlaced?.({ id: answer.hold.id, workOrdersHeld: answer.workOrdersHeld.length })
      onClose()
    } catch (error) {
      // A network failure may have placed it: the same key again. A refusal: a new key for the next try.
      if (isApiError(error) && error.kind !== 'unavailable') key.current = null
      setRefusal(placeRefusal(error))
    } finally {
      setBusy(false)
    }
  }, [api, draft, onClose, onPlaced, preview, reasons.value, today])

  return (
    <PlaceHoldDialog
      model={{
        open,
        draft,
        preview,
        reasons,
        people: siteId ? (people[siteId] ?? reading()) : null,
        today,
        busy,
        problem: refusal?.problem ?? null,
        lines: refusal?.lines ?? [],
        fields: refusal?.fields ?? [],
        held: can.holdsPlace ? null : 'held.noPlace',
      }}
      onDraft={(next) => {
        setDraft(next)
        if (refusal) setRefusal(null)
      }}
      onPlace={() => void place()}
      onClose={onClose}
    />
  )
}
