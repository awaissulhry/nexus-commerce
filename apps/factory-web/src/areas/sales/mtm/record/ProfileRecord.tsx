'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { businessDayStart } from '@nexus/factory-domain/core/time'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { storeUrl } from '../../../../record-panels/store'
import { liveMatches, useLive, useRecordTab } from '../../../quality/_shared/hooks'
import {
  bookFitting,
  cancelAppointment,
  checkMeasures,
  closeAppointment,
  createQuote,
  getAppointment,
  getProfile,
  getStyle,
  inviteAgain,
  listMtmStyles,
  listPeople,
  moveAppointment,
  nameResultRevision,
  openAlteration,
  openPhoto,
  readFittings,
  readQuoteProofs,
  readRepeat,
  readSent,
  recordResult,
  repeatOrder,
  reviewProfile,
  setPhotosDeleteAfter,
  type FittingResult,
  type ProfileRecord as Record,
} from '../api'
import {
  alteredNotice,
  bookBodyOf,
  bookDraftFor,
  bookWarnings,
  doOf,
  formPoints,
  mtmCan,
  proofLines,
  quoteHref,
  readProblem,
  RECORD_TABS,
  resultBodyOf,
  resultDraftFor,
  resultProblem,
  reviewBodyOf,
  reviewDraftFor,
  reviewedNotice,
  todayOf,
  unitQuotes,
  writeProblem,
  type Notice,
} from '../model'
import { MtmMessages } from '../parts'
import { useLinkDialog, useQuoteDialog } from '../use-dialogs'
import { useMeasurementsDialog } from '../use-measurements'
import type { Read } from '../view-model'
import type { Loaded, ProfileRecordModel, RangeModel, RecordDialog } from './view-model'
import { ProfileRecordView } from './view/ProfileRecordView'
// B-W2b-371: the office's and the fittings' photos (XF2:01), the rider's thread (XF2:02).
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { useOfficePhotos } from '../photos/use-photos'

/**
 * `/w/<company>/sales/made-to-measure/<profileId>` (SCR-036-record; `?tab=`, `&do=revision|review|fitting|link|quote|repeat|compare`
 * from a row verb): the record of any revision read once and again on its live changes (a measurement_profile.*, appointment.*,
 * fitting_result.* or measurements.submitted event of the rider's chain; while a dialog holds work, a banner says it changed
 * instead); the Fittings tab with the record (it says whether made-to-measure has started); the photos, the proofs and the
 * certified range check when their tab or part is on screen. Every write is ONE call with its own Idempotency-Key and the version
 * read where the API asks one; a refusal is said in our words; a stale version reads the record again.
 */
export function ProfileRecord({ profileId }: { profileId: string }) {
  return (
    <MtmMessages>
      <Container profileId={profileId} />
    </MtmMessages>
  )
}

function Container({ profileId }: { profileId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const params = useSearchParams()
  const locale = useLocale()
  const language = locale === 'en' ? 'en' : 'it'
  const prefix = companyPrefix(session.company?.code ?? '')
  const companyId = session.company?.id ?? null
  const me = useMemo(() => ({ id: session.user.id, name: session.user.displayName }), [session.user.id, session.user.displayName])
  const can = useMemo(() => mtmCan(session.permissions), [session.permissions])
  const tab = useRecordTab(RECORD_TABS)
  const todo = doOf(params?.get('do'))
  const [today] = useState(() => todayOf())

  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [stale, setStale] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [revisionId, setRevisionId] = useState<string | null>(null)
  const [fittings, setFittings] = useState<ProfileRecordModel['fittings']>({ items: null, problem: null })
  const [sent, setSent] = useState<ProfileRecordModel['sent']>({ items: null, problem: null })
  const [proofs, setProofs] = useState<ProfileRecordModel['proofs']>({ items: null, problem: null })
  const [range, setRange] = useState<RangeModel>({ styles: { items: null, problem: null }, styleId: '', style: null, colourwayId: '', check: null, checking: false, problem: null })
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const [lastResult, setLastResult] = useState<FittingResult | null>(null)
  const record = loaded.status === 'ready' ? loaded.record : null
  const current = useRef<Record | null>(null)
  current.current = record
  const dialogRef = useRef<RecordDialog | null>(null)
  dialogRef.current = dialog
  const keys = useRef<{ [name: string]: string }>({})
  const keyOf = (name: string) => (keys.current[name] ??= newIdempotencyKey())
  const dropKey = (name: string) => void delete keys.current[name]

  const load = useCallback(async () => {
    try {
      const next = await getProfile(api, profileId)
      setLoaded({ status: 'ready', record: next })
      setAsOf(new Date().toISOString())
      setStale(null)
    } catch (error) {
      setLoaded(isApiError(error) && error.kind === 'not_found' ? { status: 'notFound' } : isApiError(error) && error.kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) })
    }
  }, [api, profileId])

  const loadFittings = useCallback(async () => {
    try {
      setFittings({ items: await readFittings(api, profileId, undefined, /* B-W2b-F38 */ companyId), problem: null })
    } catch (error) {
      setFittings({ items: null, problem: readProblem(error) })
    }
  }, [api, profileId, /* B-W2b-F38 */ companyId])

  useEffect(() => {
    if (!can.view) return
    setLoaded({ status: 'loading' })
    void load()
    void loadFittings()
  }, [can.view, load, loadFittings])

  // The photos when their tab is on screen.
  const chainKey = record ? record.revisions.map((revision) => revision.id).join(',') : ''
  useEffect(() => {
    if (tab !== 'photos' || !record) return
    const controller = new AbortController()
    readSent(api, record.latestId, controller.signal)
      .then((items) => setSent({ items, problem: null }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setSent({ items: null, problem: readProblem(error) })
      })
    return () => controller.abort()
  }, [api, tab, chainKey])

  // The proofs of the rider's quotes when their tab is on screen.
  const unitsKey = record ? record.units.map((unit) => unit.lineId).join(',') : ''
  useEffect(() => {
    if (tab !== 'proofs' || !record || !can.quotesView) return
    const quotes = unitQuotes(record.units)
    if (quotes.length === 0) {
      setProofs({ items: [], problem: null })
      return
    }
    const controller = new AbortController()
    setProofs({ items: null, problem: null })
    Promise.all(quotes.map(async (quote) => ({ number: quote.number, proofs: await readQuoteProofs(api, quote.id, controller.signal) })))
      .then((answers) => setProofs({ items: proofLines(answers), problem: null }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setProofs({ items: null, problem: readProblem(error) })
      })
    return () => controller.abort()
  }, [api, tab, unitsKey, can.quotesView])

  // The certified range check: the MTM styles once, the style picked (default the newest unit's), its colourway, the check.
  const hasRecord = record !== null
  useEffect(() => {
    if (!hasRecord || !can.styles || tab !== 'measurements') return
    if (range.styles.items !== null) return
    listMtmStyles(api, companyId)
      .then((items) => {
        const unitStyle = current.current?.units[0]?.style.id
        const preferred = items.find((style) => style.id === unitStyle)?.id ?? ''
        setRange((now) => ({ ...now, styles: { items, problem: null }, styleId: now.styleId || preferred }))
      })
      .catch((error: unknown) => setRange((now) => ({ ...now, styles: { items: [], problem: readProblem(error) } })))
  }, [api, hasRecord, can.styles, tab, companyId, range.styles.items])

  useEffect(() => {
    if (!range.styleId) return
    const controller = new AbortController()
    setRange((now) => ({ ...now, style: null, check: null, problem: null }))
    getStyle(api, range.styleId, controller.signal)
      .then((style) => {
        const unitColour = current.current?.units.find((unit) => unit.style.id === style.id)?.colourway.id
        const first = style.colourways.find((colourway) => colourway.id === unitColour && colourway.status === 'ACTIVE') ?? style.colourways.find((colourway) => colourway.status === 'ACTIVE')
        setRange((now) => (now.styleId === style.id ? { ...now, style, colourwayId: first?.id ?? '' } : now))
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setRange((now) => ({ ...now, problem: readProblem(error) }))
      })
    return () => controller.abort()
  }, [api, range.styleId])

  const latestId = record?.latestId ?? ''
  useEffect(() => {
    if (!range.styleId || !range.colourwayId || !latestId) return
    const controller = new AbortController()
    setRange((now) => ({ ...now, checking: true, problem: null }))
    checkMeasures(api, { styleId: range.styleId, colourwayId: range.colourwayId, measurementProfileId: latestId }, controller.signal)
      .then((check) => setRange((now) => ({ ...now, checking: false, check })))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setRange((now) => ({ ...now, checking: false, check: null, problem: readProblem(error) }))
      })
    return () => controller.abort()
  }, [api, range.styleId, range.colourwayId, latestId])

  // ---- live ----------------------------------------------------------------------------------------------------------------
  const live = useLive(
    (change) => {
      const now = current.current
      if (!now || !liveMatches(change, ['measurement_profile.', 'measurements.submitted', 'appointment.', 'fitting_result.', 'mtm_worksheet.'])) return
      const ids = new Set(now.revisions.map((revision) => revision.id))
      const fields = change.fields as { profileId?: unknown; partyId?: unknown }
      const ours = (typeof fields.profileId === 'string' && ids.has(fields.profileId)) || fields.partyId === now.partyId
      if (!ours) return
      if (change.type === 'measurements.submitted') setNotice({ key: 'live.linkAnsweredHere', tone: 'info' })
      if (dialogRef.current) setStale(formatTime(new Date().toISOString(), { locale }))
      else {
        void load()
        void loadFittings()
      }
    },
    () => {
      void load()
      void loadFittings()
    },
  )
  const offline = live === 'offline'

  // B-W2b-371: the office's and the fittings' photos when the Photos or the Fittings tab is on screen.
  const photos = useOfficePhotos({ api, profileId: record?.latestId ?? null, partyId: record?.partyId ?? null, shown: !!record && (tab === 'photos' || tab === 'fittings'), can, offline, today })
  const firstId = record?.revisions.at(-1)?.id ?? null
  const thread =
    record && firstId && tab === 'activity' && session.permissions.includes('threads.read') ? (
      <RecordPanels record={{ type: 'MeasurementProfile', id: firstId, companyId: null, siteId: null }} title={`${record.riderName} · ${record.garmentType}`} party={{ id: record.partyId, name: record.customer.name, emails: [] }} />
    ) : null

  // ---- the shared dialogs (New revision, Send a measurement link, Use in a new quote) -----------------------------------------
  const measurements = useMeasurementsDialog({
    api,
    can,
    me,
    companyId,
    offline,
    onSaved: (answer) => {
      setNotice({ key: 'revision.saved', params: { revision: answer.profile.revision }, tone: 'success' })
      // The address keeps the revision it was opened with: any revision of the chain reads the whole record (the newest first).
      setRevisionId(null)
      void load()
    },
  })
  const link = useLinkDialog({ api, can, companyId, language, offline, pointsOf: () => (current.current?.template ? formPoints(current.current.template.points).length : null) })
  const quote = useQuoteDialog({ api, can, companyId, prefix, offline, onCreated: (made) => router.push(quoteHref(prefix, made.id)) })

  const openRevision = useCallback(() => {
    const now = current.current
    if (!now) return
    const from = now.revisions.find((revision) => revision.id === revisionId) ?? now.revisions[0]
    if (from) measurements.openRevision(now, from)
  }, [measurements, revisionId])
  const openLink = useCallback(() => {
    const now = current.current
    if (now) link.openFor({ profileId: now.latestId, riderName: now.riderName, garmentType: now.garmentType, contactId: now.contactId, pointCount: now.template ? formPoints(now.template.points).length : null })
  }, [link])
  const openQuote = useCallback(() => {
    const now = current.current
    if (now) quote.open({ profileId: now.latestId, riderName: now.riderName, customer: now.customer.name, partyId: now.partyId, contactId: now.contactId, revision: now.revisions[0]?.revision ?? 0 })
  }, [quote])

  // ---- the record's own dialogs ----------------------------------------------------------------------------------------------
  const patchDialog = useCallback((patch: Partial<RecordDialog>) => setDialog((now) => (now ? ({ ...now, ...patch } as RecordDialog) : now)), [])

  const openReview = useCallback(
    (decision: 'CONFIRM' | 'NEED_MORE') => {
      const now = current.current
      if (!now) return
      dropKey('review')
      setDialog({ kind: 'review', draft: reviewDraftFor(decision, now.review.mailTo), check: null, checking: !!now.template?.rulesOn, busy: false, notice: null })
      if (now.template?.rulesOn && can.styles)
        checkMeasures(api, { templateId: now.template.id, measurementProfileId: now.latestId })
          .then((check) => setDialog((open) => (open?.kind === 'review' ? { ...open, check, checking: false } : open)))
          .catch(() => setDialog((open) => (open?.kind === 'review' ? { ...open, checking: false } : open)))
    },
    [api, can.styles],
  )

  const openFitting = useCallback(() => {
    dropKey('book')
    setDialog({ kind: 'fitting', draft: bookDraftFor(new Date()), people: null, busy: false, notice: null })
    if (can.people)
      listPeople(api)
        .then((people) => setDialog((open) => (open?.kind === 'fitting' ? { ...open, people } : open)))
        .catch(() => undefined)
  }, [api, can.people])

  const openAppointment = useCallback(
    (id: string) => {
      ;['move', 'close', 'cancel', 'invite'].forEach(dropKey)
      setDialog({ kind: 'appointment', id, appointment: null, problem: null, mode: 'view', move: { startsAt: '', minutes: 60, place: '', invite: true }, close: { status: 'DONE', notes: '' }, reason: '', busy: false, notice: null })
      getAppointment(api, id)
        .then((appointment) =>
          setDialog((open) => (open?.kind === 'appointment' && open.id === id ? { ...open, appointment, move: { startsAt: appointment.startsAt, minutes: Math.max(15, Math.round((new Date(appointment.endsAt).getTime() - new Date(appointment.startsAt).getTime()) / 60_000)), place: appointment.place, invite: true } } : open)),
        )
        .catch((error: unknown) => setDialog((open) => (open?.kind === 'appointment' ? { ...open, problem: readProblem(error) } : open)))
    },
    [api],
  )

  const openOutcome = useCallback((appointmentId?: string) => {
    dropKey('result')
    const now = current.current
    const unit = now?.units.find((entry) => entry.kind === 'ORDER')
    setDialog({ kind: 'outcome', draft: resultDraftFor(appointmentId ?? '', unit?.lineId ?? ''), busy: false, notice: null })
  }, [])

  const openRepeat = useCallback(() => {
    ;['repeatQuote', 'repeat'].forEach(dropKey)
    setDialog({ kind: 'repeat', facts: null, problem: null, fromLineId: '', measuredOk: false, busy: false, notice: null })
    readRepeat(api, profileId)
      .then((facts) => setDialog((open) => (open?.kind === 'repeat' ? { ...open, facts, fromLineId: facts.earlier[0]?.lineId ?? '' } : open)))
      .catch((error: unknown) => setDialog((open) => (open?.kind === 'repeat' ? { ...open, problem: readProblem(error) } : open)))
  }, [api, profileId])

  // `&do=` opens a row verb's dialog once the record is read.
  const doneTodo = useRef<string | null>(null)
  useEffect(() => {
    if (!record || !todo || doneTodo.current === todo) return
    doneTodo.current = todo
    if (todo === 'revision' && record.may.record) openRevision()
    else if (todo === 'review') openReview('CONFIRM')
    else if (todo === 'fitting' && can.fittings) openFitting()
    else if (todo === 'link' && can.link) openLink()
    else if (todo === 'quote' && can.quotes) openQuote()
    else if (todo === 'repeat' && can.quotes) openRepeat()
    else if (todo === 'compare' && record.revisions.length > 1) setDialog({ kind: 'compare', beforeId: record.revisions[1]!.id, afterId: record.revisions[0]!.id })
  }, [record, todo])

  // ---- writes -----------------------------------------------------------------------------------------------------------------
  const review = useCallback(async () => {
    const now = current.current
    const open = dialogRef.current
    if (!now || open?.kind !== 'review' || open.busy) return
    patchDialog({ busy: true, notice: null })
    try {
      const answer = await reviewProfile(api, now.latestId, reviewBodyOf(open.draft, now, companyId, language), keyOf('review'))
      dropKey('review')
      setDialog(null)
      setNotice(reviewedNotice(open.draft.decision, answer, open.draft.notify))
      void load()
    } catch (error) {
      patchDialog({ busy: false, notice: { ...(isApiError(error) && error.kind === 'conflict' ? { key: 'review.problem.conflict' } : writeProblem(error)), tone: 'danger' } })
      if (isApiError(error) && error.kind === 'conflict') void load()
    }
  }, [api, companyId, language, load, patchDialog])

  const book = useCallback(async () => {
    const now = current.current
    const open = dialogRef.current
    if (!now || !companyId || open?.kind !== 'fitting' || open.busy) return
    patchDialog({ busy: true, notice: null })
    try {
      const answer = await bookFitting(api, bookBodyOf(open.draft, now, companyId, me.id, language), keyOf('book'))
      dropKey('book')
      setDialog(null)
      const warnings = bookWarnings(answer.warnings)
      setNotice({ key: answer.mailed ? 'book.done.invited' : 'book.done.booked', tone: warnings.length > 0 ? 'warning' : 'success', lines: warnings })
      void loadFittings()
      void load()
    } catch (error) {
      patchDialog({ busy: false, notice: { ...(isApiError(error) && error.kind === 'conflict' ? { key: 'book.problem.conflict' } : writeProblem(error)), tone: 'danger' } })
    }
  }, [api, companyId, me.id, language, load, loadFittings, patchDialog])

  const appointmentWrite = useCallback(
    async (kind: 'move' | 'close' | 'cancel' | 'invite') => {
      const open = dialogRef.current
      if (open?.kind !== 'appointment' || !open.appointment || open.busy) return
      const appointment = open.appointment
      patchDialog({ busy: true, notice: null })
      try {
        if (kind === 'move') {
          const starts = new Date(open.move.startsAt)
          await moveAppointment(api, appointment.id, { version: appointment.version, startsAt: starts.toISOString(), endsAt: new Date(starts.getTime() + open.move.minutes * 60_000).toISOString(), place: open.move.place.trim(), invite: open.move.invite, language }, keyOf('move'))
        } else if (kind === 'close') await closeAppointment(api, appointment.id, { version: appointment.version, status: open.close.status, ...(open.close.notes.trim() ? { notes: open.close.notes.trim() } : {}) }, keyOf('close'))
        else if (kind === 'cancel') await cancelAppointment(api, appointment.id, { version: appointment.version, reason: open.reason.trim(), notify: true, language }, keyOf('cancel'))
        else await inviteAgain(api, appointment.id, { version: appointment.version, language }, keyOf('invite'))
        dropKey(kind)
        setDialog(null)
        setNotice({ key: `appt.done.${kind}`, tone: 'success' })
        void loadFittings()
        void load()
      } catch (error) {
        patchDialog({ busy: false, notice: { ...(isApiError(error) && error.kind === 'conflict' ? { key: 'appt.problem.conflict' } : writeProblem(error)), tone: 'danger' } })
        if (isApiError(error) && error.kind === 'conflict') {
          dropKey(kind)
          getAppointment(api, appointment.id)
            .then((fresh) => setDialog((now) => (now?.kind === 'appointment' && now.id === fresh.id ? { ...now, appointment: fresh } : now)))
            .catch(() => undefined)
        }
      }
    },
    [api, language, load, loadFittings, patchDialog],
  )

  const recordOutcome = useCallback(async () => {
    const now = current.current
    const open = dialogRef.current
    if (!now || open?.kind !== 'outcome' || open.busy) return
    patchDialog({ busy: true, notice: null })
    const points = formPoints(now.template?.points)
    try {
      const answer = await recordResult(api, resultBodyOf(open.draft, now, points), keyOf('result'))
      dropKey('result')
      setDialog(null)
      setLastResult(answer.result)
      setNotice({ key: answer.appointmentClosed ? 'result.recordedClosed' : 'result.recorded', params: { verdict: `verdict.${answer.result.verdict}` }, tone: 'success' })
      void loadFittings()
    } catch (error) {
      patchDialog({ busy: false, notice: { ...resultProblem(error, points), tone: 'danger' } })
    }
  }, [api, loadFittings, patchDialog])

  const alteration = useCallback(
    async (result: FittingResult) => {
      try {
        const answer = await openAlteration(api, result.id, { version: result.version, movePromise: true }, keyOf(`alter-${result.id}`))
        dropKey(`alter-${result.id}`)
        setLastResult(answer.result)
        setNotice(alteredNotice(answer))
        void loadFittings()
      } catch (error) {
        setNotice({ ...(isApiError(error) && error.kind === 'forbidden' ? { key: 'result.problem.repairRight' } : writeProblem(error)), tone: 'danger' })
        if (isApiError(error) && error.kind === 'conflict') void loadFittings()
      }
    },
    [api, loadFittings],
  )

  const nameRevision = useCallback(
    async (result: FittingResult) => {
      const now = current.current
      const newest = now?.revisions[0]
      if (!now || !newest || newest.id === result.profile.id || newest.revision <= result.profile.revision) {
        openRevision()
        return
      }
      try {
        const named = await nameResultRevision(api, result.id, { version: result.version, profileId: newest.id }, keyOf(`name-${result.id}`))
        dropKey(`name-${result.id}`)
        setLastResult(named)
        setNotice({ key: 'result.named', params: { revision: newest.revision }, tone: 'success' })
        void loadFittings()
      } catch (error) {
        setNotice({ ...writeProblem(error), tone: 'danger' })
      }
    },
    [api, loadFittings, openRevision],
  )

  const repeat = useCallback(async () => {
    const now = current.current
    const open = dialogRef.current
    if (!now || !companyId || open?.kind !== 'repeat' || !open.facts || open.busy) return
    patchDialog({ busy: true, notice: null })
    try {
      const made = await createQuote(api, { companyId, partyId: now.partyId, contactId: now.contactId }, keyOf('repeatQuote'))
      const answer = await repeatOrder(api, now.latestId, { quoteId: made.id, version: made.version, ...(open.fromLineId ? { fromLineId: open.fromLineId } : {}), measuredOk: open.measuredOk }, keyOf('repeat'))
      dropKey('repeatQuote')
      dropKey('repeat')
      setDialog(null)
      router.push(quoteHref(prefix, answer.quote.id))
    } catch (error) {
      patchDialog({ busy: false, notice: { ...(isApiError(error) && error.kind === 'conflict' ? { key: 'repeat.problem.conflict' } : writeProblem(error)), tone: 'danger' } })
    }
  }, [api, companyId, prefix, router, patchDialog])

  const deleteDay = useCallback(async () => {
    const open = dialogRef.current
    if (open?.kind !== 'deleteDay' || open.busy) return
    patchDialog({ busy: true, notice: null })
    try {
      await setPhotosDeleteAfter(api, open.revisionId, { deleteAfter: businessDayStart(open.day).toISOString(), reason: open.reason.trim() })
      setDialog(null)
      setNotice({ key: 'photos.deleteDone', params: { date: open.day }, tone: 'success' })
      const now = current.current
      if (now) readSent(api, now.latestId).then((items) => setSent({ items, problem: null }), () => undefined)
    } catch (error) {
      patchDialog({ busy: false, notice: { ...writeProblem(error), tone: 'danger' } })
    }
  }, [api, patchDialog])

  const openPhotoDialog = useCallback(
    (revision: string, fileId: string, view: 'FRONT' | 'SIDE' | 'BACK') => {
      setDialog({ kind: 'photo', revisionId: revision, fileId, view, src: null, problem: null })
      openPhoto(api, revision, fileId)
        .then((answer) => setDialog((open) => (open?.kind === 'photo' && open.fileId === fileId ? { ...open, src: storeUrl(answer.download.url) } : open)))
        .catch((error: unknown) => setDialog((open) => (open?.kind === 'photo' ? { ...open, problem: readProblem(error) } : open)))
    },
    [api],
  )

  const model: ProfileRecordModel = {
    prefix,
    me: me.id,
    companyId,
    today,
    can,
    tab,
    loaded,
    asOf,
    live,
    stale,
    notice,
    revisionId,
    range,
    fittings,
    sent,
    proofs,
    dialog,
    measurements: measurements.model,
    link: link.model,
    quote: quote.model,
    lastResult,
    photos: photos.model,
    thread,
  }

  return (
    <ProfileRecordView
      model={model}
      actions={{
        onRetry: () => {
          void load()
          void loadFittings()
        },
        onReload: () => {
          void load()
          void loadFittings()
        },
        onRevision: (id) => setRevisionId(id),
        onDismissNotice: () => setNotice(null),
        onNewRevision: openRevision,
        onDialog: (next) => {
          if (next?.kind === 'review') openReview(next.draft.decision)
          else setDialog(next)
          if (next === null) setStale(null)
        },
        onReviewDraft: (patch) => setDialog((open) => (open?.kind === 'review' ? { ...open, draft: { ...open.draft, ...patch } } : open)),
        onReview: () => void review(),
        onCompare: (patch) => setDialog((open) => (open?.kind === 'compare' ? { ...open, ...patch } : open)),
        onOpenFitting: openFitting,
        onBookDraft: (patch) => setDialog((open) => (open?.kind === 'fitting' ? { ...open, draft: { ...open.draft, ...patch } } : open)),
        onBook: () => void book(),
        onOpenAppointment: openAppointment,
        onAppointmentMode: (mode) => setDialog((open) => (open?.kind === 'appointment' ? { ...open, mode, notice: null } : open)),
        onAppointmentDraft: (patch) => setDialog((open) => (open?.kind === 'appointment' ? { ...open, ...patch } : open)),
        onMove: () => void appointmentWrite('move'),
        onClose: () => void appointmentWrite('close'),
        onCancelAppointment: () => void appointmentWrite('cancel'),
        onInvite: () => void appointmentWrite('invite'),
        onOpenOutcome: openOutcome,
        onOutcomeDraft: (patch) => setDialog((open) => (open?.kind === 'outcome' ? { ...open, draft: { ...open.draft, ...patch } } : open)),
        onChange: (code, patch) =>
          setDialog((open) => {
            if (open?.kind !== 'outcome') return open
            const before = open.draft.changes[code] ?? { change: '', note: '' }
            return { ...open, draft: { ...open.draft, changes: { ...open.draft.changes, [code]: { ...before, ...patch } } } }
          }),
        onRecordOutcome: () => void recordOutcome(),
        onAlteration: (result) => void alteration(result),
        onNameRevision: (result) => void nameRevision(result),
        onOpenRepeat: openRepeat,
        onRepeatDraft: (patch) => setDialog((open) => (open?.kind === 'repeat' ? { ...open, ...patch } : open)),
        onRepeat: () => void repeat(),
        onOpenPhoto: openPhotoDialog,
        onOpenDeleteDay: (revision, number) => setDialog({ kind: 'deleteDay', revisionId: revision, revision: number, day: today, reason: '', busy: false, notice: null }),
        onDeleteDayDraft: (patch) => setDialog((open) => (open?.kind === 'deleteDay' ? { ...open, ...patch } : open)),
        onDeleteDay: () => void deleteDay(),
        onRangeStyle: (styleId) => setRange((now) => ({ ...now, styleId, style: null, colourwayId: '', check: null })),
        onRangeColourway: (colourwayId) => setRange((now) => ({ ...now, colourwayId })),
        onOpenLink: openLink,
        onOpenQuote: openQuote,
        measurements: measurements.actions,
        link: link.actions,
        quote: quote.actions,
        photos: photos.actions,
      }}
    />
  )
}

export type { Read }
