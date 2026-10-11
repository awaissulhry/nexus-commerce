'use client'

/**
 * Bid page — the four tiles above both views (2026-10-10). One label never shows two numbers (audit M1):
 *
 *   Rules view   Rules on · Rule changes · 7 d · Waiting for you · Clashes · 7 d   (the rules read; each filters the rules;
 *                Clashes = the Brain's clashes, its Clashes tab)
 *   Bids view    Rules on · Bids changed · 7 d · Waiting for you · Two writers     (Bids changed and Two writers are the bids
 *                view's own totals — `BidsTotals.changed7d` and `.contested` — and filter its bids: `?show=changed7d|contested`)
 *
 * Two words, two meanings (audit R3): "Clashes" is only ever the Brain's, "Two writers" only ever the bids two writers set.
 * Until the Bids view has reported its totals (reading, or not read), its tiles keep their own labels with a dash — never
 * a rules label on the Bids view. "Waiting for you" is the rules' asks on both views (one label, one number) and opens them on this
 * page, where they are decided (the Owner: every waiting entry point opens the rule's Waiting tab): the rule's tab when
 * one rule waits, else the rules that wait. "Clashes · 7 d" opens the Brain's Clashes.
 */
import { MetricStrip, type Metric } from '@/design-system/components'
import { WEEK } from '../_shared/format'
import type { BidsShow, BidsTotals } from '../bids'
import type { BidRulesTotals, RulesTile } from './bidRulesModel'
import { BRAIN_ID } from './bidRulesModel'
import styles from '../bid.module.css'

/** What the tiles read of the Bids view's report (`onTotals`, lane BIDS): its changed and clashing bids. */
export type BidsTileTotals = Pick<BidsTotals, 'changed7d' | 'contested'>

export const RULE_CHANGES_LABEL = `Rule changes · ${WEEK}`
export const BIDS_CHANGED_LABEL = `Bids changed · ${WEEK}`
export const RULE_CLASHES_LABEL = `Clashes · ${WEEK}`
export const TWO_WRITERS_LABEL = 'Two writers'

export function BidTiles({ view, totals, bids, tile, bidsShow, onQuery, onWaiting }: {
  view: 'rules' | 'bids'
  totals: BidRulesTotals | null
  /** The Bids view's own totals, once it has reported them. */
  bids: BidsTileTotals | null
  /** The rules tile that filters now (Rules view). */
  tile: RulesTile | null
  /** The bids filter a tile set (Bids view). */
  bidsShow: BidsShow | null
  /** One address change: the view, the tile, the panel. */
  onQuery(patch: Record<string, string | null>): void
  /** "Waiting for you": open the asks. */
  onWaiting(): void
}) {
  const t = totals
  const pickRules = (id: RulesTile) => () => onQuery({ view: null, show: tile === id && view === 'rules' ? null : id, rule: null, tab: null })
  const pickBids = (id: BidsShow) => () => onQuery({ show: bidsShow === id ? null : id })
  const rulesOn: Metric = { label: 'Rules on', value: t ? t.on : '—', accent: 'var(--nds-success)', onClick: pickRules('on'), active: view === 'rules' && tile === 'on' }
  const waiting: Metric = t && t.waiting > 0
    ? { label: 'Waiting for you', value: t.waiting, accent: 'var(--nds-warning)', onClick: onWaiting, active: view === 'rules' && tile === 'waiting' }
    : { label: 'Waiting for you', value: t ? t.waiting : '—', accent: 'var(--nds-border-strong)' }

  const metrics: Metric[] = view === 'bids'
    ? [
      rulesOn,
      bids
        ? { label: BIDS_CHANGED_LABEL, value: bids.changed7d, accent: 'var(--nds-primary)', onClick: pickBids('changed7d'), active: bidsShow === 'changed7d' }
        : { label: BIDS_CHANGED_LABEL, value: '—', accent: 'var(--nds-primary)' },
      waiting,
      bids && bids.contested > 0
        ? { label: TWO_WRITERS_LABEL, value: bids.contested, accent: 'var(--nds-danger)', onClick: pickBids('contested'), active: bidsShow === 'contested' }
        : { label: TWO_WRITERS_LABEL, value: bids ? bids.contested : '—', accent: 'var(--nds-border-strong)' },
    ]
    : [
      rulesOn,
      { label: RULE_CHANGES_LABEL, value: t ? t.bidsChanged7d : '—', accent: 'var(--nds-primary)', onClick: pickRules('changed'), active: view === 'rules' && tile === 'changed' },
      waiting,
      t && t.clashes > 0
        ? { label: RULE_CLASHES_LABEL, value: t.clashes, accent: 'var(--nds-danger)', onClick: () => onQuery({ view: null, show: null, rule: BRAIN_ID, tab: 'clashes' }) }
        : { label: RULE_CLASHES_LABEL, value: t ? t.clashes : '—', accent: 'var(--nds-border-strong)' },
    ]
  return <MetricStrip className={styles.tiles} metrics={metrics} />
}
