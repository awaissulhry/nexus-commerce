'use client'

import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { brandPortals, checkBranding } from '@nexus/ui/tokens/branding'
import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'
import { isApiError } from '../../lib/api/errors'
import { useLocale } from '../../lib/i18n/provider'
import { LinkBrandingContext } from '../../shell/links/view/LinkFrameView'
import { openCaseDocument, readClaimPage, readDraft, readReturnLines, returnInstructions, saveDraft, sendClaim, uploadClaimPhoto, type ClaimPage, type ClaimSent } from './api'
import { labelCamera } from './camera'
import {
  bodyOf,
  CASE_GROUP,
  chooseType,
  draftDataOf,
  EMPTY_FORM,
  fieldId,
  firstBlocked,
  formFromDraft,
  lineIdFor,
  nextOf,
  photosInForm,
  previousOf,
  problemsIn,
  problemsOf,
  readRefusal,
  sendHeldKey,
  sendRefusal,
  stepIndex,
  STEPS,
  togglePick,
  updatePick,
  worthKeeping,
  itemOf,
  type ClaimForm,
  type ClaimViewModel,
  type PhotoShot,
  type Step,
  type UploadState,
} from './model'
import { ReportProblemView } from './view/ReportProblemView'
// B-W2b-346 (SAL-298, RX2:01): a remake takes one item; its photos go as the front and the back.
import { pickRemakeItem, remakePhotoName } from './types/remake/model'

const START: ClaimViewModel = {
  link: 'valid',
  page: null,
  problem: null,
  form: EMPTY_FORM,
  step: 'type',
  checked: [],
  issues: [],
  photos: [],
  photoFor: null,
  scanFor: null,
  draft: { status: { kind: 'idle' }, restoredAt: null, later: false },
  send: 'idle',
  done: null,
  opening: null,
}

/** How long after the last change the draft is saved with us. */
const SAVE_AFTER_MS = 1500

/** The page as the send answered it, without its `sent`. */
const pageOf = ({ sent: _sent, ...page }: ClaimPage & { sent: ClaimSent }): ClaimPage => page

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

/** Opens bytes in a new tab (a window opened at the click, so the browser lets it); a download where none opened. */
function showBytes(win: Window | null, bytes: Uint8Array, contentType: string, name: string) {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: contentType }))
  if (win && !win.closed) win.location.replace(url)
  else {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.rel = 'noopener'
    anchor.click()
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/**
 * A CLAIM link, once it opened (the link landing did `POST /link/open`): reads the page (`GET /link/claim`; reading uses
 * nothing) and the draft kept with us (`GET /link/draft`), keeps the form as it is filled in (saved with us
 * 1.5 seconds after the last change, `PUT /link/draft`; never on the device), holds the photos in the page, and sends
 * the case ONCE (`POST /link/claim` with one Idempotency-Key per press: a retry after a lost answer replays the case,
 * never a second one). After the send, each photo goes onto the case (or onto its item's line of the return), one by
 * one, with Try again for those that fail. The end is drawn from the send's answer; the link may take another report.
 * The tenant's colour goes on the page's pop-ups too (brandPortals, D24). The token stays in `x-factory-link`.
 */
export function ReportProblem({ api }: { api: ApiClient }) {
  const locale = useLocale()
  // The page speaks its own words in both languages: a language switch reads nothing again; the next call says it.
  const language = useRef(locale)
  language.current = locale
  const [model, setModel] = useState<ClaimViewModel>(START)
  const latest = useRef(model)
  latest.current = model
  const blobs = useRef(new Map<string, Blob>())
  const version = useRef<number | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveChain = useRef<Promise<void>>(Promise.resolve())
  /** The person changed something since the page opened (a late draft then never overwrites it). */
  const touched = useRef(false)
  const sendKey = useRef<{ key: string; body: string } | null>(null)
  const lines = useRef<{ caseId: string; lines: Array<{ id: string; seq: number }> } | null>(null)

  const branding = useContext(LinkBrandingContext)
  useEffect(() => brandPortals(branding ? checkBranding(branding) : null), [branding])

  // The photos' addresses are this page's: released when it goes.
  useEffect(
    () => () => {
      for (const photo of latest.current.photos) URL.revokeObjectURL(photo.src)
      if (saveTimer.current) clearTimeout(saveTimer.current)
    },
    [],
  )

  const load = useCallback(
    async (withDraft: boolean) => {
      setModel((current) => (current.page ? current : { ...current, problem: null }))
      try {
        const page = await readClaimPage(api, language.current)
        setModel((current) => ({ ...current, link: 'valid', page, problem: current.problem === 'problem.read' ? null : current.problem }))
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
        if (current.done || !current.page || current.send === 'busy') return
        if (!worthKeeping(current.form) && version.current === null) return
        setModel((now) => ({ ...now, draft: { ...now.draft, status: { kind: 'saving' } } }))
        const attempt = () => saveDraft(api, draftDataOf(latest.current.form, latest.current.step), version.current)
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
    (update: (current: ClaimViewModel) => Partial<ClaimViewModel>) => {
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

  const editForm = useCallback((edit: (form: ClaimForm, current: ClaimViewModel) => ClaimForm) => change((current) => ({ form: edit(current.form, current), issues: [] })), [change])

  // ---- moving between steps ------------------------------------------------------------------------------------------

  const goTo = useCallback(
    (step: Step) => {
      change(() => ({ step, problem: null }))
      focusSoon('fw-cl-step-heading')
    },
    [change],
  )

  const onNext = useCallback(() => {
    const current = latest.current
    if (!current.page) return
    const problems = problemsOf(current.form, current.page, photosInForm(current.form, current.photos))
    const here = problemsIn(problems, current.step)
    const checked = current.checked.includes(current.step) ? current.checked : [...current.checked, current.step]
    if (here.length > 0) {
      setModel((now) => ({ ...now, checked }))
      focusSoon(fieldId(here[0]!.field))
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
        const blocked = firstBlocked(problemsOf(current.form, current.page, photosInForm(current.form, current.photos)), STEPS[stepIndex(step) - 1]!)
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

  // ---- photos --------------------------------------------------------------------------------------------------------

  const onPhoto = useCallback(
    (captured: CapturedPhoto) => {
      const group = latest.current.photoFor
      if (!group) return
      const blob = captured.marked ?? captured.photo
      const id = globalThis.crypto.randomUUID()
      blobs.current.set(id, blob)
      const shot: PhotoShot = { id, group, src: URL.createObjectURL(blob), marks: captured.marks.length }
      change((current) => ({ photos: [...current.photos, shot], photoFor: null, issues: [] }))
    },
    [change],
  )

  const onRemovePhoto = useCallback(
    (id: string) => {
      const photo = latest.current.photos.find((entry) => entry.id === id)
      if (photo) URL.revokeObjectURL(photo.src)
      blobs.current.delete(id)
      change((current) => ({ photos: current.photos.filter((entry) => entry.id !== id) }))
    },
    [change],
  )

  /** Each photo onto the case (a return's onto its item's line when the line is known), one at a time. */
  const sendPhotos = useCallback(
    async (sent: ClaimSent, form: ClaimForm, shots: readonly PhotoShot[]) => {
      const mark = (id: string, state: UploadState) => setModel((now) => (now.done ? { ...now, done: { ...now.done, uploads: { ...now.done.uploads, [id]: state } } } : now))
      if (sent.type === 'RETURN' && shots.some((shot) => shot.group !== CASE_GROUP) && lines.current?.caseId !== sent.id) {
        lines.current = { caseId: sent.id, lines: await readReturnLines(api, sent.id).catch(() => []) }
      }
      for (const [index, shot] of shots.entries()) {
        const blob = blobs.current.get(shot.id)
        if (!blob) {
          mark(shot.id, 'failed')
          continue
        }
        mark(shot.id, 'sending')
        try {
          const lineId = sent.type === 'RETURN' ? lineIdFor(shot.group, form.picks, lines.current?.lines ?? []) : null
          const name = form.type === 'REMAKE' ? remakePhotoName(sent.number, photosInForm(form, latest.current.photos).filter((other) => other.group === shot.group).findIndex((other) => other.id === shot.id)) : `${sent.number}-${index + 1}.jpg`
          await uploadClaimPhoto(api, { caseType: sent.type, caseId: sent.id, lineId }, { blob, name }, { announce: newIdempotencyKey(), complete: newIdempotencyKey() })
          mark(shot.id, 'sent')
        } catch {
          mark(shot.id, 'failed')
        }
      }
    },
    [api],
  )

  // ---- the send ------------------------------------------------------------------------------------------------------

  const reread = useCallback(async () => {
    const page = await readClaimPage(api, language.current).catch(() => null)
    if (page) setModel((now) => ({ ...now, page }))
  }, [api])

  const onSend = useCallback(() => {
    const current = latest.current
    const page = current.page
    if (!page || current.send === 'busy' || current.done) return
    const problems = problemsOf(current.form, page, photosInForm(current.form, current.photos))
    if (problems.length > 0) {
      const first = problems[0]!
      setModel((now) => ({ ...now, checked: [...new Set([...now.checked, ...problems.map((problem) => problem.step)])], step: first.step }))
      focusSoon(fieldId(first.field))
      return
    }
    if (sendHeldKey(page)) return
    const body = bodyOf(current.form, page)
    const json = JSON.stringify(body)
    if (!sendKey.current || sendKey.current.body !== json) sendKey.current = { key: newIdempotencyKey(), body: json }
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    const form = current.form
    const shots = photosInForm(form, current.photos)
    setModel((now) => ({ ...now, send: 'busy', problem: null, issues: [] }))
    sendClaim(api, body, language.current, sendKey.current.key)
      .then((answer) => {
        sendKey.current = null
        // The send dropped the draft (B-W2b-163): the next report starts a new one.
        version.current = null
        touched.current = false
        setModel((now) => ({
          ...now,
          page: pageOf(answer),
          send: 'idle',
          problem: null,
          photoFor: null,
          scanFor: null,
          done: { sent: answer.sent, form, uploads: Object.fromEntries(shots.map((shot) => [shot.id, 'waiting' as UploadState])) },
          draft: { status: { kind: 'idle' }, restoredAt: null, later: false },
        }))
        void sendPhotos(answer.sent, form, shots)
      })
      .catch((error: unknown) => {
        const refusal = sendRefusal(error, form)
        if (!refusal.keepKey) sendKey.current = null
        const first = refusal.issues[0]
        setModel((now) => ({ ...now, send: 'idle', problem: refusal.key, issues: refusal.issues, ...(refusal.link ? { link: refusal.link } : {}), ...(first ? { step: first.step } : {}) }))
        if (first) focusSoon(fieldId(first.field))
        if (refusal.reload) void reread()
      })
  }, [api, reread, sendPhotos])

  const onRetryPhotos = useCallback(() => {
    const done = latest.current.done
    if (!done) return
    const failed = photosInForm(done.form, latest.current.photos).filter((shot) => done.uploads[shot.id] === 'failed')
    if (failed.length > 0) void sendPhotos(done.sent, done.form, failed)
  }, [sendPhotos])

  const onAnother = useCallback(() => {
    for (const photo of latest.current.photos) URL.revokeObjectURL(photo.src)
    blobs.current.clear()
    lines.current = null
    setModel((now) => ({ ...START, link: now.link, page: now.page }))
    focusSoon('fw-cl-step-heading')
  }, [])

  // ---- a case's documents (this link's earlier reports) ---------------------------------------------------------------

  const openWith = useCallback((id: string, read: () => Promise<{ bytes: Uint8Array; contentType: string; name: string }>) => {
    const win = window.open('', '_blank')
    setModel((now) => ({ ...now, opening: { id, failed: false } }))
    read()
      .then((file) => {
        showBytes(win, file.bytes, file.contentType, file.name)
        setModel((now) => ({ ...now, opening: null }))
      })
      .catch(() => {
        win?.close()
        setModel((now) => ({ ...now, opening: { id, failed: true } }))
      })
  }, [])

  return (
    <ReportProblemView
      model={model}
      actions={{
        onRetry: () => void load(false),
        onType: (type) => editForm((form) => chooseType(form, type)),
        onTogglePick: (key) =>
          editForm((form, current) => {
            const item = current.page ? itemOf(current.page, key) : null
            return item ? (form.type === 'REMAKE' ? pickRemakeItem(form, item) : togglePick(form, item)) : form
          }),
        onPick: (key, edit) => editForm((form) => updatePick(form, key, edit)),
        onComplaintItem: (key) => editForm((form) => ({ ...form, itemKey: key })),
        onField: (field, value) => editForm((form) => ({ ...form, [field]: value })),
        onOutcome: (outcomeWanted) => editForm((form) => ({ ...form, outcomeWanted })),
        onStep,
        onNext,
        onBack: () => {
          const previous = previousOf(latest.current.step)
          if (previous) goTo(previous)
        },
        onAddPhoto: (group) => setModel((now) => ({ ...now, photoFor: group })),
        onPhoto,
        onPhotoClose: () => setModel((now) => ({ ...now, photoFor: null })),
        onRemovePhoto,
        onScan: (target) => setModel((now) => ({ ...now, scanFor: target })),
        onScanned: (code) => {
          const target = latest.current.scanFor
          if (!target) return
          const serial = code.trim().slice(0, 60)
          change((current) => ({ scanFor: null, issues: [], form: target === 'serial' ? { ...current.form, serial } : updatePick(current.form, target, { serial }) }))
        },
        onScanClose: () => setModel((now) => ({ ...now, scanFor: null })),
        scanner: labelCamera,
        onFinishLater: () => void saveNow(true),
        onSaveRetry: () => void saveNow(),
        onStartAgain: () => {
          for (const photo of latest.current.photos) URL.revokeObjectURL(photo.src)
          blobs.current.clear()
          change(() => ({ form: EMPTY_FORM, step: 'type', checked: [], issues: [], photos: [], draft: { ...latest.current.draft, restoredAt: null } }))
        },
        onDismissRestored: () => setModel((now) => ({ ...now, draft: { ...now.draft, restoredAt: null } })),
        onSend,
        onRetryPhotos,
        onAnother,
        onOpenDocument: (fileId) => openWith(fileId, () => openCaseDocument(api, fileId)),
        onInstructions: (returnId, number) => openWith(returnId, () => returnInstructions(api, returnId, language.current).then((bytes) => ({ bytes, contentType: 'application/pdf', name: `${number}.pdf` }))),
      }}
    />
  )
}
