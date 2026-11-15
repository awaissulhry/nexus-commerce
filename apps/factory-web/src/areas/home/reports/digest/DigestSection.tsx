'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOfficeApi } from '../../../../lib/session/context'
import { useLiveBus } from '../../../../shell/live/use-live'
import { getDigest, getPreview, saveDigest, sendTest, switchDigestMail, type Digest, type DigestLocale, type DigestPreview } from './api'
import { draftOf, readProblem, saveBodyOf, withDay, withSection, writeProblem, type DigestDraft, type Loaded } from './model'
import { DigestPanel, type DigestPanelModel } from './view/DigestPanel'

/**
 * The owner digest, the container (B-W2b-435; ANA-032): reads my morning e-mail (GET /insights/digest) and today's preview in the
 * language shown (GET /insights/digest/preview — while editing, the draft's company and sections), saves the form at the version
 * read (PUT /insights/digest), switches a company's morning e-mail (PUT /insights/digest/switch, the owner's) and sends me a test
 * (POST /insights/digest/test). Reads again on `digest.switch_changed` and after a reconnect. Home › Reports mounts it as a
 * section (`card`), Today's ⋯ "Daily digest by e-mail" inside its dialog (`plain`).
 */
export function DigestSection({ frame = 'card' }: { readonly frame?: 'card' | 'plain' }) {
  const api = useOfficeApi()
  const [digest, setDigest] = useState<Loaded<Digest>>({ status: 'loading' })
  const [preview, setPreview] = useState<Loaded<DigestPreview>>({ status: 'loading' })
  const [previewLocale, setPreviewLocale] = useState<DigestLocale | null>(null)
  const [draft, setDraft] = useState<DigestDraft | null>(null)
  const [busy, setBusy] = useState<DigestPanelModel['busy']>(null)
  const [notice, setNotice] = useState<DigestPanelModel['notice']>(null)
  const asked = useRef(0)

  const load = useCallback(async () => {
    try {
      const value = await getDigest(api)
      setDigest({ status: 'ready', data: value })
      setPreviewLocale((current) => current ?? value.setting.locale)
    } catch (error) {
      setDigest({ status: 'error', problem: readProblem(error) })
    }
  }, [api])
  useEffect(() => {
    void load()
  }, [load])

  // The preview follows the draft's company and sections (not every keystroke of the time), and the saved digest.
  const draftRef = useRef(draft)
  draftRef.current = draft
  const scopeKey = draft ? `${draft.companyId ?? 'all'}|${draft.sections.join(',')}` : 'saved'
  const savedAt = digest.status === 'ready' ? `${digest.data.setting.version}|${digest.data.companies.map((company) => Number(company.mailOn)).join('')}` : null
  const loadPreview = useCallback(async () => {
    if (!previewLocale || savedAt === null) return
    const current = draftRef.current
    const ticket = ++asked.current
    setPreview({ status: 'loading' })
    try {
      const value = await getPreview(api, { locale: previewLocale, ...(current ? { companyId: current.companyId, ...(current.sections.length > 0 ? { sections: current.sections } : {}) } : {}) })
      if (ticket === asked.current) setPreview({ status: 'ready', data: value })
    } catch (error) {
      if (ticket === asked.current) setPreview({ status: 'error', problem: readProblem(error) })
    }
  }, [api, previewLocale, savedAt, scopeKey])
  useEffect(() => {
    void loadPreview()
  }, [loadPreview])

  const live = useLiveBus({ onChange: (change) => change.type === 'digest.switch_changed' && void load(), onReconnect: () => void load() })
  const offline = live === 'offline'

  const run = useCallback(
    async (kind: NonNullable<DigestPanelModel['busy']>, work: () => Promise<Digest | null>, done: { key: string; params?: Record<string, string | number> }) => {
      setBusy(kind)
      setNotice(null)
      try {
        const value = await work()
        if (value) setDigest({ status: 'ready', data: value })
        setNotice({ key: done.key, tone: 'success', ...(done.params ? { params: done.params } : {}) })
        return true
      } catch (error) {
        setNotice({ key: writeProblem(error), tone: 'danger' })
        if (writeProblem(error) === 'digest.error.stale') void load()
        return false
      } finally {
        setBusy(null)
      }
    },
    [load],
  )

  const model = useMemo<DigestPanelModel>(() => ({ digest, preview, previewLocale: previewLocale ?? 'it', draft, busy, offline, notice, frame }), [digest, preview, previewLocale, draft, busy, offline, notice, frame])
  const ready = digest.status === 'ready' ? digest.data : null
  return (
    <DigestPanel
      model={model}
      actions={{
        onPreviewLocale: setPreviewLocale,
        onEdit: () => ready && setDraft(draftOf(ready.setting)),
        onDraft: (change) => setDraft((current) => (current ? { ...current, ...change } : current)),
        onToggleDay: (day) => setDraft((current) => (current ? { ...current, weekdays: withDay(current.weekdays, day) } : current)),
        onToggleSection: (section) => setDraft((current) => (current ? { ...current, sections: withSection(current.sections, section) } : current)),
        onDiscard: () => setDraft(null),
        onSave: () => {
          if (!ready || !draft) return
          void run('save', () => saveDigest(api, saveBodyOf(draft, ready.setting.version)), { key: draft.enabled ? 'digest.done.savedOn' : 'digest.done.savedOff' }).then((ok) => ok && setDraft(null))
        },
        onTest: () => {
          void run(
            'test',
            async () => {
              await sendTest(api, { locale: previewLocale ?? 'it' })
              return null
            },
            { key: 'digest.done.test', params: { to: ready?.email ?? '' } },
          )
        },
        onSwitch: (companyId, on) => {
          const company = ready?.companies.find((entry) => entry.id === companyId)
          if (!company) return
          void run('switch', () => switchDigestMail(api, { companyId, on, version: company.switchVersion }), { key: on ? 'digest.done.switchOn' : 'digest.done.switchOff', params: { company: company.name } })
        },
        onRetry: () => {
          void load()
          void loadPreview()
        },
        onDismiss: () => setNotice(null),
      }}
    />
  )
}
