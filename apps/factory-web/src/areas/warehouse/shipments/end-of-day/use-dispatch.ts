'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useCoalesced, useLive } from '../hooks'
import { failed, LOADING, ready, words, writeWords } from '../queue/shared/depth'
import { bookPickup, movePickup, pickupDraft, pickupsOfDay, type PickupRow } from '../pickup/api'
import { dispatchAbilitiesOf } from '../pickup/dispatch'
import { bookBody, formOf, formProblems, PICKUP_REFUSALS, type PickupDialogActions, type PickupDialogModel } from '../pickup/model'
import { closeDay, handOver, previewSheet, readEndOfDay } from './api'
import { pickupable, pickupSite, type DispatchListActions, type DispatchListModel, type DispatchPick } from './list-model'
import { DAY_SHEET_REFUSALS, handOverOf, handOverRefusal, startChosen, type EndOfDayActions, type EndOfDayModel, type HandOverModel, type HandOverOutcome } from './model'

/**
 * B-W2b-412 on the shipments list (SCR-066, SCR-590): reads the queue's site's pickups of the day (`GET /shipping/pickups?day`;
 * live on shipping.pickup_changed) for the carriers' cut-off cards; Book a pickup (`GET …/pickups/draft` with the picked
 * shipments, then ONE `POST /shipping/pickups`; a pickup coming today confirmed, failed or called off with ONE `POST
 * …/status`), End of day (`GET /shipping/end-of-day`, a carrier's preview PDF, ONE `POST …/end-of-day/close`; live on
 * shipping.day_sheet_closed and shipment events) and Mark handed over (one `POST …/ship` per picked shipment, each its own key).
 * Every write carries its Idempotency-Key, kept while the same attempt is sent again.
 */
export function useDispatch({ siteId, today, prefix, onChanged }: { siteId: string | null; today: string; prefix: string; onChanged: () => void }): { model: DispatchListModel; actions: DispatchListActions } {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => dispatchAbilitiesOf(session.permissions), [session.permissions])
  const [pickups, setPickups] = useState<DispatchListModel['pickups']>(null)
  const [pickup, setPickup] = useState<PickupDialogModel | null>(null)
  const [endOfDay, setEndOfDay] = useState<EndOfDayModel | null>(null)
  const [handOverState, setHandOver] = useState<HandOverModel | null>(null)
  const keys = useRef<Record<string, string>>({})
  const keyOf = (name: string) => (keys.current[name] ??= newIdempotencyKey())
  const forget = (name: string) => delete keys.current[name]
  const pickupRef = useRef(pickup)
  pickupRef.current = pickup
  const dayRef = useRef(endOfDay)
  dayRef.current = endOfDay

  const loadPickups = useCallback(
    async (quiet: boolean) => {
      if (!siteId || !can.view) return setPickups(null)
      if (!quiet) setPickups(LOADING)
      try {
        setPickups(ready(await pickupsOfDay(api, siteId, today)))
      } catch (error) {
        setPickups((state) => (quiet && state?.state === 'ready' ? state : failed(error)))
      }
    },
    [api, siteId, today, can.view],
  )
  useEffect(() => {
    void loadPickups(false)
  }, [loadPickups])

  // ---- Book a pickup ------------------------------------------------------------------------------------------------------

  const readDraft = useCallback(
    async (site: string, shipmentIds: readonly string[]) => {
      setPickup((state) => (state ? { ...state, draft: LOADING, form: null } : state))
      try {
        const draft = await pickupDraft(api, { siteId: site, shipmentIds })
        setPickup((state) => (state ? { ...state, draft: ready(draft), form: formOf(draft), timeZone: draft.site.timeZone } : state))
      } catch (error) {
        setPickup((state) => (state ? { ...state, draft: failed(error) } : state))
      }
    },
    [api],
  )
  const pickupSiteRef = useRef<string | null>(null)

  const openPickup = useCallback(
    (picked: readonly DispatchPick[]) => {
      const chosen = pickupable(picked)
      const site = pickupSite(siteId, chosen)
      if (!site) return
      pickupSiteRef.current = site
      forget('pickup')
      setPickup({ shipmentIds: chosen.map((row) => row.id), draft: LOADING, form: null, tried: false, busy: false, problem: null, booked: null, move: null, moved: null, can, timeZone: 'Europe/Rome' })
      void readDraft(site, chosen.map((row) => row.id))
    },
    [siteId, can, readDraft],
  )

  const pickupActions: PickupDialogActions = {
    onForm: (next) => {
      forget('pickup')
      setPickup((state) => (state?.form ? { ...state, form: { ...state.form, ...next }, problem: null } : state))
    },
    onClose: () => setPickup((state) => (state?.busy ? state : null)),
    onRetry: () => {
      const state = pickupRef.current
      if (state && pickupSiteRef.current) void readDraft(pickupSiteRef.current, state.shipmentIds)
    },
    onBook: () => {
      const state = pickupRef.current
      if (!state || state.busy || state.booked || state.draft.state !== 'ready' || !state.form) return
      if (Object.keys(formProblems(state.form)).length > 0) return setPickup({ ...state, tried: true })
      const draft = state.draft.value
      setPickup({ ...state, tried: true, busy: true, problem: null })
      bookPickup(api, bookBody(state.form, draft), keyOf('pickup'))
        .then((row) => {
          forget('pickup')
          setPickup((current) => (current ? { ...current, busy: false, booked: row } : current))
          void loadPickups(true)
        })
        .catch((error: unknown) => {
          const problem = writeWords(error, 'pickup.refusal', PICKUP_REFUSALS)
          setPickup((current) => (current ? { ...current, busy: false, problem: { key: problem.key, params: problem.params } } : current))
        })
    },
    onMove: (move) => {
      forget('move')
      setPickup((state) => (state ? { ...state, move, problem: null } : state))
    },
    onMoveGo: () => {
      const state = pickupRef.current
      if (!state || state.busy || !state.move || state.draft.state !== 'ready') return
      const draft = state.draft.value
      const move = state.move
      const row = draft.alreadyToday.find((entry) => entry.id === move.pickupId)
      if (!row) return
      const text = move.text.trim()
      if (move.move === 'FAILED' && text === '') return
      setPickup({ ...state, busy: true, problem: null })
      movePickup(api, row.id, { version: row.version, status: move.move, words: text === '' ? null : text }, keyOf('move'))
        .then(({ pickup: moved, carrierTold }) => {
          forget('move')
          const replace = (rows: readonly PickupRow[]) => rows.map((entry) => (entry.id === moved.id ? moved : entry))
          setPickup((current) =>
            current && current.draft.state === 'ready'
              ? { ...current, busy: false, move: null, moved: words(carrierTold === false ? 'pickup.moved.callCarrier' : `pickup.moved.${moved.status}`, { time: moved.readyTime, carrier: moved.carrierName }), draft: ready({ ...current.draft.value, alreadyToday: replace(current.draft.value.alreadyToday) }) }
              : current,
          )
          void loadPickups(true)
        })
        .catch((error: unknown) => {
          const problem = writeWords(error, 'pickup.refusal', PICKUP_REFUSALS)
          setPickup((current) => (current ? { ...current, busy: false, problem: { key: problem.key, params: problem.params } } : current))
        })
    },
  }

  // ---- End of day --------------------------------------------------------------------------------------------------------

  const readDay = useCallback(
    async (site: string, day: string | null, keepChosen: boolean) => {
      setEndOfDay((state) => (state ? { ...state, read: state.read.state === 'ready' && keepChosen ? state.read : LOADING } : state))
      try {
        const value = await readEndOfDay(api, site, day)
        setEndOfDay((state) => (state ? { ...state, read: ready(value), chosen: keepChosen ? state.chosen.filter((code) => startChosen(value).includes(code)) : startChosen(value) } : state))
      } catch (error) {
        setEndOfDay((state) => (state ? { ...state, read: failed(error) } : state))
      }
    },
    [api],
  )

  const previewOf = useCallback(
    async (carrierCode: string) => {
      const state = dayRef.current
      if (!state || state.read.state !== 'ready') return
      const { siteId: site, day } = state.read.value
      setEndOfDay((current) => (current ? { ...current, preview: { carrierCode, pdf: LOADING } } : current))
      try {
        const pdf = await previewSheet(api, { siteId: site, carrierCode, day })
        setEndOfDay((current) => (current?.preview?.carrierCode === carrierCode ? { ...current, preview: { carrierCode, pdf: ready(pdf) } } : current))
      } catch (error) {
        setEndOfDay((current) => (current?.preview?.carrierCode === carrierCode ? { ...current, preview: { carrierCode, pdf: failed(error) } } : current))
      }
    },
    [api],
  )

  const endOfDayActions: EndOfDayActions = {
    onDay: (day) => {
      const state = dayRef.current
      if (!state || state.busy) return
      forget('close')
      setEndOfDay({ ...state, day, outcomes: null, problem: null, preview: null })
      void readDay(state.siteId, day, false)
    },
    onChoose: (code, on) => {
      forget('close')
      setEndOfDay((state) => (state ? { ...state, chosen: on ? [...new Set([...state.chosen, code])] : state.chosen.filter((entry) => entry !== code) } : state))
    },
    onPrint: (on) => {
      forget('close')
      setEndOfDay((state) => (state ? { ...state, print: on } : state))
    },
    onPreview: (code) => {
      if (code === null) return setEndOfDay((state) => (state ? { ...state, preview: null } : state))
      void previewOf(code)
    },
    onClose: () => setEndOfDay((state) => (state?.busy ? state : null)),
    onRetry: () => {
      const state = dayRef.current
      if (state) void readDay(state.siteId, state.day, false)
    },
    onGo: () => {
      const state = dayRef.current
      if (!state || state.busy || state.outcomes || state.read.state !== 'ready') return
      const value = state.read.value
      const carrierCodes = state.chosen.filter((code) => value.carriers.some((carrier) => carrier.carrierCode === code && carrier.may.close.allowed))
      if (carrierCodes.length === 0) return
      setEndOfDay({ ...state, busy: true, problem: null })
      closeDay(api, { siteId: value.siteId, day: value.day, carrierCodes, print: state.print }, keyOf('close'))
        .then((outcomes) => {
          forget('close')
          setEndOfDay((current) => (current ? { ...current, busy: false, outcomes } : current))
          void readDay(value.siteId, value.day, true)
          onChanged()
        })
        .catch((error: unknown) => {
          const problem = writeWords(error, 'eod.refusal', DAY_SHEET_REFUSALS)
          setEndOfDay((current) => (current ? { ...current, busy: false, problem: { key: problem.key, params: problem.params } } : current))
        })
    },
  }

  const openEndOfDay = useCallback(() => {
    if (!siteId) return
    forget('close')
    setEndOfDay({ siteId, day: null, read: LOADING, chosen: [], print: true, busy: false, problem: null, outcomes: null, preview: null, can, prefix })
    void readDay(siteId, null, false)
  }, [siteId, can, prefix, readDay])

  // ---- Mark handed over --------------------------------------------------------------------------------------------------

  const runHandOver = async () => {
    const state = handOverState
    if (!state || state.busy || state.outcomes) return
    const plan = handOverOf(state.picked)
    setHandOver({ ...state, busy: true })
    const outcomes: HandOverOutcome[] = []
    // One at a time: each is its own hand-over (its own command, key and refusal).
    for (const row of plan.go) {
      try {
        await handOver(api, row.id, row.version ?? null, keyOf(`ship:${row.id}`))
        forget(`ship:${row.id}`)
        outcomes.push({ id: row.id, number: row.number, state: 'done', words: words('handOver.why.done') })
      } catch (error) {
        outcomes.push({ id: row.id, number: row.number, state: 'refused', words: handOverRefusal(error) })
      }
    }
    for (const entry of plan.skipped) outcomes.push({ id: entry.row.id, number: entry.row.number, state: 'skipped', words: entry.why })
    setHandOver((current) => (current ? { ...current, busy: false, outcomes } : current))
    onChanged()
  }

  // ---- live ----------------------------------------------------------------------------------------------------------------

  const reread = useCoalesced(() => {
    void loadPickups(true)
    const state = dayRef.current
    if (state && !state.busy && state.read.state === 'ready') void readDay(state.siteId, state.day, true)
  }, 900)
  useLive(
    (change) => {
      if (change.type === 'shipping.pickup_changed' || change.type === 'shipping.day_sheet_closed' || (dayRef.current && change.type.startsWith('shipment.'))) reread()
    },
    () => reread(),
  )

  const model: DispatchListModel = { siteId, pickups, pickup, endOfDay, handOver: handOverState, can }
  const actions: DispatchListActions = {
    onPickup: openPickup,
    pickup: pickupActions,
    onEndOfDay: openEndOfDay,
    endOfDay: endOfDayActions,
    onHandOver: (picked) => {
      for (const row of picked) forget(`ship:${row.id}`)
      setHandOver({ picked: [...picked], busy: false, outcomes: null, can })
    },
    onHandOverGo: () => void runHandOver(),
    onHandOverClose: () => setHandOver((state) => (state?.busy ? state : null)),
  }
  return { model, actions }
}
