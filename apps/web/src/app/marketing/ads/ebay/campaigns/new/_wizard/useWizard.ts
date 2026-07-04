'use client'

/**
 * ER2 — shared wizard state: plan (draft-autosaved), listings fetch,
 * step navigation with visited tracking. Each wizard declares its own step
 * list + per-step blockers; the hook owns the mechanics.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { postEbayAds } from '../../../_lib'
import { newPlan, type CampaignPlan, type ListingsPayload, type WizardType } from './plan'
import { loadDraft, saveDraft } from './draft'

export function useWizard(type: WizardType, opts: { strategy: 'CPS' | 'CPC'; goalFactor?: number; fallbackRatePct?: number }) {
  const [plan, setPlan] = useState<CampaignPlan>(() => newPlan(type, 'EBAY_IT', null))
  const [resume, setResume] = useState<{ savedAt?: string } | null>(null)
  const [data, setData] = useState<ListingsPayload | null>(null)
  const [dataErr, setDataErr] = useState<string | null>(null)
  const [step, setStep] = useState<string>('setup')
  const [visited, setVisited] = useState<string[]>(['setup'])
  const hydrated = useRef(false)

  // template + draft hydration (client-only)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const template = params.get('template')
    const market = params.get('market') ?? 'EBAY_IT'
    const draft = loadDraft(type, market)
    // EV3 — merge over fresh defaults so drafts saved before new plan fields
    // existed hydrate them ('' defaults) instead of leaving undefined
    if (draft && !template) { setPlan({ ...newPlan(type, market, draft.template), ...draft }); setResume({ savedAt: draft.savedAt }) }
    else setPlan(newPlan(type, market, template))
    hydrated.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type])

  // autosave on every commit after hydration
  useEffect(() => { if (hydrated.current) saveDraft(plan) }, [plan])

  const set = useCallback((patch: Partial<CampaignPlan>) => setPlan((p) => ({ ...p, ...patch })), [])

  // listings plan (economics + conflicts) — refetched on market change
  useEffect(() => {
    if (!hydrated.current) return
    let alive = true
    postEbayAds<ListingsPayload>('/builder/listings', {
      marketplace: plan.marketplace, strategy: opts.strategy,
      ...(opts.goalFactor != null ? { goalFactor: opts.goalFactor } : {}),
      ...(opts.fallbackRatePct != null ? { fallbackRatePct: opts.fallbackRatePct } : {}),
    }).then((d) => { if (alive) { setData(d); setDataErr(null) } }).catch((e) => { if (alive) setDataErr((e as Error).message) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.marketplace, hydrated.current])

  const changeMarket = useCallback((m: string) => {
    // re-derive: listing selections don't carry across markets
    setPlan((p) => ({ ...newPlan(type, m, p.template), name: p.name, startDate: p.startDate, endDate: p.endDate }))
  }, [type])

  const go = useCallback((key: string) => {
    setStep(key)
    setVisited((v) => (v.includes(key) ? v : [...v, key]))
  }, [])

  const listings = useMemo(() => data?.listings ?? [], [data])
  return { plan, set, step, go, visited, listings, data, dataErr, resume, dismissResume: () => setResume(null), changeMarket }
}
