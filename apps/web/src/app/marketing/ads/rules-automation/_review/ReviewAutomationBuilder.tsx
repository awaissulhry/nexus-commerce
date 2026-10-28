'use client'

/**
 * The rules builder for a review automation — `/marketing/ads/rules-automation/builder/review-automation?ruleId=<id>`,
 * opened by Edit on Reviews › Settings › Automations (the Owner's rule: a rule is made and edited on the builder page,
 * never in a modal). The same full-screen builder as every other rule type (`h10-rb-*` shell: top bar, step list,
 * sections, footer); its sections are the review automation's own (ReviewAutomationFields).
 *
 * Reads GET /api/reviews/automation-rules/:id, saves PUT (only what changed is stored; on / off and trial run are never
 * touched; a rule changed since it was read is refused). Close, Cancel and Save come back to Reviews › Settings ›
 * Automations; with unsaved changes Close, Cancel, Esc and browser Back ask first (leaveGuard.ts), as in the other
 * builders.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { X } from 'lucide-react'
import { Banner, EmptyState, Modal } from '@/design-system/components'
import { Button, Skeleton, ToolbarButton } from '@/design-system/primitives'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { useRouter } from '@/lib/workspaces/navigation'
import { reviewsGet, reviewsSend } from '@/app/marketing/reviews/_lib/reviewsFetch'
import { reviewsSettingsHref } from '@/app/marketing/reviews/_lib/reviewsLinks'
import { guardLeaving } from '../_shared/leaveGuard'
import { inertOutside } from '../_shared/RuleBuilder'
import { ReviewAutomationFields } from './ReviewAutomationFields'
import {
  formFromView, formKey, formProblems, formToBody, switchWords,
  type ReviewAutomationForm, type ReviewAutomationRead, type ReviewAutomationSaved,
} from './reviewAutomationForm'
import s from './reviewAutomationBuilder.module.css'

const STEPS = [
  { id: 'name', label: 'Rule Name' },
  { id: 'trigger', label: 'Trigger' },
  { id: 'action', label: 'Action' },
  { id: 'limit', label: 'Limit' },
] as const

type Load = { state: 'loading' } | { state: 'failed'; words: string; missing: boolean } | { state: 'ready'; read: ReviewAutomationRead }

export function ReviewAutomationBuilder() {
  const router = useRouter()
  const ruleId = useSearchParams().get('ruleId')
  const [load, setLoad] = useState<Load>(ruleId ? { state: 'loading' } : { state: 'failed', words: 'Open a review automation from Reviews › Settings › Automations to edit it here.', missing: true })
  const [form, setForm] = useState<ReviewAutomationForm | null>(null)
  const [showProblems, setShowProblems] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmLeave, setConfirmLeave] = useState(false)
  /** A save or Discard let the person go: nothing asks any more. */
  const leftClean = useRef(false)
  const leaveByBack = useRef(false)
  const leaveAfterConfirm = useRef(false)

  const read = useCallback(async () => {
    if (!ruleId) return
    setLoad({ state: 'loading' })
    const res = await reviewsGet<ReviewAutomationRead>(`/reviews/automation-rules/${encodeURIComponent(ruleId)}`)
    if (res.error !== null) {
      setLoad({ state: 'failed', words: res.error, missing: res.status === 404 })
      return
    }
    setLoad({ state: 'ready', read: res.data })
    setForm(formFromView(res.data.view))
    setShowProblems(false)
    setSaveError(null)
  }, [ruleId])
  useEffect(() => { void read() }, [read])

  const ready = load.state === 'ready' ? load.read : null
  const baseline = useMemo(() => (ready ? formKey(formFromView(ready.view)) : null), [ready])
  const dirty = !!form && baseline != null && formKey(form) !== baseline
  const problems = useMemo(() => (form ? formProblems(form) : {}), [form])
  const hasProblems = Object.keys(problems).length > 0

  // ── leaving ──
  const releaseBackground = useRef<(() => void) | null>(null)
  const close = useCallback(() => {
    releaseBackground.current?.()
    router.push(reviewsSettingsHref('automations'))
  }, [router])
  const requestClose = useCallback(() => {
    if (dirty && !leftClean.current && !saving) setConfirmLeave(true)
    else close()
  }, [dirty, saving, close])
  const mustAsk = dirty && !leftClean.current && !saving
  useEffect(() => {
    if (!mustAsk) return
    return guardLeaving(window, () => !leftClean.current, () => { leaveByBack.current = true; setConfirmLeave(true) })
  }, [mustAsk])
  useEffect(() => {
    if (confirmLeave) return
    const back = leaveByBack.current
    leaveByBack.current = false
    if (!leaveAfterConfirm.current) return
    leaveAfterConfirm.current = false
    if (back) { releaseBackground.current?.(); window.history.back() } else close()
  }, [confirmLeave, close])

  // The builder covers the screen: the page under it is inert while it is open, and the focus starts on it.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    releaseBackground.current = inertOutside(root)
    root.focus()
    return () => { releaseBackground.current?.(); releaseBackground.current = null }
  }, [])
  const requestCloseRef = useRef(requestClose)
  requestCloseRef.current = requestClose
  const layerOpen = useRef(false)
  layerOpen.current = confirmLeave
  useEffect(() => {
    let layerAtKeydown = false
    const onKeyCapture = () => { layerAtKeydown = layerOpen.current }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || layerAtKeydown || layerOpen.current) return
      e.preventDefault()
      requestCloseRef.current()
    }
    window.addEventListener('keydown', onKeyCapture, true)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKeyCapture, true); window.removeEventListener('keydown', onKey) }
  }, [])

  // ── the step list scrolls to its section ──
  const scrollRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<string>(STEPS[0].id)
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !ready) return
    const onScroll = () => {
      const top = el.scrollTop + 80
      let cur: string = STEPS[0].id
      for (const step of STEPS) { const node = document.getElementById(`rvb-${step.id}`); if (node && node.offsetTop <= top) cur = step.id }
      setActive(cur)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  }, [ready])
  const goto = (id: string) => {
    const node = document.getElementById(`rvb-${id}`)
    const el = scrollRef.current
    if (node && el) el.scrollTo({ top: node.offsetTop - 24, behavior: 'smooth' })
  }

  // ── save ──
  const saveNoteRef = useRef<HTMLDivElement>(null)
  const save = async () => {
    if (!form || !ready || saving) return
    if (hasProblems) {
      setShowProblems(true)
      setSaveError('Fix what is marked above, then save again.')
      return
    }
    setSaving(true)
    setSaveError(null)
    const res = await reviewsSend<ReviewAutomationSaved>('PUT', `/reviews/automation-rules/${encodeURIComponent(ready.rule.id)}`, formToBody(form, ready.rule.updatedAt), { what: 'save' })
    setSaving(false)
    if (res.error) {
      setSaveError(res.error)
      return
    }
    leftClean.current = true
    emitInvalidation({ type: 'review.settings.changed' })
    close()
  }
  useEffect(() => { if (saveError) saveNoteRef.current?.scrollIntoView({ block: 'nearest' }) }, [saveError])

  const update = useCallback((patch: Partial<ReviewAutomationForm>) => {
    setForm((cur) => (cur ? { ...cur, ...patch } : cur))
    setSaveError(null)
  }, [])

  const saveHeld = saving ? 'Saving…' : !ready ? 'Nothing to save yet.' : !dirty ? 'Nothing has changed yet.' : null
  const saveButton = (
    <Button variant="primary" heldReason={saveHeld} onClick={() => void save()}>{saving ? 'Saving…' : 'Save Changes'}</Button>
  )
  const title = ready ? `Edit Rule - Review automation: ${ready.rule.name}` : 'Edit Rule - Review automation'

  return (
    // Pinned light, as every builder (rules-automation.css draws them light-only).
    <div ref={rootRef} className="h10-rb rule" data-nds-light="" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
      <header className="h10-rb-top">
        <div className="l">
          <ToolbarButton className="x" icon={<X size={19} />} label="Close" tooltip={false} onClick={requestClose} />
          <b>{title}</b>
        </div>
        <div className="r">{saveButton}</div>
      </header>

      <div className="h10-rb-body" ref={scrollRef}>
        <nav className="h10-rb-nav" aria-label="Rule steps">
          {STEPS.map((step) => (
            <Button key={step.id} variant="quiet" className={`h10-rb-step ${active === step.id ? 'on' : ''}`} aria-current={active === step.id ? 'true' : undefined} onClick={() => goto(step.id)}>{step.label}</Button>
          ))}
        </nav>

        <main className="h10-rb-main">
          <div className="h10-rb-wrap">
            {load.state === 'loading' && (
              <div className={s.loading} aria-busy="true" aria-label="Reading the automation">
                {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={56} />)}
              </div>
            )}
            {load.state === 'failed' && (
              <EmptyState
                title={load.missing ? 'No review automation to edit' : 'The automation could not be read'}
                description={load.words}
                action={load.missing
                  ? <Button onClick={close}>Back to Automations</Button>
                  : <Button onClick={() => void read()}>Try again</Button>}
              />
            )}
            {ready && form && (
              <>
                <p className={`h10-rb-desc ${s.state}`}>{switchWords(ready.rule)}</p>
                <ReviewAutomationFields read={ready} form={form} problems={showProblems ? problems : {}} onChange={update} />
                {saveError && (
                  <div className="h10-rb-savenote" ref={saveNoteRef}>
                    <Banner tone="danger" title="Not saved" onDismiss={() => setSaveError(null)}>{saveError}</Banner>
                  </div>
                )}
                <div className="h10-rb-foot">
                  <Button variant="quiet" onClick={requestClose}>Cancel</Button>
                  <span className="grow" />
                  {saveButton}
                </div>
              </>
            )}
          </div>
        </main>
      </div>

      <Modal
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        size="sm"
        title="Discard changes?"
        footer={<>
          <span className="grow" />
          <Button onClick={() => setConfirmLeave(false)} data-autofocus>Keep editing</Button>
          <Button variant="danger" onClick={() => { leftClean.current = true; leaveAfterConfirm.current = true; setConfirmLeave(false) }}>Discard</Button>
        </>}
      >
        Your changes are not saved.
      </Modal>
    </div>
  )
}
