'use client'

import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { brandPortals, checkBranding } from '@nexus/ui/tokens/branding'
import { businessDate } from '@nexus/factory-domain/core/time'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'
import { isApiError } from '../../lib/api/errors'
import { useLocale } from '../../lib/i18n/provider'
import { LinkBrandingContext } from '../../shell/links/view/LinkFrameView'
import { checkVat, codeOfConduct, readDraft, readOnboardPage, saveDraft, sendOnboard, uploadDocument } from './api'
import {
  bodyOf,
  draftDataOf,
  EMPTY_FORM,
  fieldId,
  fileOfAnswer,
  firstBlocked,
  formFromDraft,
  nextOf,
  prefilled,
  previousOf,
  problemsIn,
  problemsOf,
  readRefusal,
  sendRefusal,
  stepIndex,
  STEPS,
  worthKeeping,
  DOCUMENT_MAX_BYTES,
  type OnboardViewModel,
  type Step,
} from './model'
import { OnboardView } from './view/OnboardView'

const today = () => businessDate(new Date())

const START: OnboardViewModel = {
  link: 'valid',
  page: null,
  problem: null,
  form: EMPTY_FORM,
  step: 'company',
  checked: [],
  issues: [],
  draft: { status: { kind: 'idle' }, restoredAt: null, later: false },
  vat: { status: 'idle', for: '', result: null },
  uploads: {},
  files: [],
  send: 'idle',
  done: null,
  code: 'idle',
  today: today(),
}

/** How long after the last change the draft is saved with us. */
const SAVE_AFTER_MS = 1500
const DOCUMENT_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png'])

/** Puts the focus on a field (after a check) or the step's heading (after a move), once the step is drawn. */
function focusSoon(id: string) {
  requestAnimationFrame(() => {
    const element = document.getElementById(id)
    if (!element) return
    const target = element.matches('input, textarea, select, button, [tabindex]') ? element : (element.querySelector<HTMLElement>('input, textarea, select, button') ?? element)
    target.focus()
    target.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  })
}

/**
 * A SUPPLIER_ONBOARD link, once it opened (the link landing did `POST /link/open`): reads the page (`GET
 * /link/supplier-questionnaire`; reading uses nothing) and the draft kept with us (`GET /link/draft`), starts the form from
 * the supplier as we hold it, keeps it as it is filled in (saved with us 1.5 seconds after the last change, `PUT
 * /link/draft`; never on the device), checks the VAT number in VIES, uploads each document as soon as it is chosen, opens
 * the code of conduct in a new tab, and sends the signed answer ONCE (`POST /link/supplier-questionnaire` with one
 * Idempotency-Key per press: a retry after a lost answer replays it). The end is drawn from the send's answer. The tenant's
 * colour goes on the page's pop-ups too (brandPortals, D24). The token stays in `x-factory-link`.
 */
export function Onboard({ api }: { api: ApiClient }) {
  const locale = useLocale()
  const language = useRef(locale)
  language.current = locale
  const [model, setModel] = useState<OnboardViewModel>(START)
  const latest = useRef(model)
  latest.current = model
  const version = useRef<number | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveChain = useRef<Promise<void>>(Promise.resolve())
  /** The person changed something since the page opened (a late draft then never overwrites it). */
  const touched = useRef(false)
  const sendKey = useRef<{ key: string; body: string } | null>(null)

  const branding = useContext(LinkBrandingContext)
  useEffect(() => brandPortals(branding ? checkBranding(branding) : null), [branding])
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    },
    [],
  )

  const load = useCallback(
    async (withDraft: boolean) => {
      setModel((current) => (current.page ? current : { ...current, problem: null }))
      try {
        const page = await readOnboardPage(api, language.current)
        setModel((current) => ({ ...current, link: 'valid', page, files: page.uploaded, form: current.page || touched.current ? current.form : prefilled(page), problem: current.problem === 'problem.read' ? null : current.problem }))
        if (!withDraft) return
        const read = await readDraft(api).catch(() => null)
        if (!read?.draft) return
        version.current = read.draft.version
        const restored = formFromDraft(read.draft.data, page)
        if (!restored || touched.current) return
        const savedAt = read.draft.savedAt
        setModel((current) => (current.done ? current : { ...current, form: restored.form, step: restored.step, draft: { status: { kind: 'saved', at: savedAt }, restoredAt: savedAt, later: false } }))
      } catch (error) {
        const state = readRefusal(error)
        if (state === 'error') setModel((current) => (current.page ? current : { ...current, problem: 'problem.read' }))
        else setModel((current) => ({ ...current, link: state }))
      }
    },
    [api],
  )

  useEffect(() => {
    void load(true)
  }, [load])

  // ---- the draft kept with us ----------------------------------------------------------------------------------------

  const saveNow = useCallback(
    (later = false): Promise<void> => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = null
      const run = async () => {
        const current = latest.current
        const page = current.page
        if (current.done || !page || current.send === 'busy') return
        if (!worthKeeping(current.form, page) && version.current === null) return
        setModel((now) => ({ ...now, draft: { ...now.draft, status: { kind: 'saving' } } }))
        const attempt = () => saveDraft(api, draftDataOf(latest.current.form, latest.current.step, page), version.current)
        try {
          let saved
          try {
            saved = await attempt()
          } catch (error) {
            // Another tab saved meanwhile: take its version and save this page's form over it.
            if (!isApiError(error) || error.kind !== 'conflict') throw error
            const read = await readDraft(api)
            version.current = read.draft?.version ?? null
            saved = await attempt()
          }
          version.current = saved.version
          const at = saved.savedAt
          setModel((now) => (now.done ? now : { ...now, draft: { ...now.draft, status: { kind: 'saved', at }, later: later || now.draft.later } }))
        } catch (error) {
          if (isApiError(error) && error.kind === 'not_found') setModel((now) => ({ ...now, link: 'unavailable' }))
          else setModel((now) => ({ ...now, draft: { ...now.draft, status: { kind: 'failed', count: 1 }, later: false } }))
        }
      }
      saveChain.current = saveChain.current.then(run, run)
      return saveChain.current
    },
    [api],
  )

  /** A change by the person: the form or step moves, and the draft is saved a moment later. */
  const change = useCallback(
    (update: (current: OnboardViewModel) => Partial<OnboardViewModel>) => {
      touched.current = true
      setModel((current) => {
        const updated = update(current)
        return { ...current, ...updated, draft: { ...(updated.draft ?? current.draft), status: { kind: 'unsaved' }, later: false } }
      })
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => void saveNow(), SAVE_AFTER_MS)
    },
    [saveNow],
  )

  // ---- moving between steps ------------------------------------------------------------------------------------------

  const goTo = useCallback(
    (step: Step) => {
      change(() => ({ step, problem: null }))
      focusSoon('fw-ob-step-heading')
    },
    [change],
  )

  const onNext = useCallback(() => {
    const current = latest.current
    if (!current.page) return
    const here = problemsIn(problemsOf(current.form, current.page, current.today), current.step)
    const checked = current.checked.includes(current.step) ? current.checked : [...current.checked, current.step]
    if (here.length > 0) {
      setModel((now) => ({ ...now, checked }))
      focusSoon(fieldId(here[0]!.path))
      return
    }
    const next = nextOf(current.step)
    if (!next) return
    setModel((now) => ({ ...now, checked }))
    goTo(next)
  }, [goTo])

  const onStep = useCallback(
    (step: Step) => {
      const current = latest.current
      if (!current.page) return
      // Back to any step; forward only past steps with nothing to fix.
      if (stepIndex(step) > stepIndex(current.step)) {
        const blocked = firstBlocked(problemsOf(current.form, current.page, current.today), STEPS[stepIndex(step) - 1]!)
        if (blocked) {
          setModel((now) => ({ ...now, checked: [...new Set([...now.checked, blocked])] }))
          if (blocked !== current.step) goTo(blocked)
          return
        }
      }
      goTo(step)
    },
    [goTo],
  )

  // ---- the VAT number, the documents, the code of conduct --------------------------------------------------------------

  const onVat = useCallback(() => {
    const current = latest.current
    const page = current.page
    if (!page) return
    const question = page.questionnaire.questions.find((entry) => entry.kind === 'VAT')
    const legal = page.questionnaire.questions.find((entry) => entry.section === 'company' && entry.kind === 'TEXT')
    const value = question ? String(current.form.answers[question.key]?.value ?? '').trim() : ''
    if (!value || current.vat.status === 'checking') return
    const typed = value.replace(/[\s./-]/g, '').toUpperCase()
    if (current.vat.status === 'done' && current.vat.for === typed) return
    setModel((now) => ({ ...now, vat: { status: 'checking', for: typed, result: null } }))
    checkVat(api, value, legal ? String(current.form.answers[legal.key]?.value ?? '') : '')
      .then((result) => setModel((now) => (now.vat.for === typed ? { ...now, vat: { status: 'done', for: typed, result } } : now)))
      .catch(() => setModel((now) => (now.vat.for === typed ? { ...now, vat: { status: 'failed', for: typed, result: null } } : now)))
  }, [api])

  const onUpload = useCallback(
    (key: string, file: File) => {
      const name = file.name
      if (!DOCUMENT_TYPES.has(file.type)) {
        setModel((now) => ({ ...now, uploads: { ...now.uploads, [key]: { kind: 'failed', name, key: 'upload.type' } } }))
        return
      }
      if (file.size > DOCUMENT_MAX_BYTES) {
        setModel((now) => ({ ...now, uploads: { ...now.uploads, [key]: { kind: 'failed', name, key: 'upload.size' } } }))
        return
      }
      setModel((now) => ({ ...now, uploads: { ...now.uploads, [key]: { kind: 'uploading', name } } }))
      uploadDocument(api, key, file)
        .then((uploaded) => {
          change((current) => {
            const uploads = { ...current.uploads }
            delete uploads[key]
            return { uploads, files: [...current.files.filter((entry) => entry.id !== uploaded.id), uploaded], issues: current.issues.filter((issue) => !issue.path.startsWith(`answers/${key}`)), form: { ...current.form, answers: { ...current.form.answers, [key]: { value: { fileId: uploaded.id, issuer: null, number: null, issuedOn: null, expiresOn: null } } } } }
          })
        })
        .catch((error: unknown) => {
          const why = isApiError(error) && error.kind === 'unavailable' ? 'upload.closed' : 'upload.failed'
          setModel((now) => ({ ...now, uploads: { ...now.uploads, [key]: { kind: 'failed', name, key: why } } }))
        })
    },
    [api, change],
  )

  const onCode = useCallback(() => {
    // A window opened at the click (the browser lets it), filled when the bytes arrive; a download where none opened.
    const win = window.open('', '_blank')
    setModel((now) => ({ ...now, code: 'opening' }))
    codeOfConduct(api, language.current)
      .then((bytes) => {
        const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' }))
        if (win && !win.closed) win.location.replace(url)
        else {
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = 'code-of-conduct.pdf'
          anchor.rel = 'noopener'
          anchor.click()
        }
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
        setModel((now) => ({ ...now, code: 'idle' }))
      })
      .catch(() => {
        win?.close()
        setModel((now) => ({ ...now, code: 'failed' }))
      })
  }, [api])

  // ---- the send ------------------------------------------------------------------------------------------------------

  const onSign = useCallback(
    (name: string, truthful: boolean) => {
      const current = latest.current
      const page = current.page
      if (!page || current.send === 'busy' || current.done) return
      const form = { ...current.form, signedName: name, truthful }
      const problems = problemsOf(form, page, current.today)
      if (problems.length > 0) {
        const first = problems[0]!
        setModel((now) => ({ ...now, form, checked: [...new Set([...now.checked, ...problems.map((problem) => problem.step)])], step: first.step }))
        focusSoon(fieldId(first.path))
        return
      }
      const body = bodyOf(form, page)
      const json = JSON.stringify(body)
      if (!sendKey.current || sendKey.current.body !== json) sendKey.current = { key: newIdempotencyKey(), body: json }
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = null
      setModel((now) => ({ ...now, form, send: 'busy', problem: null, issues: [] }))
      sendOnboard(api, body, language.current, sendKey.current.key)
        .then((answer) => {
          sendKey.current = null
          version.current = null
          setModel((now) => ({ ...now, send: 'idle', problem: null, done: answer, draft: { status: { kind: 'idle' }, restoredAt: null, later: false } }))
        })
        .catch((error: unknown) => {
          const refusal = sendRefusal(error, page)
          if (!refusal.keepKey) sendKey.current = null
          const first = refusal.issues[0]
          setModel((now) => ({ ...now, send: 'idle', problem: refusal.key, issues: refusal.issues, ...(refusal.link ? { link: refusal.link } : {}), ...(first ? { step: first.step } : {}) }))
          if (first) focusSoon(fieldId(first.path))
          if (refusal.reload) void load(false)
        })
    },
    [api, load],
  )

  return (
    <OnboardView
      model={model}
      actions={{
        onRetry: () => void load(false),
        onStep,
        onNext,
        onBack: () => {
          const previous = previousOf(latest.current.step)
          if (previous) goTo(previous)
        },
        onAnswer: (key, value) =>
          change((current) => ({ form: { ...current.form, answers: { ...current.form.answers, [key]: value } }, issues: current.issues.filter((issue) => !issue.path.startsWith(`answers/${key}`)), vat: current.page?.questionnaire.questions.find((entry) => entry.key === key)?.kind === 'VAT' ? { status: 'idle', for: '', result: null } : current.vat })),
        onSites: (field, rows) => change((current) => ({ form: { ...current.form, [field]: rows }, issues: current.issues.filter((issue) => !issue.path.startsWith(field)) })),
        onVat,
        onUpload,
        onRemoveFile: (key) => {
          if (!fileOfAnswer(latest.current.form, key)) return
          change((current) => {
            const answers = { ...current.form.answers }
            delete answers[key]
            return { form: { ...current.form, answers } }
          })
        },
        onCode,
        onSigner: (field, value) => change((current) => ({ form: { ...current.form, [field]: value }, issues: current.issues.filter((issue) => issue.path !== field) })),
        onSign,
        onFinishLater: () => void saveNow(true),
        onSaveRetry: () => void saveNow(),
        onStartAgain: () => change((current) => ({ form: current.page ? prefilled(current.page) : EMPTY_FORM, step: 'company', checked: [], issues: [], draft: { ...latest.current.draft, restoredAt: null } })),
        onDismissRestored: () => setModel((now) => ({ ...now, draft: { ...now.draft, restoredAt: null } })),
      }}
    />
  )
}
