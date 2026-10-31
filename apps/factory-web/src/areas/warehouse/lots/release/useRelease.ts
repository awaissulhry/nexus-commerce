'use client'

import { useCallback, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import type { LotRow } from '../../../_shared/stock/api'
import { readProblem } from '../../../_shared/stock/model'
import { decideLot } from '../../../compliance/tests/api'
import { releaseCheckOf } from '../api'
import { expectedPhrase, releasable, releaseHeldKey, releaseRefusalKey, type ReleaseActions, type ReleaseDialogModel, type ReleaseLine } from './model'

/**
 * The Release N lots dialog's container part (the Lots list's selection): reads each lot's release check with its
 * version (`GET /quality/lots/:id/release-check`), then releases the lots that may go one by one at that version with the
 * lot's code as the confirmation (`POST /quality/lots/:id/release`, Compliance's route, quality.lots.release), and says
 * each outcome. `phraseWords` is the "RELEASE 3" of the person's language. `onDone` runs once (the list reads again).
 */
export function useRelease(api: ApiClient, phraseWords: (count: number) => string, onDone: () => void) {
  const [model, setModel] = useState<ReleaseDialogModel | null>(null)
  const latest = useRef(model)
  latest.current = model

  const patchLine = (id: string, patch: Partial<ReleaseLine>) => setModel((current) => (current ? { ...current, lines: current.lines.map((line) => (line.id === id ? { ...line, ...patch } : line)) } : current))

  const open = useCallback(
    (lots: readonly LotRow[]) => {
      setModel({ lines: lots.map((lot) => ({ id: lot.id, code: lot.code, status: lot.qualityStatus, check: { state: 'loading' }, result: null })), phrase: '', note: '', busy: false, done: false })
      for (const lot of lots)
        releaseCheckOf(api, lot.id)
          .then((answer) =>
            patchLine(lot.id, {
              status: answer.lot.qualityStatus,
              check: { state: 'ready', ready: answer.checklist.ready, mode: answer.checklist.mode, version: answer.lot.version, status: answer.lot.qualityStatus, open: answer.checklist.checks.filter((check) => check.state === 'OPEN') },
            }),
          )
          .catch((error: unknown) => patchLine(lot.id, { check: { state: 'error', problem: readProblem(error) } }))
    },
    [api],
  )

  const actions: ReleaseActions = {
    onPhrase: (phrase) => setModel((current) => (current ? { ...current, phrase } : current)),
    onNote: (note) => setModel((current) => (current ? { ...current, note } : current)),
    onClose: () => setModel(null),
    onRelease: () => {
      const current = latest.current
      if (!current || current.done) return
      if (releaseHeldKey(current, expectedPhrase(current.lines, phraseWords))) return
      setModel({ ...current, busy: true })
      const going = current.lines.filter(releasable)
      void (async () => {
        for (const line of going) {
          if (line.check.state !== 'ready') continue
          try {
            await decideLot(api, line.id, 'release', { version: line.check.version, confirmCode: line.code, note: current.note.trim() || null })
            patchLine(line.id, { result: { ok: true } })
          } catch (error) {
            patchLine(line.id, { result: { ok: false, key: releaseRefusalKey(isApiError(error) ? error.kind : 'internal') } })
          }
        }
        setModel((now) => (now ? { ...now, busy: false, done: true } : now))
        onDone()
      })()
    },
  }
  return { model, open, actions }
}
