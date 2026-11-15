'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale } from '../../../../../lib/i18n/provider'
import { useOfficeApi } from '../../../../../lib/session/context'
import { useLiveState } from '../../../../../shell/live/use-live'
import type { ReportFilter } from '../../api'
import { withDay, type Loaded } from '../model'
import { getMine, subscribe, unsubscribe, type ReportSubscription } from './api'
import { bodyOf, draftOfSubscription, emailMeProblem, emailMeReadProblem, newDraft, type EmailMeDraft } from './model'
import { EmailMePanel, type EmailMeModel } from './view/EmailMePanel'

/**
 * "E-mail me this", the container (B-W2b-435; DG1:01): reads my e-mail of the report (GET /reports/subscriptions?reportKey), makes
 * or changes it at the version read (PUT /reports/:key/subscription), pauses or resumes it, stops it (DELETE). A new one starts
 * from the filters the page shows now. The report's Schedule tab mounts it for every report without a module mail of its own.
 */
export function EmailMe({ reportKey, filters, shown }: { readonly reportKey: string; readonly filters: readonly ReportFilter[]; readonly shown: Readonly<Record<string, string>> }) {
  const api = useOfficeApi()
  const locale = useLocale()
  const live = useLiveState()
  const [mine, setMine] = useState<Loaded<ReportSubscription | null>>({ status: 'loading' })
  const [draft, setDraft] = useState<EmailMeDraft | null>(null)
  const [busy, setBusy] = useState<EmailMeModel['busy']>(null)
  const [notice, setNotice] = useState<EmailMeModel['notice']>(null)
  const ownLocale: 'it' | 'en' = locale === 'en' ? 'en' : 'it'

  // The page's filters seed a new draft when the tab opens (a later change of the page's filters does not reset the form).
  const seed = useRef<{ filters: readonly ReportFilter[]; shown: Readonly<Record<string, string>>; ownLocale: 'it' | 'en' }>({ filters, shown, ownLocale })
  seed.current = { filters, shown, ownLocale }
  const load = useCallback(async () => {
    const { filters: known, shown: page, ownLocale: language } = seed.current
    try {
      const row = await getMine(api, reportKey)
      setMine({ status: 'ready', data: row })
      setDraft(row ? draftOfSubscription(known, row) : newDraft(known, page, language))
    } catch (error) {
      setMine({ status: 'error', problem: emailMeReadProblem(error) })
    }
  }, [api, reportKey])
  useEffect(() => {
    void load()
  }, [load])

  const current = mine.status === 'ready' ? mine.data : null
  const write = async (kind: NonNullable<EmailMeModel['busy']>, work: () => Promise<ReportSubscription | null>, done: string) => {
    setBusy(kind)
    setNotice(null)
    try {
      const row = await work()
      setMine({ status: 'ready', data: row })
      setDraft(row ? draftOfSubscription(filters, row) : newDraft(filters, shown, ownLocale))
      setNotice({ key: done, tone: 'success' })
    } catch (error) {
      setNotice({ key: emailMeProblem(error), tone: 'danger' })
      if (emailMeProblem(error) === 'emailMe.error.stale') void load()
    } finally {
      setBusy(null)
    }
  }

  const model = useMemo<EmailMeModel>(() => ({ reportKey, filters, mine, draft, busy, offline: live === 'offline', notice }), [reportKey, filters, mine, draft, busy, live, notice])
  return (
    <EmailMePanel
      model={model}
      actions={{
        onDraft: (change) => setDraft((value) => (value ? { ...value, ...change } : value)),
        onToggleDay: (day) => setDraft((value) => (value ? { ...value, weekdays: withDay(value.weekdays, day) } : value)),
        onFilter: (key, value) => setDraft((entry) => (entry ? { ...entry, filters: { ...entry.filters, [key]: value } } : entry)),
        onSave: () => draft && void write('save', () => subscribe(api, reportKey, bodyOf(draft, current?.active ?? true, current?.version ?? 0)), current ? 'emailMe.done.saved' : 'emailMe.done.subscribed'),
        onPause: (active) => current && void write('pause', () => subscribe(api, reportKey, bodyOf(draftOfSubscription(filters, current), active, current.version)), active ? 'emailMe.done.resumed' : 'emailMe.done.paused'),
        onStop: () =>
          current &&
          void write(
            'stop',
            async () => {
              await unsubscribe(api, reportKey, current.version)
              return null
            },
            'emailMe.done.stopped',
          ),
        onRetry: () => void load(),
      }}
    />
  )
}
