'use client'

import Link from 'next/link'
import { Card, Field } from '@nexus/ui/components'
import { Select, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import type { LabelChecks, RuleCheck, TextileChecks, TextileResult } from '../api'
import { gatesHref, marketShown, RULE_STATE, TEXTILE_STATE } from '../model'
import type { RecordDepth } from '../../view-model'
import { PanelRead, RuleLines, RulesLink, type RuleLine } from './parts'

/**
 * The label's rule checks beyond W1's (design lb-checks "each a sentence with pass or fail … textile share 82 % by weight →
 * textile labelling applies (W2b) · 'Made in Italy' allowed: cutting and sewing in Italy (W2b)"; lb-rule "Why this rule":
 * the laws as LawRef chips): the marking rules per switched-on market (CE marking, class warnings, glove marking, the GPSR
 * identifier and contact, the QR to the public DoC — B-W2b-253; a failing rule blocks only the markets it concerns), and the
 * textile, leather and origin checks of the style (B-W2b-208). A rule waiting for an outside yes says so; whether a rule
 * stops a print is the gate's requirement row, kept in Rules & markets › Gates (B-W2b-265: linked, never edited here).
 */
export function RulesCard({ depth, labelId, prefix, onMarket, onRetryChecks, onRetryTextile }: { depth: RecordDepth; labelId: string; prefix: string; onMarket?: (code: string) => void; onRetryChecks?: () => void; onRetryTextile?: () => void }) {
  const d = useT('compliance-labels-depth')
  return (
    <Card padded>
      <section className="fw-q-section" aria-labelledby="lb-h-rules" id="lb-rules">
        <div className="fw-q-section-head">
          <div className="fw-q-section-title">
            <h2 id="lb-h-rules">{d('rules.title')}</h2>
            <p className="fw-q-hint">{d('rules.intro')}</p>
          </div>
          <RulesLink href={gatesHref(prefix)} can={depth.can.rules}>
            {d('rules.gates')}
          </RulesLink>
        </div>
        <PanelRead read={depth.checks} failedTitle={d('rules.failed')} onRetry={onRetryChecks}>
          {(checks) => <MarketRules checks={checks} depth={depth} labelId={labelId} prefix={prefix} onMarket={onMarket} />}
        </PanelRead>
        <h3 className="fw-lb-h3">{d('textile.title')}</h3>
        {depth.textile === null ? (
          <p className="fw-q-hint">{d('composition.noStyle')}</p>
        ) : (
          <PanelRead read={depth.textile} failedTitle={d('textile.failed')} onRetry={onRetryTextile}>
            {(checks) => <TextileRules checks={checks} prefix={prefix} can={depth.can.rules} />}
          </PanelRead>
        )}
      </section>
    </Card>
  )
}

function MarketRules({ checks, depth, labelId, prefix, onMarket }: { checks: LabelChecks; depth: RecordDepth; labelId: string; prefix: string; onMarket?: (code: string) => void }) {
  const d = useT('compliance-labels-depth')
  const shown = marketShown(checks, depth.market)
  const entry = checks.markets.find((item) => (item.market?.code ?? null) === shown) ?? checks.markets[0]
  if (!entry) return <p className="fw-q-hint">{d('rules.noMarket')}</p>
  const blocked = checks.markets.filter((item) => item.blocks && item.market).map((item) => item.market!.code)
  const languages = `${prefix}/compliance/labels/${encodeURIComponent(labelId)}?tab=languages`
  const fixOf = (check: RuleCheck) => {
    if (check.outcome === 'WAITING') return d('rules.fix.waiting')
    if (check.outcome === 'PASS' || check.outcome === 'NOT_APPLICABLE') return null
    const path = check.findings[0]?.path ?? ''
    if (path.startsWith('phrases/')) return <Link className="fw-q-link" href={languages}>{d('rules.fix.languages')}</Link>
    if (['kind', 'qrTarget', 'gpsrContact', 'qr/origin'].includes(path)) return <a className="fw-q-link" href="#lb-sec-marking">{d('rules.fix.marking')}</a>
    if (path.startsWith('layout/')) return <a className="fw-q-link" href="#lb-sec-layout">{d('rules.fix.layout')}</a>
    if (path.startsWith('markets/')) return <RulesLink href={`${prefix}/compliance/settings?tab=markets`} can={depth.can.rules}>{d('rules.fix.markets')}</RulesLink>
    if (path === 'operators' || path === 'makerPartyId') return <RulesLink href={`${prefix}/compliance/settings?tab=operators`} can={depth.can.rules}>{d('rules.fix.operators')}</RulesLink>
    if (path.startsWith('style/') || path.startsWith('certificate/')) return d('rules.fix.style')
    return <RulesLink href={gatesHref(prefix)} can={depth.can.rules}>{d('rules.fix.gates')}</RulesLink>
  }
  const lines: RuleLine[] = entry.checks.map((check) => ({
    id: `${entry.market?.code ?? 'none'}-${check.key}`,
    state: RULE_STATE[check.outcome],
    name: d(`rule.${check.key}`),
    outcome: d(`outcome.${check.outcome}`),
    words: check.words,
    law: check.law,
    findings: check.findings.slice(1).map((finding) => finding.message),
    fix: fixOf(check),
  }))
  return (
    <div className="fw-q-stack">
      {checks.markets.length > 1 && (
        <Field label={d('rules.market')} hint={blocked.length > 0 ? d('rules.blocked', { markets: blocked.join(', ') }) : d('rules.noneBlocked')}>
          <Select size="sm" value={shown ?? ''} onChange={(event) => onMarket?.(event.target.value)}>
            {checks.markets.map((item) =>
              item.market ? (
                <option key={item.market.code} value={item.market.code}>
                  {item.market.code} · {item.market.name} · {item.blocks ? d('rules.marketBlocks') : d('rules.marketPrints')}
                </option>
              ) : null,
            )}
          </Select>
        </Field>
      )}
      {entry.market ? (
        <p className="fw-q-cell-row">
          <Tag tone={entry.blocks ? 'warning' : 'success'}>{entry.blocks ? d('rules.marketBlocks') : d('rules.marketPrints')}</Tag>
          <span className="fw-q-hint">{d('rules.marketLanguages', { market: entry.market.name, languages: entry.market.labelLanguages.join(', ').toUpperCase() || '—' })}</span>
        </p>
      ) : (
        <p className="fw-q-hint">{d('rules.noMarket')}</p>
      )}
      <RuleLines label={d('rules.title')} lines={lines} />
    </div>
  )
}

function TextileRules({ checks, prefix, can }: { checks: TextileChecks; prefix: string; can: boolean }) {
  const d = useT('compliance-labels-depth')
  const fixOf = (result: TextileResult) => {
    if (result.outcome === 'OFF') return <RulesLink href={gatesHref(prefix)} can={can}>{d('rules.fix.switch')}</RulesLink>
    if (result.outcome === 'PASS' || result.outcome === 'NOT_APPLICABLE') return null
    const path = result.findings[0]?.path ?? ''
    if (path.startsWith('label/composition')) return <a className="fw-q-link" href="#lb-sec-bom">{d('rules.fix.composition')}</a>
    if (path.startsWith('label/care') || path.startsWith('languages/')) return <a className="fw-q-link" href="#lb-sec-care">{d('rules.fix.care')}</a>
    return d('rules.fix.style')
  }
  const lines: RuleLine[] = checks.results.map((result) => ({
    id: `textile-${result.key}`,
    state: TEXTILE_STATE[result.outcome],
    name: d(`textile.${result.key}`),
    outcome: d(`textileOutcome.${result.outcome}`),
    words: result.words,
    law: result.law,
    findings: result.findings.slice(1).map((finding) => finding.message),
    fix: fixOf(result),
  }))
  return (
    <div className="fw-q-stack">
      <p className="fw-q-hint">{d('textile.read', { style: checks.style.code, revision: checks.revision.revision })}</p>
      <RuleLines label={d('textile.title')} lines={lines} />
    </div>
  )
}
