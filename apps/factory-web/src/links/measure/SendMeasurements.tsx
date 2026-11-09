'use client'

import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { brandPortals, checkBranding } from '@nexus/ui/tokens/branding'
import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import type { MeasureForm, PhotoView } from '@nexus/factory-domain/sales/measure-link/rules'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'
import { isApiError } from '../../lib/api/errors'
import { useLocale } from '../../lib/i18n/provider'
import { pictureAddress } from '../../lib/proofs/address'
import { LinkBrandingContext } from '../../shell/links/view/LinkFrameView'
import { measurePhotoBytes, readDraft, readMeasurePage, readNotice, saveDraft, sendMeasurements, uploadMeasurePhoto } from './api'
import { draftDataOf, EMPTY_FORM, fieldId, firstBlocked, formFromDraft, issuesOf, nextOf, photosBusy, previousOf, refusalOf, stepProblems, worthKeeping, type MeasureViewModel, type Step } from './model'
import { MeasureView } from './view/MeasureView'

const START: MeasureViewModel = {
  link: 'valid',
  page: null,
  problem: null,
  step: 'start',
  form: EMPTY_FORM,
  issues: {},
  notice: 'idle',
  tiles: {},
  photoFor: null,
  guideFor: null,
  pointAt: null,
  typedName: '',
  draft: { status: { kind: 'idle' }, restoredAt: null, later: false },
  send: 'idle',
  done: null,
}

const SAVE_AFTER_MS = 1500

/**
 * A MEASUREMENTS link, once it opened (the link landing did `POST /link/open`): reads the page in the reader's language and
 * the draft kept with us (a draft restores the form and the photos it names, read back without location data), keeps every
 * change in the draft 1.5 s later (one save at a time; a stale save takes the newer version), records the notice's tick
 * before any field, sends each photo as soon as it is taken (kept with us, never on the device), and sends the form ONCE
 * (one Idempotency-Key per send, kept for a retry while nothing changed). The tenant's colour goes on the pop-ups too
 * (brandPortals, D24). The token stays in the client's `x-factory-link` header.
 */
export function SendMeasurements({ api }: { api: ApiClient }) {
  const locale = useLocale()
  const [model, setModel] = useState<MeasureViewModel>(START)
  const latest = useRef(model)
  latest.current = model
  const sent = useRef(false)
  const draftVersion = useRef<number | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saving = useRef(false)
  const again = useRef(false)
  const sendKey = useRef<string | null>(null)
  const shots = useRef(new Map<PhotoView, Blob>())

  const branding = useContext(LinkBrandingContext)
  useEffect(() => brandPortals(branding ? checkBranding(branding) : null), [branding])

  const patch = useCallback((change: Partial<MeasureViewModel> | ((current: MeasureViewModel) => Partial<MeasureViewModel>)) => {
    setModel((current) => ({ ...current, ...(typeof change === 'function' ? change(current) : change) }))
  }, [])

  // ---- the draft -------------------------------------------------------------------------------------------------------
  const saveNow = useCallback(async () => {
    if (sent.current) return
    if (saving.current) {
      again.current = true
      return
    }
    saving.current = true
    patch((current) => ({ draft: { ...current.draft, status: { kind: 'saving' } } }))
    try {
      const { step, form } = latest.current
      let saved
      try {
        saved = await saveDraft(api, draftDataOf(step, form), draftVersion.current)
      } catch (error) {
        // Saved meanwhile by another tab, or no longer kept: take what is there and save over it.
        if (!isApiError(error) || error.kind !== 'conflict') throw error
        const read = await readDraft(api)
        draftVersion.current = read.draft?.version ?? null
        saved = await saveDraft(api, draftDataOf(latest.current.step, latest.current.form), draftVersion.current)
      }
      draftVersion.current = saved.version
      patch((current) => ({ draft: { ...current.draft, status: { kind: 'saved', at: saved.savedAt } } }))
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') patch({ link: 'unavailable' })
      else patch((current) => ({ draft: { ...current.draft, later: false, status: { kind: 'failed' } } }))
    } finally {
      saving.current = false
      if (again.current) {
        again.current = false
        void saveNow()
      }
    }
  }, [api, patch])

  const saveSoon = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      void saveNow()
    }, SAVE_AFTER_MS)
  }, [saveNow])

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
  }, [])

  /** A change of the form: kept in the draft (only once the notice was read: no field before it). */
  const change = useCallback(
    (update: (form: MeasureForm) => MeasureForm, clear?: string) => {
      sendKey.current = null
      patch((current) => {
        const issues = { ...current.issues }
        if (clear) delete issues[clear]
        return { form: update(current.form), issues, problem: current.problem === 'problem.fix' ? null : current.problem, draft: { ...current.draft, later: false } }
      })
      if (latest.current.page?.noticeRead) saveSoon()
    },
    [patch, saveSoon],
  )

  // ---- reading -----------------------------------------------------------------------------------------------------------
  const readPhotos = useCallback(
    (photos: MeasureForm['photos']) => {
      for (const [view, fileId] of Object.entries(photos) as [PhotoView, string][]) {
        patch((current) => ({ tiles: { ...current.tiles, [view]: { state: 'loading', src: null } } }))
        measurePhotoBytes(api, fileId)
          .then((bytes) => patch((current) => ({ tiles: { ...current.tiles, [view]: { state: 'ready', src: pictureAddress(bytes, 'image/jpeg') } } })))
          .catch((error: unknown) => {
            // Gone (deleted, never arrived): it is taken again. Not reachable now: it is still with us — Try again reads it.
            if (isApiError(error) && error.kind === 'not_found')
              return patch((current) => {
                const photosLeft = { ...current.form.photos }
                delete photosLeft[view]
                const tiles = { ...current.tiles }
                delete tiles[view]
                return { form: { ...current.form, photos: photosLeft }, tiles }
              })
            patch((current) => ({ tiles: { ...current.tiles, [view]: { state: 'failed', src: null } } }))
          })
      }
    },
    [api, patch],
  )

  const load = useCallback(async () => {
    if (sent.current) return
    patch((current) => (current.page ? {} : { problem: null }))
    try {
      const [page, draft] = await Promise.all([readMeasurePage(api, locale), latest.current.page ? Promise.resolve(null) : readDraft(api).catch(() => null)])
      if (sent.current) return
      patch({ page, problem: null })
      if (draft?.draft) {
        draftVersion.current = draft.draft.version
        const restored = formFromDraft(draft.draft.data, page)
        const typed = worthKeeping(latest.current.form)
        if (restored && !typed && worthKeeping(restored.form)) {
          patch({ form: restored.form, step: restored.step, draft: { status: { kind: 'saved', at: draft.draft.savedAt }, restoredAt: draft.draft.savedAt, later: false } })
          readPhotos(restored.form.photos)
        }
      }
    } catch (error) {
      if (isApiError(error) && (error.kind === 'not_found' || error.kind === 'forbidden')) patch({ link: error.kind === 'not_found' ? 'unavailable' : 'wrong_person' })
      else patch({ problem: 'problem.read' })
    }
  }, [api, locale, patch, readPhotos])

  useEffect(() => {
    void load()
  }, [load])

  // ---- moving between steps ----------------------------------------------------------------------------------------------
  const focusFirst = (path: string | undefined) => {
    setTimeout(() => {
      const target = path ? document.getElementById(fieldId(path)) : document.getElementById('fw-ms-step-heading')
      target?.focus()
    }, 0)
  }

  const go = useCallback(
    (step: Step) => {
      patch({ step, problem: null })
      if (latest.current.page?.noticeRead) saveSoon()
      setTimeout(() => document.getElementById('fw-ms-step-heading')?.focus(), 0)
    },
    [patch, saveSoon],
  )

  const onNext = useCallback(() => {
    const { page, step, form } = latest.current
    if (!page) return
    const problems = stepProblems(step, page, form, locale)
    if (problems.length > 0) {
      patch({ issues: { ...latest.current.issues, ...issuesOf(problems) } })
      focusFirst(problems[0]!.path)
      return
    }
    const next = nextOf(step)
    if (next) go(next)
  }, [go, locale, patch])

  const onStep = useCallback(
    (target: Step) => {
      const { page, form } = latest.current
      if (!page) return
      const blocked = firstBlocked(page, form, locale, target)
      if (blocked) {
        const problems = stepProblems(blocked, page, form, locale)
        patch({ issues: { ...latest.current.issues, ...issuesOf(problems) } })
        go(blocked)
        focusFirst(problems[0]?.path)
        return
      }
      go(target)
    },
    [go, locale, patch],
  )

  // ---- the notice --------------------------------------------------------------------------------------------------------
  const onTick = useCallback(() => {
    const page = latest.current.page
    if (!page?.notice || page.noticeRead) return
    patch({ notice: 'busy' })
    readNotice(api, page.notice.id)
      .then((noticeRead) => patch((current) => ({ notice: 'idle', page: current.page ? { ...current.page, noticeRead } : current.page, issues: Object.fromEntries(Object.entries(current.issues).filter(([path]) => path !== 'notice')), problem: null })))
      .catch((error: unknown) => {
        if (isApiError(error)) {
          const refusal = refusalOf(error)
          if (refusal.gone) return patch({ link: 'unavailable', notice: 'idle' })
          if (refusal.problem === 'problem.noticeChanged' || refusal.problem === 'problem.noNotice') {
            patch({ notice: 'idle', problem: refusal.problem })
            return void load()
          }
        }
        patch({ notice: 'failed' })
      })
  }, [api, load, patch])

  // ---- photos ------------------------------------------------------------------------------------------------------------
  const upload = useCallback(
    async (view: PhotoView, blob: Blob) => {
      patch((current) => ({ tiles: { ...current.tiles, [view]: { state: 'uploading', src: current.tiles[view]?.src ?? null } } }))
      try {
        const done = await uploadMeasurePhoto(api, view, blob)
        shots.current.delete(view)
        change((form) => ({ ...form, photos: { ...form.photos, [view]: done.fileId } }), `body/photos/${view}`)
        patch((current) => ({ tiles: { ...current.tiles, [view]: { state: 'ready', src: current.tiles[view]?.src ?? null } } }))
      } catch (error) {
        const refusal = isApiError(error) ? refusalOf(error) : null
        if (refusal?.gone) return patch({ link: 'unavailable' })
        patch((current) => ({ tiles: { ...current.tiles, [view]: { state: 'failed', src: current.tiles[view]?.src ?? null } }, problem: refusal?.problem && refusal.problem !== 'problem.fix' ? refusal.problem : current.problem }))
      }
    },
    [api, change, patch],
  )

  const onPhoto = useCallback(
    async (view: PhotoView, photo: CapturedPhoto) => {
      shots.current.set(view, photo.photo)
      const src = pictureAddress(new Uint8Array(await photo.photo.arrayBuffer()), 'image/jpeg')
      patch((current) => ({ photoFor: null, tiles: { ...current.tiles, [view]: { state: 'uploading', src } } }))
      void upload(view, photo.photo)
    },
    [patch, upload],
  )

  // ---- the send ------------------------------------------------------------------------------------------------------------
  const onSend = useCallback(() => {
    const { page, form, typedName, send, tiles } = latest.current
    if (!page?.notice || send === 'busy' || photosBusy(tiles)) return
    const problems = stepProblems('review', page, form, locale)
    if (problems.length > 0) {
      const first = problems[0]!
      patch({ issues: { ...latest.current.issues, ...issuesOf(problems) }, problem: 'problem.fix' })
      go(first.path === 'notice' ? 'start' : (STEP_OF[first.path.split('/')[1] ?? ''] ?? 'review'))
      focusFirst(first.path)
      return
    }
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const key = sendKey.current ?? newIdempotencyKey()
    sendKey.current = key
    patch({ send: 'busy', problem: null })
    sendMeasurements(api, form, page.notice.id, typedName.trim() || null, key)
      .then((done) => {
        sent.current = true
        patch({ send: 'idle', done })
      })
      .catch((error: unknown) => {
        const refusal = isApiError(error) ? refusalOf(error) : { problem: 'problem.unavailable' as const, issues: {}, step: null, gone: false, keepKey: true }
        if (!refusal.keepKey) sendKey.current = null
        // A MEASUREMENTS link has one use: a send that opens nothing went through before (its answer was lost) or the link died.
        if (refusal.gone) return patch({ send: 'idle', link: 'used' })
        patch((current) => ({ send: 'idle', problem: refusal.problem, issues: { ...current.issues, ...refusal.issues } }))
        if (refusal.step) go(refusal.step)
        if (refusal.problem === 'problem.noticeChanged') void load()
      })
  }, [api, go, load, locale, patch])

  const view = model
  return (
    <MeasureView
      model={view}
      actions={{
        onRetry: () => void load(),
        onTick,
        onNext,
        onBack: () => {
          const previous = previousOf(latest.current.step)
          if (previous) go(previous)
        },
        onStep,
        onUnits: (units) => change((form) => ({ ...form, units })),
        onBasic: (field, value) => change((form) => ({ ...form, basics: { ...form.basics, [field]: value } }), `body/basics/${field}`),
        onValue: (code, value) => change((form) => ({ ...form, values: { ...form.values, [code]: value } }), `body/values/${code}`),
        onLeave: (path) => {
          const { page, form, step } = latest.current
          if (!page) return
          const problem = stepProblems(step, page, form, locale).find((entry) => entry.path === path)
          patch((current) => {
            const issues = { ...current.issues }
            if (problem && problem.code !== 'REQUIRED') issues[path] = problem.code
            else if (!problem) delete issues[path]
            return { issues }
          })
        },
        onPointFocus: (index) => patch({ pointAt: index }),
        onFit: (fit) => change((form) => ({ ...form, fit: { ...form.fit, fit } })),
        onNotes: (field, value) => change((form) => ({ ...form, fit: { ...form.fit, [field]: value } }), `body/fit/${field}`),
        onGuide: (code) => patch({ guideFor: code }),
        onPhotoOpen: (photoView) => patch({ photoFor: photoView }),
        onPhoto,
        onPhotoRetry: (photoView) => {
          const blob = shots.current.get(photoView)
          const kept = latest.current.form.photos[photoView]
          if (blob) void upload(photoView, blob)
          else if (kept) readPhotos({ [photoView]: kept })
          else patch({ photoFor: photoView })
        },
        onTypedName: (value) => {
          sendKey.current = null
          patch({ typedName: value })
        },
        onSend,
        onSaveRetry: () => void saveNow(),
        onFinishLater: () => {
          if (saveTimer.current) clearTimeout(saveTimer.current)
          patch((current) => ({ draft: { ...current.draft, later: true } }))
          void saveNow()
        },
        onDismissRestored: () => patch((current) => ({ draft: { ...current.draft, restoredAt: null } })),
        onStartAgain: () => {
          sendKey.current = null
          patch((current) => ({ form: EMPTY_FORM, tiles: {}, issues: {}, step: 'start', draft: { ...current.draft, restoredAt: null } }))
          saveSoon()
        },
      }}
    />
  )
}

const STEP_OF: Readonly<Record<string, Step>> = { basics: 'basics', values: 'points', fit: 'fit', photos: 'photos' }
