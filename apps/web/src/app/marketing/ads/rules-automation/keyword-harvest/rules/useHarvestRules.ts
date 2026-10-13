'use client'

/**
 * Keyword Harvest page, Rules view — the harvest rules of one market (GET /api/advertising/harvest/rules) and what became
 * of their harvests (GET /api/advertising/harvest/history, the Effect column), read once for the view. Read again when any
 * tab announces a rule or ask change, unless a review or a dialog is open (the next announcement after it closes brings
 * the view up to date). A failed history read leaves Effect empty, never the table. Only the newest read shows: an answer
 * that lands after a newer read began — another market's, or an older one — is dropped (release review RS5).
 */
import { useCallback, useEffect, useState } from 'react'
import { useAdsSync } from '../../_shared/adsBus'
import { previewHarvestRule, readHarvestRules, readHistory } from '../_shared/harvestApi'
import type { HarvestRulesAnswer } from '../_shared/types'
import { capOf, effectByRule, type RuleEffect } from './harvestRulesModel'
import { latestRead } from '../../../_shared/latestRead'

/** The days the Effect column counts. */
export const EFFECT_DAYS = 30

export interface HarvestRulesData {
  answer: HarvestRulesAnswer | null
  err: string | null
  effects: ReadonlyMap<string, RuleEffect>
  /** The Owner's D2 cap on Auto (new keywords a day per rule), once read. */
  capPerDay: number | null
  load(): Promise<HarvestRulesAnswer | null>
  put(answer: HarvestRulesAnswer): void
  setPaused(paused: boolean): void
}

const NO_EFFECTS: ReadonlyMap<string, RuleEffect> = new Map()

export function useHarvestRules(market: string): HarvestRulesData {
  const [answer, setAnswer] = useState<HarvestRulesAnswer | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [effects, setEffects] = useState<ReadonlyMap<string, RuleEffect>>(NO_EFFECTS)
  const [capPerDay, setCap] = useState<number | null>(null)
  const [paused, setPaused] = useState(false)
  const [begin] = useState(latestRead)
  const load = useCallback(async (): Promise<HarvestRulesAnswer | null> => {
    const current = begin()
    const history = readHistory({ market, days: EFFECT_DAYS }).then((h) => effectByRule(h.rows), () => null)
    try {
      const a = await readHarvestRules(market)
      if (!current()) return null
      setAnswer(a); setErr(null)
      const e = await history
      if (e && current()) setEffects(e)
      return a
    } catch (e) { if (current()) setErr((e as Error).message); return null }
  }, [market, begin])
  useEffect(() => { setAnswer(null); setEffects(NO_EFFECTS); void load() }, [load])
  // The cap is one number for every harvest rule (the server's setting): read once, from the first rule's preview.
  const firstRule = answer?.rules.find((r) => r.kind !== 'brain' && !r.archived)?.id ?? null
  useEffect(() => {
    if (!firstRule || capPerDay != null) return
    let alive = true
    void previewHarvestRule({ ruleId: firstRule, limit: 1 }).then((out) => { if (alive && out.ok) setCap(capOf(out.data)) })
    return () => { alive = false }
  }, [firstRule, capPerDay])
  useAdsSync(['ads.rule.changed', 'ads.suggestion.changed'], () => { void load() }, paused)
  return { answer, err, effects, capPerDay, load, put: setAnswer, setPaused }
}
