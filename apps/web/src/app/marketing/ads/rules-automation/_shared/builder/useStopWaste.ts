'use client'

/**
 * The state of the Negative Targeting builder's "Stop waste — may run alone" section (wave 4): its starters (GET
 * /api/advertising/waste/rules/starters — the PLAN §2 defaults, money only with the ad spend permission), the form, a
 * saved rule's section read back, and what the first action carries. Inert for every other rule type (`enabled` false).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { formOfSaved, formOfStarter, sectionProblems, stopWastePayload, type Starter, type StopWasteForm, type StopWasteKind } from './stopWasteSectionModel'

/** Used only when the starters cannot be read: the same defaults, without the money (the API then applies its own). */
const FALLBACK: readonly Starter[] = [
  { kind: 'NEGATE_TERM', windowDays: 60, minClicks: 20, cpaMultiple: 1.5 },
  { kind: 'PAUSE_KEYWORD', windowDays: 60, minClicks: 20, cpaMultiple: 2 },
]

export function useStopWaste(enabled: boolean) {
  const [starters, setStarters] = useState<readonly Starter[]>(FALLBACK)
  const [form, setForm] = useState<StopWasteForm>(() => formOfStarter(FALLBACK[0]))
  /** The form has been read back from a saved rule (or touched): the starters no longer reset it. */
  const settled = useRef(false)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    fetch(`${getBackendUrl()}/api/advertising/waste/rules/starters`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const list = (Array.isArray(j?.starters) ? j.starters : []) as Starter[]
        if (!alive || list.length < 2) return
        setStarters(list)
        setForm((f) => (settled.current ? f : formOfStarter(list.find((s) => s.kind === f.kind) ?? list[0], f.on)))
      })
      .catch(() => { /* the fallback stands */ })
    return () => { alive = false }
  }, [enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  const starterOf = useCallback((k: StopWasteKind) => starters.find((s) => s.kind === k) ?? FALLBACK.find((s) => s.kind === k)!, [starters])
  const change = useCallback((next: StopWasteForm) => { settled.current = true; setForm(next) }, [])
  /** Another action: that kind's own numbers (a keyword's spend bar is not a search term's). */
  const pickKind = useCallback((k: StopWasteKind) => { settled.current = true; setForm((f) => formOfStarter(starterOf(k), f.on)) }, [starterOf])
  /**
   * A saved rule's first action, read back (absent: the section stays off, on its defaults). Its spend bar shows as
   * stored, so a save never drops a bar someone set; a new rule's comes from the starters (absent without the permission).
   */
  const hydrate = useCallback((raw: unknown) => {
    const saved = formOfSaved(raw, true)
    settled.current = true
    if (saved) setForm(saved)
  }, [])
  const payload = useMemo(() => (enabled ? stopWastePayload(form) : null), [enabled, form])
  const ok = !enabled || !form.on || Object.keys(sectionProblems(form)).length === 0
  return { form, change, pickKind, hydrate, payload, ok, on: enabled && form.on }
}
