'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useOnline } from '../online'
import { readTakes, saveTakes, type Takes, type TakesView } from './api'
import { takesHeld } from './model'
import { TakesCard, type TakesModel } from './view/TakesCard'

/**
 * What a chosen value of the option group takes (B-W2b-374; XF3:05), on the group's Options tab: reads GET …/takes and writes
 * PUT …/takes at the group's version; a write moves the group's version, so the record reads the group again (`onChanged`).
 */
export function GroupTakes({ api, groupId, refreshKey, onChanged }: { api: ApiClient; groupId: string; /** The group's version: a change elsewhere reads it again. */ refreshKey: string; onChanged: () => void }) {
  const online = useOnline()
  const [read, setRead] = useState<TakesModel['read']>({ status: 'loading' })
  const [view, setView] = useState<TakesView | null>(null)
  const [draft, setDraft] = useState<Takes>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<TakesModel['notice']>(null)
  const [tries, setTries] = useState(0)

  // A read again (the group's version moved) keeps a choice the person has not saved yet.
  const shown = useRef<Takes | undefined>(undefined)
  useEffect(() => {
    const controller = new AbortController()
    readTakes(api, groupId, controller.signal)
      .then((value) => {
        setView(value)
        setDraft((current) => (shown.current === undefined || current === shown.current ? value.takes : current))
        shown.current = value.takes
        setRead({ status: 'ready' })
      })
      .catch(() => !controller.signal.aborted && setRead({ status: 'error', problem: { key: 'takes.problem.load' } }))
    return () => controller.abort()
  }, [api, groupId, refreshKey, tries])

  const save = useCallback(async () => {
    if (!view || saving) return
    setSaving(true)
    setNotice(null)
    try {
      const value = await saveTakes(api, groupId, view.version, draft)
      setView(value)
      setDraft(value.takes)
      shown.current = value.takes
      setNotice({ tone: 'success', words: { key: 'takes.saved' } })
      onChanged()
    } catch (error) {
      const stale = isApiError(error) && error.kind === 'conflict' && error.code === 'version_conflict'
      setNotice({ tone: 'danger', words: { key: stale ? 'takes.problem.stale' : isApiError(error) && error.kind === 'conflict' ? 'takes.problem.refused' : 'common.unknown' } })
      if (stale) setTries((value) => value + 1)
    } finally {
      setSaving(false)
    }
  }, [api, draft, groupId, onChanged, saving, view])

  const model: TakesModel = { read, view, draft, saveHeld: takesHeld({ view, draft, online, saving }), notice, offline: !online }
  return (
    <TakesCard
      model={model}
      actions={{
        onDraft: setDraft,
        onSave: () => void save(),
        onDiscard: () => view && setDraft(view.takes),
        onRetry: () => setTries((value) => value + 1),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
