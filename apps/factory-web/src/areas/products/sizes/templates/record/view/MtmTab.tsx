'use client'

import Link from 'next/link'
import { Play, Square } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { Button, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import type { TemplateView } from '../../api'
import { ridersHref, ruleBounds, rulesFacts, ruleWords, switchHeld } from '../../model'
import { OnOffTag, useWords } from '../../parts'
import type { TemplateRecordActions, TemplateRecordModel } from './TemplateRecordView'

/**
 * Measurement template › Made-to-measure (B-W2b-248's rules, GATE-MTM): built switched OFF per template (Owner 11-10). The off
 * state in words and the way to start it — Start / Stop made-to-measure (product.mtm.switch, the Owner's; held with why for
 * everyone else; a reason; ONE PUT with the template's version) —, then what the template checks once on, read only: the rules
 * (each in its own words in the reader's language, Blocks / Warns, the points it compares, its bounds), the base size rule,
 * the alteration limits and tolerances, the styles measured with it and made to measure. A rule editor is not on this page
 * yet (named gap). Fetches nothing.
 */
export function MtmTab({ model, template, actions }: { model: TemplateRecordModel; template: TemplateView; actions?: TemplateRecordActions }) {
  const { t, say, locale } = useWords()
  if (model.rules.problem)
    return (
      <Card padded>
        <EmptyState
          title={t('mtm.failed')}
          description={t(model.rules.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetryRules?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      </Card>
    )
  const rules = model.rules.value
  if (!rules)
    return (
      <Card padded aria-busy="true">
        <p className="fw-lib-hint fw-lib-inline" role="status">
          <Spinner size={14} /> {t('mtm.reading')}
        </p>
        <div className="fw-lib-skeleton">
          <Skeleton height={22} />
          <Skeleton height={22} />
          <Skeleton height={22} />
        </div>
      </Card>
    )
  const on = rules.template.rulesOn
  const facts = rulesFacts(rules)
  const held = switchHeld(rules, !on, model.can, model.busy)
  const pointName = (code: string) => {
    const point = rules.points.find((entry) => entry.code === code)
    return point ? (point.nameI18n?.[locale] ?? point.name) : code
  }
  const sorted = [...rules.rules].sort((a, b) => Number(a.status === 'ARCHIVED') - Number(b.status === 'ARCHIVED') || Number(a.severity === 'WARN') - Number(b.severity === 'WARN'))
  return (
    <div className="fw-mtt-two">
      <div className="fw-lib-stack">
        <Card padded>
          <section className="fw-lib-stack" aria-labelledby="mtt-switch">
            <div className="fw-mtt-switch">
              <span className="fw-lib-inline">
                <h2 id="mtt-switch" className="fw-lib-title">
                  {t('mtm.title', { code: template.code })}
                </h2>
                <OnOffTag on={on} />
              </span>
              <Button size="sm" variant={on ? 'danger-outline' : 'primary'} heldReason={say(held)} onClick={() => actions?.onDialog?.({ kind: 'switch', on: !on, reason: '', problem: null })}>
                {on ? <Square size={13} aria-hidden /> : <Play size={13} aria-hidden />} {t(on ? 'mtm.stop' : 'mtm.start')}
              </Button>
            </div>
            <p className="fw-lib-hint">{t(on ? 'mtm.onBody' : 'mtm.offBody', { code: template.code })}</p>
            {!on && <Banner tone="info" title={t(model.can.switch ? 'mtm.offOwner' : 'mtm.offOthers')} />}
          </section>
        </Card>
        <Card padded>
          <section className="fw-lib-stack" aria-labelledby="mtt-rules">
            <h2 id="mtt-rules" className="fw-lib-title">
              {t('mtm.rulesTitle')}
            </h2>
            <p className="fw-lib-hint">{facts.active === 0 ? t('mtm.noRules') : t('mtm.rulesCount', { count: facts.active, blocking: facts.blocking })}</p>
            {sorted.length > 0 && (
              <ul className="fw-mtt-rules">
                {sorted.map((rule) => {
                  const bounds = ruleBounds(rule)
                  return (
                    <li key={rule.id} className="fw-mtt-rule">
                      <Tag tone={rule.status === 'ARCHIVED' ? 'neutral' : rule.severity === 'BLOCK' ? 'danger' : 'warning'}>{t(rule.status === 'ARCHIVED' ? 'mtm.archivedRule' : `severity.${rule.severity}`)}</Tag>
                      <span className="fw-mtt-rule-words">{ruleWords(rule, locale)}</span>
                      <span className="fw-lib-sub">
                        {t(`kind.${rule.kind}`)} · {rule.otherPointCode ? t('mtm.twoPoints', { point: pointName(rule.pointCode), other: pointName(rule.otherPointCode) }) : pointName(rule.pointCode)}
                        {bounds ? ` · ${bounds}` : ''}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
            <p className="fw-lib-hint">{t('mtm.editLater')}</p>
          </section>
        </Card>
      </div>
      <Card padded>
        <section className="fw-lib-stack" aria-labelledby="mtt-facts">
          <h2 id="mtt-facts" className="fw-lib-title">
            {t('mtm.factsTitle')}
          </h2>
          <dl className="fw-mtt-facts">
            <div className="fw-lib-readfield">
              <dt className="fw-lib-readfield-label">{t('mtm.baseSize')}</dt>
              <dd className="fw-lib-readfield-value">{facts.baseSizePoints.length > 0 ? t(facts.tie === 'SMALLER' ? 'mtm.baseSizeFromSmaller' : 'mtm.baseSizeFrom', { points: facts.baseSizePoints.map(pointName).join(', ') }) : t('mtm.noBaseSize')}</dd>
            </div>
            <div className="fw-lib-readfield">
              <dt className="fw-lib-readfield-label">{t('mtm.limits')}</dt>
              <dd className="fw-lib-readfield-value">{t('mtm.limitsCount', { count: facts.limits })}</dd>
            </div>
            <div className="fw-lib-readfield">
              <dt className="fw-lib-readfield-label">{t('mtm.tolerances')}</dt>
              <dd className="fw-lib-readfield-value">{t('mtm.tolerancesCount', { count: facts.tolerances })}</dd>
            </div>
            <div className="fw-lib-readfield">
              <dt className="fw-lib-readfield-label">{t('mtm.styles')}</dt>
              <dd className="fw-lib-readfield-value">{t('used.stylesValue', { count: rules.styles.measured, mtm: rules.styles.madeToMeasure })}</dd>
            </div>
          </dl>
          <Link className="fw-lib-link" href={ridersHref(model.prefix, template.code)}>
            {t('used.openRiders', { code: template.code })}
          </Link>
        </section>
      </Card>
    </div>
  )
}
