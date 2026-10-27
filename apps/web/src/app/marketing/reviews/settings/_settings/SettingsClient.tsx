'use client'

/**
 * Reviews › Settings (`/marketing/reviews/settings`, build spec §3.6, PR D): where reviews come from, our review e-mails
 * and the unsubscribe list, reply templates and the brand voice, alerts, the review automations and the jobs behind
 * them. Its own PageHeader (rulings 1 and 9: crumbs from the Reviews navigation, the "Reviews" button that opens the
 * sub-sidebar below 1024 px), then the DS Builder in page mode (ruling 10): a sticky section strip on top with each
 * section's problem count ("Sources 2", "Pipeline health 1"), the sections below. `?section=` scrolls to a section.
 *
 * Saving: the brand voice and the alerts are one draft, saved with the EditModeBar (N unsaved changes, ⌘S, Discard,
 * Save changes; `PUT /api/reviews/settings`). Templates, review automations, "Fix stuck jobs" and the unsubscribe list
 * save at once, each with its own call, a fresh read and a toast. Without "Manage reviews" every change is held and says
 * so; the unsubscribe list needs "Manage privacy settings".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ToastProvider, useToast } from '@/design-system/components'
import { Builder, EditModeBar, PageHeader, type BuilderSection } from '@/design-system/patterns'
import { Tag } from '@/design-system/primitives'
import { useAuth } from '@/lib/auth/AuthProvider'
import { emitInvalidation, useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { usePathname } from '@/lib/workspaces/navigation'
import { reviewsSend } from '../../_lib/reviewsFetch'
import { reviewsCrumbs } from '../../_shell/reviews-crumbs'
import { ReviewsMenuButton } from '../../_shell/ReviewsShell'
import { AlertsSection } from './AlertsSection'
import { AutomationsSection } from './AutomationsSection'
import { EmailsSection } from './EmailsSection'
import { PipelineSection } from './PipelineSection'
import {
  dirtyCount, formFromSettings, saveHeldReason, setAlertOn, setAlertRecipients, setAvoidWords, setSignOff, setTone, settingsPayload,
  toggleAlertVia, toggleLanguage, type SettingsForm, type SettingsResponse,
} from './settingsForm'
import {
  SECTIONS, sectionFlag, sectionFromSearch, type AutomationRule, type PipelineResponse, type ReplyTemplateRow, type SourcesResponse,
  type SuppressionRow,
} from './settingsModel'
import { SourcesSection } from './SourcesSection'
import { TemplatesSection } from './TemplatesSection'
import { useSettingsRead } from './useSettingsRead'
import s from './settings.module.css'

const MANAGE_HELD = "You need 'Manage reviews' to change review settings."

/** The page's own toasts: every save, removal and template change reports through them. */
export function SettingsClient() {
  return (
    <ToastProvider>
      <SettingsInner />
    </ToastProvider>
  )
}

function SettingsInner() {
  const pathname = usePathname() ?? '/marketing/reviews/settings'
  const { status, has } = useAuth()
  const { toast } = useToast()
  // Until the session is known nothing is held: the API checks every change itself.
  const canManage = status !== 'authed' || has('reviews.manage')
  const canPrivacy = status === 'authed' && has('settings.privacy.manage')
  const manageHeld = canManage ? null : MANAGE_HELD

  // ── Reads: each section on its own (a failed one shows only in its section) ──
  const settings = useSettingsRead<SettingsResponse>('/reviews/settings')
  const sources = useSettingsRead<SourcesResponse>('/reviews/settings/sources')
  const pipeline = useSettingsRead<PipelineResponse>('/reviews/settings/pipeline')
  const templates = useSettingsRead<{ items: ReplyTemplateRow[] }>('/reviews/reply-templates')
  const automations = useSettingsRead<{ items: AutomationRule[] }>('/reviews/automation-rules')
  const suppressions = useSettingsRead<{ rows: SuppressionRow[] }>('/email/suppressions', canPrivacy)
  // Another tab saved a setting, a template, an automation or the unsubscribe list: read them again; this tab's
  // unsaved edits stay (the draft is kept on a fresh read).
  useInvalidationChannel('review.settings.changed', () => {
    void settings.reload()
    void templates.reload()
    void automations.reload()
    if (canPrivacy) void suppressions.reload()
  })

  // ── The draft: brand voice + alerts ──
  const [saved, setSaved] = useState<SettingsForm | null>(null)
  const [draft, setDraft] = useState<SettingsForm | null>(null)
  useEffect(() => {
    if (!settings.data) return
    const form = formFromSettings(settings.data)
    setSaved(form)
    // A fresh read (another tab saved, templates loaded) keeps the person's unsaved edits.
    setDraft((current) => current ?? form)
  }, [settings.data])
  const edit = useCallback((change: (f: SettingsForm) => SettingsForm) => setDraft((d) => (d ? change(d) : d)), [])
  const dirty = saved && draft ? dirtyCount(saved, draft) : 0
  const [saving, setSaving] = useState(false)

  const save = useCallback(async () => {
    if (!saved || !draft) return
    const body = settingsPayload(saved, draft)
    if (!body) return
    setSaving(true)
    const res = await reviewsSend<SettingsResponse>('PUT', '/reviews/settings', body)
    setSaving(false)
    if (res.error || !res.data) {
      toast(res.error ?? 'Nexus could not save the settings. Try again in a moment.', 'danger')
      return
    }
    const form = formFromSettings(res.data)
    setSaved(form)
    setDraft(form)
    // Other tabs (an open Inbox reply box, another Settings tab) read the saved settings again (audit A8).
    emitInvalidation({ type: 'review.settings.changed' })
    void settings.reload()
    if (body.alerts) void pipeline.reload()
    toast(dirty === 1 ? 'Saved 1 change.' : `Saved ${dirty} changes.`, 'success')
  }, [saved, draft, dirty, settings, pipeline, toast])
  const discard = useCallback(() => setDraft(saved), [saved])
  const held = manageHeld ?? (draft ? saveHeldReason(draft) : null)

  // ── `?section=` scrolls to that section once the page is drawn, then leaves the address (build spec §1.3) ──
  // Only after every read has answered: the sections above grow from their loading rows to their content, so a
  // scroll made earlier ends above the section.
  const scrolled = useRef(false)
  const answered = (read: { data: unknown; error: string | null }) => read.data != null || read.error != null
  const settled = status !== 'loading'
    && [settings, sources, pipeline, templates, automations].every(answered)
    && (!canPrivacy || answered(suppressions))
  useEffect(() => {
    if (scrolled.current || !settled) return
    const section = sectionFromSearch(window.location.search)
    if (!section) return
    scrolled.current = true
    // The grids above size their rows after they are drawn: the section is kept at the top while the column grows —
    // until it has kept still for 0.8 s (5 s at most) or the person scrolls or types; then the flag leaves the address.
    const started = performance.now()
    let movedAt = started
    const events = ['wheel', 'touchstart', 'keydown'] as const
    let frame = 0
    let placedAt: number | null = null
    const finish = () => {
      cancelAnimationFrame(frame)
      for (const name of events) window.removeEventListener(name, finish)
      const params = new URLSearchParams(window.location.search)
      if (!params.has('section')) return
      params.delete('section')
      const rest = params.toString()
      window.history.replaceState({}, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`)
    }
    const place = () => {
      const target = document.querySelector<HTMLElement>(`[data-builder-section="${section}"]`)
      const top = target ? Math.round(target.getBoundingClientRect().top) : null
      const now = performance.now()
      if (target && top !== placedAt) {
        target.scrollIntoView({ block: 'start' })
        placedAt = Math.round(target.getBoundingClientRect().top)
        movedAt = now
      }
      if (now - movedAt < 800 && now - started < 5000) frame = requestAnimationFrame(place)
      else finish()
    }
    for (const name of events) window.addEventListener(name, finish, { passive: true })
    frame = requestAnimationFrame(place)
    return finish
  }, [settled])

  const counts = { sources: sources.data?.problems ?? null, pipeline: pipeline.data ? pipeline.data.troubled + pipeline.data.problems.length : null }
  const flag = (id: (typeof SECTIONS)[number]['id']) => {
    const f = sectionFlag(id, counts)
    if (!f) return undefined
    return (
      <>
        <span aria-hidden><Tag tone={id === 'pipeline' ? 'danger' : 'warning'}>{f.count}</Tag></span>
        <span className="nds-vh">{f.words}</span>
      </>
    )
  }

  const settingsError = settings.data ? null : settings.error
  const retrySettings = useCallback(() => void settings.reload(), [settings])
  const sections: BuilderSection[] = [
    {
      id: 'sources', label: 'Sources', badge: flag('sources'), title: 'Sources',
      content: <SourcesSection read={sources} canManage={canManage} />,
    },
    {
      id: 'emails', label: 'Emails & unsubscribes', title: 'Emails & unsubscribes',
      content: <EmailsSection sender={settings.data?.sender ?? null} senderError={settingsError} onRetrySender={retrySettings} suppressions={canPrivacy ? suppressions : null} />,
    },
    {
      id: 'templates', label: 'Reply templates & voice', title: 'Reply templates & brand voice',
      content: (
        <TemplatesSection
          templates={templates}
          voice={draft?.voice ?? null}
          voiceError={settingsError}
          onRetryVoice={retrySettings}
          manageHeld={manageHeld}
          onTone={(tone) => edit((f) => setTone(f, tone))}
          onLanguage={(language, on) => edit((f) => toggleLanguage(f, language, on))}
          onSignOff={(value) => edit((f) => setSignOff(f, value))}
          onAvoidWords={(words) => edit((f) => setAvoidWords(f, words))}
        />
      ),
    },
    {
      id: 'alerts', label: 'Alerts', title: 'Alerts',
      content: (
        <AlertsSection
          alerts={draft?.alerts ?? null}
          error={settingsError}
          onRetry={retrySettings}
          team={settings.data?.team ?? []}
          digestFallback={settings.data?.digestFallback ?? []}
          ratingDropRule={settings.data?.ratingDropRule ?? null}
          onOn={(key, on) => edit((f) => setAlertOn(f, key, on))}
          onRecipients={(key, ids) => edit((f) => setAlertRecipients(f, key, ids))}
          onVia={(key, via, on) => edit((f) => toggleAlertVia(f, key, via, on))}
        />
      ),
    },
    {
      id: 'automations', label: 'Automations', title: 'Automations',
      content: <AutomationsSection rules={automations} templates={settings.data?.automationTemplates ?? null} manageHeld={manageHeld} onTemplatesLoaded={retrySettings} />,
    },
    {
      id: 'pipeline', label: 'Pipeline health', badge: flag('pipeline'), title: 'Pipeline health',
      content: <PipelineSection read={pipeline} manageHeld={manageHeld} />,
    },
  ]

  const footer = dirty > 0 ? (
    <EditModeBar
      count={dirty}
      saveShortcut
      onDiscard={discard}
      onApply={() => void save()}
      applyLabel="Save changes"
      busy={saving}
      applyHeldReason={held}
    />
  ) : undefined

  const actions = useMemo(() => <ReviewsMenuButton />, [])

  return (
    <div className={s.page}>
      <PageHeader
        eyebrow={reviewsCrumbs(pathname)}
        title="Settings"
        subtitle="Where reviews come from, our e-mails, replies, alerts and the jobs behind them"
        actions={actions}
      />
      <Builder mode="page" navLabel="Settings sections" sections={sections} />
      {/* Outside the Builder: the bar is sticky to the page's bottom edge, so it stays in view in every section. */}
      {footer}
    </div>
  )
}
