'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { useLive } from '../../_shared/buying/hooks'
import { changeBundleSize, changeScanSubject, getRules, listRules, noticeAcks, recordLegalBasis, stepUp, type ChangeAnswer } from './api'
import { REASON_LIST_GROUPS } from '@nexus/factory-domain/reasons/lists'
import { ReasonListsEditor } from '../../_shared/reasons/ReasonListsEditor'
import { changeProblem, chosenSite, doneOf, FLOOR_RULES_NAMESPACES, floorRulesCan, StepUpCancelled, stepUpProblem, subjectBody, tabOf, withStepUp } from './model'
import { FloorRulesView, type FloorRulesModel } from './view/FloorRulesView'

const TIME_ZONE = 'Europe/Rome'
const LOADING = { value: null, problem: null }

/** A failed read in this page's words (a key of `floor-rules`). */
function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'fr.problem.read'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'fr.problem.forbidden'
  if (error.kind === 'unavailable') return 'fr.problem.offline'
  if (error.kind === 'not_found') return 'fr.problem.gone'
  return 'fr.problem.read'
}

/**
 * `/w/<company>/production/settings?site=&tab=rules|codes&list=` (SCR-074, SCR-088): reads the sites' floor rules (production.settings
 * .view), the shown site's detail (the counts a change reaches) and its notice acknowledgements as counts, and the
 * reason codes in the shared reason list editor (B-W2a-46; reasons.view, reasons.manage); applies the switch (widening: a fresh code when the API asks, then the same call once
 * more; narrowing after the confirm), records or replaces the legal basis and saves the standard bundle size, each with
 * the version read and its own Idempotency-Key per attempt. Live `production.monitoring_changed` of the site from
 * another screen → "Changed by someone else · Reload".
 */
export function FloorRulesPage() {
  return (
    <WithMessages namespaces={FLOOR_RULES_NAMESPACES}>
      <Container />
    </WithMessages>
  )
}

function Container() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/production\/settings\/?$/, '')
  const can = useMemo(() => floorRulesCan(session.permissions), [session.permissions])
  const tab = tabOf(params?.get('tab'))
  const siteParam = params?.get('site') ?? null
  const companyId = session.company?.id ?? null

  const [sites, setSites] = useState<FloorRulesModel['sites']>({ status: 'loading' })
  const [detail, setDetail] = useState<FloorRulesModel['detail']>(LOADING)
  const [acks, setAcks] = useState<FloorRulesModel['acks']>(LOADING)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [busy, setBusy] = useState<FloorRulesModel['busy']>(null)
  const [notice, setNotice] = useState<FloorRulesModel['notice']>(null)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const [stepUpState, setStepUpState] = useState<FloorRulesModel['stepUp']>({ open: false, busy: false, problem: null })
  const waiting = useRef<{ resolve: () => void; reject: (error: unknown) => void } | null>(null)
  const ownChangeUntil = useRef(0)
  // One key per attempt of the same body: a lost answer sent again is answered from its receipt.
  const attempt = useRef<{ body: string; key: string } | null>(null)
  const keyFor = (body: unknown) => {
    const text = JSON.stringify(body)
    if (attempt.current?.body !== text) attempt.current = { body: text, key: newIdempotencyKey() }
    return attempt.current.key
  }

  const loadSites = useCallback(async () => {
    if (!can.view) return null
    try {
      const items = (await listRules(api, companyId)).filter((entry) => !companyId || entry.site.companyId === companyId)
      setSites({ status: 'ready', items })
      return items
    } catch (error) {
      setSites({ status: 'error', problem: readProblem(error) })
      return null
    }
  }, [api, can.view, companyId])

  const loadSite = useCallback(
    async (siteId: string) => {
      setDetail(LOADING)
      setAcks(LOADING)
      await Promise.all([
        getRules(api, siteId)
          .then((value) => setDetail({ value, problem: null }))
          .catch((error: unknown) => setDetail({ value: null, problem: readProblem(error) })),
        noticeAcks(api, siteId)
          .then((value) => setAcks({ value, problem: null }))
          .catch((error: unknown) => setAcks({ value: null, problem: readProblem(error) })),
      ])
      setAsOf(new Date().toISOString())
      setChangedElsewhere(false)
    },
    [api],
  )

  useEffect(() => {
    void loadSites()
  }, [loadSites])

  const site = sites.status === 'ready' ? chosenSite(sites.items, siteParam) : null
  const siteId = site?.site.id ?? null

  useEffect(() => {
    if (siteId) void loadSite(siteId)
  }, [siteId, loadSite])

  useLive(
    (change) => {
      if (change.type !== 'production.monitoring_changed' || change.fields.siteId !== siteId) return
      if (Date.now() < ownChangeUntil.current) return
      setChangedElsewhere(true)
    },
    () => {
      if (siteId) void loadSite(siteId)
    },
    can.view,
  )

  const askForCode = useCallback(
    () =>
      new Promise<void>((resolve, reject) => {
        waiting.current = { resolve, reject }
        setStepUpState({ open: true, busy: false, problem: null })
      }),
    [],
  )

  const done = useCallback(
    (answer: ChangeAnswer, key: string) => {
      attempt.current = null
      ownChangeUntil.current = Date.now() + 5000
      setDetail((current) => (current.value ? { value: { ...current.value, site: answer.site, rules: answer.rules, status: answer.status, affected: answer.affected }, problem: null } : current))
      setSites((current) => (current.status === 'ready' ? { status: 'ready', items: current.items.map((entry) => (entry.site.id === answer.site.id ? { site: answer.site, rules: answer.rules, status: answer.status } : entry)) } : current))
      setNotice({ tone: 'success', key })
      if (answer.site.id) void noticeAcks(api, answer.site.id).then((value) => setAcks({ value, problem: null })).catch(() => undefined)
    },
    [api],
  )

  const refused = (error: unknown) => {
    if (error instanceof StepUpCancelled) return
    const problem = changeProblem(error)
    if (problem.conflict) setChangedElsewhere(true)
    else setNotice({ tone: 'danger', key: problem.key })
  }

  const model: FloorRulesModel = {
    prefix,
    can,
    tab,
    timeZone: TIME_ZONE,
    sites,
    siteId,
    detail,
    acks,
    asOf,
    busy,
    notice,
    changedElsewhere,
    stepUp: stepUpState,
  }

  // B-W2a-46 (SCR-088): the reason lists of Floor rules & codes, in the shared editor (`?list=` keeps the one shown).
  const codes =
    tab === 'codes' ? (
      <ReasonListsEditor
        lists={REASON_LIST_GROUPS.floorRules}
        initialList={params?.get('list') ?? null}
        onListChange={(list) => {
          const query = new URLSearchParams(params?.toString() ?? '')
          query.set('list', list)
          router.replace(`${pathname}?${query.toString()}`)
        }}
      />
    ) : null

  return (
    <FloorRulesView
      model={model}
      codes={codes}
      actions={{
        onSite: (next) => {
          setNotice(null)
          router.replace(`${pathname}?site=${encodeURIComponent(next)}&tab=${tab}`)
        },
        onApplySwitch: (draft, plan) => {
          const rules = detail.value?.rules
          if (!rules || !siteId || busy) return
          setBusy('switch')
          setNotice(null)
          const run = async () => {
            if (plan.action === 'legalBasis' && draft.basisKind) {
              const body = { kind: draft.basisKind, reference: draft.reference.trim(), ...(rules.version !== null ? { version: rules.version } : {}) }
              return recordLegalBasis(api, siteId, body, keyFor(body))
            }
            const body = subjectBody(rules, draft, plan)
            return withStepUp(() => changeScanSubject(api, siteId, body, keyFor(body)), askForCode)
          }
          run()
            .then((answer) => done(answer, doneOf(answer.change, answer.changed)))
            .catch(refused)
            .finally(() => setBusy(null))
        },
        onBundle: (size) => {
          const rules = detail.value?.rules
          if (!rules || !siteId || busy) return
          setBusy('bundle')
          setNotice(null)
          const body = { standardBundleSize: size, ...(rules.version !== null ? { version: rules.version } : {}) }
          changeBundleSize(api, siteId, body, keyFor(body))
            .then((answer) => done(answer, 'fr.done.bundle'))
            .catch(refused)
            .finally(() => setBusy(null))
        },
        onStepUp: (code) => {
          setStepUpState((current) => ({ ...current, busy: true, problem: null }))
          stepUp(api, code)
            .then(() => {
              setStepUpState({ open: false, busy: false, problem: null })
              waiting.current?.resolve()
              waiting.current = null
            })
            .catch((error: unknown) => setStepUpState((current) => ({ ...current, busy: false, problem: stepUpProblem(error) })))
        },
        onStepUpCancel: () => {
          setStepUpState({ open: false, busy: false, problem: null })
          waiting.current?.reject(new StepUpCancelled())
          waiting.current = null
        },
        onReload: () => {
          setNotice(null)
          void loadSites().then(() => {
            if (siteId) void loadSite(siteId)
          })
        },
        onRetry: () => {
          if (sites.status !== 'ready') {
            setSites({ status: 'loading' })
            void loadSites()
          } else if (siteId) void loadSite(siteId)
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
