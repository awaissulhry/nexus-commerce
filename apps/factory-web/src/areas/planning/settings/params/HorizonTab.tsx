'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import { useLive } from '../../../_shared/buying/hooks'
import { editSiteSettings, getSiteSettings, type SiteSettings } from '../api'
import { readProblem, type TabHost } from '../model'
import { useEchoes } from './hooks'
import { horizonBody, horizonRefusal, type HorizonDraft, type HorizonField, type Notice, type Words } from './model'
import { HorizonView, type HorizonModel } from './view/HorizonView'

/**
 * Planning settings › Horizon & fences (SCR-127, design sec:horizon): reads the site's settings and its buckets from today
 * (`GET /planning/settings/:siteId`), saves the changed fields with the version read (`PATCH`, one Idempotency-Key per
 * attempt of the same body; the first save makes the site's row), a refusal at its field in words, a 409 as "changed by
 * someone else". Live `planning.settings_changed` of this site from someone else → Reload, the form's edits kept.
 */
export function HorizonTab({ host }: { host: TabHost }) {
  const api = useOfficeApi()
  const site = host.site
  const [load, setLoad] = useState<HorizonModel['load']>({ status: 'loading' })
  const [read, setRead] = useState<SiteSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const [refused, setRefused] = useState<Partial<Record<HorizonField, Words>>>({})
  const echoes = useEchoes()
  const attempt = useRef<{ body: string; key: string } | null>(null)
  const keyFor = (body: unknown) => {
    const text = JSON.stringify(body)
    if (attempt.current?.body !== text) attempt.current = { body: text, key: newIdempotencyKey() }
    return attempt.current.key
  }
  const onStatus = host.onStatus
  // The band says "N changes not saved" while the form differs; a save's own words are not taken back by it.
  const unsaved = useRef(false)

  const fetchSettings = useCallback(async () => {
    try {
      setRead(await getSiteSettings(api, site.id))
      setLoad({ status: 'ready' })
      setChangedElsewhere(false)
    } catch (error) {
      setLoad({ status: 'error', problem: readProblem(error) })
    }
  }, [api, site.id])
  useEffect(() => {
    void fetchSettings()
  }, [fetchSettings])

  useLive(
    (change) => {
      if (change.type !== 'planning.settings_changed' || change.fields.siteId !== site.id) return
      if (echoes.isOurs(site.id)) return
      setChangedElsewhere(true)
    },
    () => void fetchSettings(),
  )

  return (
    <HorizonView
      model={{ site, can: host.can, load, read, busy, notice, changedElsewhere, refused }}
      actions={{
        onRetry: () => {
          setLoad({ status: 'loading' })
          void fetchSettings()
        },
        onReload: () => void fetchSettings(),
        onChanged: (count) => {
          if (count > 0) {
            unsaved.current = true
            onStatus({ kind: 'unsaved', count })
          } else if (unsaved.current) {
            unsaved.current = false
            onStatus(null)
          }
        },
        onSave: (draft: HorizonDraft) => {
          if (!read || busy) return
          const body = horizonBody(read.settings, draft)
          setBusy(true)
          setNotice(null)
          setRefused({})
          unsaved.current = false
          onStatus({ kind: 'saving' })
          echoes.expect(site.id)
          editSiteSettings(api, site.id, body, keyFor(body))
            .then((answer) => {
              attempt.current = null
              setRead({ site: answer.site, settings: answer.settings, horizon: answer.horizon })
              setNotice({ tone: 'success', words: { key: 'pp.horizon.saved', params: { count: answer.changed.length } } })
              onStatus({ kind: 'saved', at: new Date().toISOString() })
            })
            .catch((error: unknown) => {
              const refusal = horizonRefusal(error)
              if (refusal.conflict) setChangedElsewhere(true)
              if (refusal.field) setRefused({ [refusal.field]: refusal.words })
              else setNotice({ tone: 'danger', words: refusal.words })
              onStatus({ kind: 'failed', count: 1 })
            })
            .finally(() => setBusy(false))
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
