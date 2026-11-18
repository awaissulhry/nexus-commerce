'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import { isApiError } from '../../../../../lib/api/errors'
import type { LiveChange } from '../../../../../shell/live/use-live'
import { isStepUpCancelled } from '../../../../admin/shared/step-up'
import { changeProductionLimits, getProductionLimits, type ProductionLimits } from '../../../../admin/users/partners/api'
import { partnerProblem } from '../../../../admin/users/partners/model'
import { readPickList, setCustomerSupervisor } from '../../../../_shared/production-supervisor/api'
import type { PortalNotice } from '../model'
import { createFreezeRule, listFreezeRules, switchOffFreezeRule, type FreezeRule } from './api'
import {
  blankFreezeDraft,
  freezeBody,
  freezeProblemOf,
  limitsProblemOf,
  pickProblemOf,
  saveLimits,
  supervisorProblemOf,
  type FreezeDialog,
  type FreezeDraft,
  type FreezeState,
  type LimitsActions,
  type LimitsDraft,
  type LimitsModel,
  type OrderFreezeField,
  type PickState,
  type SupervisorActions, // F-SA-272
  type SupervisorModel, // F-SA-272
} from './model'

/** The step-up's words of the limits (catalogue portal-access). */
const SENTENCE = 'stepUp.sentence.production'

/**
 * F-PR-07 — the limits card's container part (inside Customer › Portal settings): reads the card (`GET /partners/:id/production`)
 * and the freeze points (`GET /sales/order-freeze-rules?companyId&partyId`), each on its own — one failing leaves the other usable.
 * Apply = the limits after a fresh code when the API asks (one Idempotency-Key per Apply; F-SA-272: the supervisor and backup are
 * the customer Overview's own card, useCustomerSupervisor below). A freeze rule is saved by its own dialog. Live: the
 * party's settings, its supervisor and its or the company's freeze rules read their part again.
 */
export function useLimits(input: {
  readonly api: ApiClient
  readonly partyId: string
  /** The company whose freeze points are read: the customer's own, else the one the page works in. */
  readonly companyId: string | null
  readonly companyName: string | null
  /** The card applies (a customer's Portal access, its read done). */
  readonly enabled: boolean
  readonly guard: <T>(sentence: string, work: () => Promise<T>) => Promise<T>
  readonly onNotice: (notice: PortalNotice) => void
}) {
  // F-SA-272: the supervisor and backup left this card for the customer's Overview (useCustomerSupervisor below).
  const { api, partyId, companyId, companyName, enabled, guard, onNotice } = input
  const [read, setRead] = useState<ProductionLimits | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [freeze, setFreeze] = useState<FreezeState>({ status: 'loading' })
  const [freezeDialog, setFreezeDialog] = useState<FreezeDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [saveProblem, setSaveProblem] = useState<LimitsModel['saveProblem']>(null)
  const freezeKey = useRef<string | null>(null)
  const notice = useRef(onNotice)
  notice.current = onNotice

  const load = useCallback(async () => {
    if (!enabled) return
    try {
      setRead(await getProductionLimits(api, partyId))
      setProblem(null)
    } catch (error) {
      setProblem(partnerProblem(error))
    }
  }, [api, enabled, partyId])

  const loadFreeze = useCallback(async () => {
    if (!enabled) return
    if (!companyId) {
      setFreeze({ status: 'error', key: 'limits.freeze.noCompany' })
      return
    }
    try {
      setFreeze({ status: 'ready', list: await listFreezeRules(api, { companyId, partyId }) })
    } catch (error) {
      setFreeze({ status: 'error', key: partnerProblem(error) })
    }
  }, [api, companyId, enabled, partyId])

  useEffect(() => {
    void load()
    void loadFreeze()
  }, [load, loadFreeze])

  /** A live change of this customer's limits, supervisor or freeze points (the company's too): read that part again. */
  const onLive = useCallback(
    (change: LiveChange) => {
      if (!enabled) return
      const party = change.fields.partyId
      if (change.type === 'partner_portal.settings_changed' && party === partyId) void load()
      if (change.type === 'order_freeze_rule.changed' && (party === partyId || (party === null && change.fields.companyId === companyId))) void loadFreeze()
    },
    [companyId, enabled, load, loadFreeze, partyId],
  )

  const reloadAll = useCallback(() => {
    void load()
    void loadFreeze()
  }, [load, loadFreeze])

  const latestRead = useRef(read)
  latestRead.current = read
  const latestDialog = useRef(freezeDialog)
  latestDialog.current = freezeDialog
  const latestFreeze = useRef(freeze)
  latestFreeze.current = freeze
  const actions = useMemo<LimitsActions>(
    () => ({
      onApply: async (draft: LimitsDraft) => {
        const current = latestRead.current
        if (!current) return false
        setBusy(true)
        setSaveProblem(null)
        const limitsKey = newIdempotencyKey()
        // F-SA-272: the limits only (the supervisor is saved by its own card on the Overview).
        const outcome = await saveLimits(current.production, draft, { limits: (body) => guard(SENTENCE, () => changeProductionLimits(api, partyId, body, limitsKey)) }, { manage: current.mayManage, supervise: false })
        setBusy(false)
        if (outcome.state === 'saved') {
          notice.current({ key: 'done.production', tone: 'success', params: { name: current.party.name } })
          void load()
          return true
        }
        if (isStepUpCancelled(outcome.error)) {
          // The code dialog was closed: nothing more was sent (saved limits stay saved; the card reads them again).
          if (outcome.limitsSaved) void load()
          return false
        }
        setSaveProblem({ key: limitsProblemOf(outcome.error), ns: 'portal-access', limitsSaved: outcome.limitsSaved })
        if (outcome.limitsSaved || (isApiError(outcome.error) && outcome.error.kind === 'conflict')) void load()
        return false
      },
      onRetry: () => {
        setProblem(null)
        setRead(null)
        void load()
      },
      onRetryFreeze: () => {
        setFreeze({ status: 'loading' })
        void loadFreeze()
      },
      onFreezeDialog: (field: OrderFreezeField | null) => {
        freezeKey.current = field ? newIdempotencyKey() : null
        setFreezeDialog(field ? { field, draft: blankFreezeDraft(field), busy: false, problem: null } : null)
      },
      onFreezeDraft: (draft: FreezeDraft) => setFreezeDialog((current) => (current ? { ...current, draft, problem: null } : current)),
      onFreezeAdd: () => {
        const dialog = latestDialog.current
        const list = latestFreeze.current
        if (!dialog || dialog.busy || list.status !== 'ready' || !list.list.partyId) return
        setFreezeDialog({ ...dialog, busy: true, problem: null })
        const key = freezeKey.current ?? newIdempotencyKey()
        createFreezeRule(api, freezeBody({ companyId: list.list.companyId, partyId: list.list.partyId }, dialog.draft), key)
          .then(() => {
            freezeKey.current = newIdempotencyKey()
            setFreezeDialog((current) => (current ? { ...current, busy: false, draft: blankFreezeDraft(current.field) } : current))
            notice.current({ key: 'done.freeze', tone: 'success', params: { name: latestRead.current?.party.name ?? '' } })
            void loadFreeze()
          })
          .catch((error: unknown) => setFreezeDialog((current) => (current ? { ...current, busy: false, problem: freezeProblemOf(error) } : current)))
      },
      onFreezeReset: (rules: readonly FreezeRule[]) => {
        const dialog = latestDialog.current
        if (!dialog || dialog.busy || rules.length === 0) return
        setFreezeDialog({ ...dialog, busy: true, problem: null })
        void (async () => {
          try {
            // One switch-off per rule of the customer's own for this field, one after the other.
            for (const rule of rules) await switchOffFreezeRule(api, rule, newIdempotencyKey())
            setFreezeDialog(null)
            notice.current({ key: 'done.freezeReset', tone: 'success', params: { name: latestRead.current?.party.name ?? '' } })
          } catch (error) {
            setFreezeDialog((current) => (current ? { ...current, busy: false, problem: freezeProblemOf(error) } : current))
          } finally {
            void loadFreeze()
          }
        })()
      },
      onDismissProblem: () => setSaveProblem(null),
    }),
    [api, guard, load, loadFreeze, partyId],
  )

  const model: LimitsModel | null = enabled
    ? { state: read ? 'ready' : problem ? 'error' : 'loading', read, problem, freeze, freezeDialog, companyName, busy, saveProblem }
    : null

  return { model, actions, onLive, reloadAll, reload: load }
}

// ── F-SA-272 (sales page plan N5, pick P10'; 11-customer-page §4 S2): who looks after the customer — moved here from useLimits ──
/**
 * The customer's production supervisor and backup, on its Overview: the customer's production read (its supervisor, backup and
 * version), the people who may supervise (`GET /production/supervisors?partyId`, only with production.brand.manage; a 404 = not over
 * every company), and Apply = the supervisor's own route (PUT /production/brands/:id/supervisor). Office only: the customer is never
 * told who (R-41). Live: this customer's supervisor change reads both again.
 */
export function useCustomerSupervisor(input: { readonly api: ApiClient; readonly partyId: string; readonly enabled: boolean; readonly supervise: boolean; readonly onNotice?: (notice: PortalNotice) => void }) {
  const { api, partyId, enabled, supervise } = input
  const [read, setRead] = useState<ProductionLimits | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [pick, setPick] = useState<PickState>(supervise ? { status: 'loading' } : { status: 'held', key: 'held.noRight', ns: 'production-supervisor' })
  const [busy, setBusy] = useState(false)
  const [saveProblem, setSaveProblem] = useState<SupervisorModel['saveProblem']>(null)
  const notice = useRef(input.onNotice)
  notice.current = input.onNotice

  const load = useCallback(async () => {
    if (!enabled) return
    try {
      setRead(await getProductionLimits(api, partyId))
      setProblem(null)
    } catch (error) {
      setProblem(partnerProblem(error))
    }
  }, [api, enabled, partyId])

  const loadPick = useCallback(async () => {
    if (!enabled) return
    if (!supervise) {
      setPick({ status: 'held', key: 'held.noRight', ns: 'production-supervisor' })
      return
    }
    try {
      const list = await readPickList(api, { partyId })
      setPick({ status: 'ready', people: list.people, complete: list.complete, ordersOnDefault: list.ordersOnDefault })
    } catch (error) {
      setPick(pickProblemOf(error))
    }
  }, [api, enabled, partyId, supervise])

  useEffect(() => {
    void load()
    void loadPick()
  }, [load, loadPick])

  const onLive = useCallback(
    (change: LiveChange) => {
      if (enabled && change.type === 'brand_production.supervisor_changed' && change.fields.partyId === partyId) {
        void load()
        void loadPick()
      }
    },
    [enabled, load, loadPick, partyId],
  )

  const latestRead = useRef(read)
  latestRead.current = read
  const latestPick = useRef(pick)
  latestPick.current = pick

  const actions = useMemo<SupervisorActions>(
    () => ({
      onApply: async (draft: LimitsDraft) => {
        const current = latestRead.current
        if (!current || latestPick.current.status !== 'ready') return false
        setBusy(true)
        setSaveProblem(null)
        const supervisorKey = newIdempotencyKey()
        const outcome = await saveLimits(current.production, draft, { supervisor: (body) => setCustomerSupervisor(api, partyId, body, supervisorKey).then((answer) => ({ version: answer.customer.version })) }, { manage: false, supervise: true })
        setBusy(false)
        if (outcome.state === 'saved') {
          notice.current?.({ key: 'done.supervisor', tone: 'success', params: { name: current.party.name } })
          void load()
          void loadPick()
          return true
        }
        setSaveProblem(supervisorProblemOf(outcome.error))
        if (isApiError(outcome.error) && outcome.error.kind === 'conflict') void load()
        return false
      },
      onRetry: () => {
        setProblem(null)
        setRead(null)
        void load()
      },
      onRetryPick: () => {
        setPick({ status: 'loading' })
        void loadPick()
      },
      onDismissProblem: () => setSaveProblem(null),
    }),
    [api, load, loadPick, partyId],
  )

  const model: SupervisorModel | null = enabled ? { state: read ? 'ready' : problem ? 'error' : 'loading', read, problem, supervise, pick, busy, saveProblem } : null
  return { model, actions, onLive }
}
// ── end F-SA-272 ──
