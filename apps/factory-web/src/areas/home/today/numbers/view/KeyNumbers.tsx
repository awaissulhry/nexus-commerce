'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, Gauge, Info, TriangleAlert } from 'lucide-react'
import { Banner, DetailPopover, KeyValue, Sparkline } from '@nexus/ui/components'
import { Button, InfoTip, Skeleton } from '@nexus/ui/primitives'
import { formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { KeyNumber } from '../api'
import { numberHref, numbersOfLens, problemKey, reportOfNumber, targetText, valueText, type KeyNumbersState } from '../model'
import '../numbers.css'

/**
 * My numbers (design home.today `key-numbers`, W2a; ANA-001): three to five numbers of the lens the flow strip shows, each
 * against its target (words and an icon, never colour alone), an 8-week line where the records' dates make one, and its
 * "How this number is made" (pop:number-explain, a DS DetailPopover on the ⓘ). The label is the link to the list behind
 * the number (else its report). Composed in the area: the DS MetricStrip's link tile cannot also hold the ⓘ button
 * (named missing DS part: "metric tile with an explain button"). Loading: '—' per tile; a number that cannot be read
 * now says so; no number for the person: the section is absent.
 */

export type { KeyNumbersState } from '../model'

export function KeyNumbersSection({ state, lens, built, onRetry }: { state: KeyNumbersState; lens: string | null; built: ReadonlySet<string>; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={['home-reports']}>
      <Numbers state={state} lens={lens} prefix={state.prefix} built={built} onRetry={onRetry} />
    </WithMessages>
  )
}

function Numbers({ state, lens, prefix, built, onRetry }: { state: KeyNumbersState; lens: string | null; prefix: string; built: ReadonlySet<string>; onRetry?: () => void }) {
  const t = useT('home-reports')
  const locale = useLocale()
  const picked = numbersOfLens(state.value, lens)
  // Nothing for this person: the section is absent (never a locked box).
  if (state.value && !picked) return null
  return (
    <section className="fw-kn" aria-labelledby="fw-kn-title">
      <div className="fw-kn-head">
        <h2 id="fw-kn-title" className="fw-kn-h">
          <Gauge size={16} aria-hidden /> {t('numbers.title')}
        </h2>
        <span className="fw-kn-muted">
          {picked ? t('numbers.forLens', { lens: t(`lens.${picked.lens}`) }) : null}
          {state.value ? ` · ${t('numbers.updated', { time: formatTime(state.value.asOf, { locale }) })}` : ''}
        </span>
      </div>
      {state.problem && !state.value ? (
        <Banner tone="danger" title={t('numbers.failed')} action={onRetry ? <Button size="sm" onClick={onRetry}>{t('common.retry')}</Button> : undefined}>
          {t(state.problem)}
        </Banner>
      ) : !picked ? (
        <div className="fw-kn-grid" aria-busy="true">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="fw-kn-tile">
              <Skeleton width={120} height={14} />
              <span className="fw-kn-value">—</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="fw-kn-grid">
          {picked.numbers.map((number) => (
            <Tile key={number.key} number={number} prefix={prefix} built={built} explainOpen={state.explainOpen === number.key} />
          ))}
        </div>
      )}
    </section>
  )
}

function Tile({ number, prefix, built, explainOpen }: { number: KeyNumber; prefix: string; built: ReadonlySet<string>; explainOpen: boolean }) {
  const t = useT('home-reports')
  const [open, setOpen] = useState(false)
  // A design case opens the explanation after the first paint (a popover open on the server would not hydrate).
  useEffect(() => {
    if (explainOpen) setOpen(true)
  }, [explainOpen])
  const locale = useLocale()
  const label = t(`number.${number.key}.label`)
  const href = numberHref(number, built)
  const value = valueText(number, locale)
  const target = targetText(number, t, locale)
  const spark = number.history && number.spark ? number.spark : null
  return (
    <article className="fw-kn-tile" aria-label={label}>
      <div className="fw-kn-top">
        {href ? (
          <Link className="fw-kn-label" href={`${prefix}${href}`}>
            {label}
          </Link>
        ) : (
          <span className="fw-kn-label">{label}</span>
        )}
        <DetailPopover trigger={<Info size={14} aria-hidden />} triggerLabel={t('numbers.explainOf', { label })} triggerClassName="fw-kn-info" label={t('numbers.explainTitle')} hoverDelay={0} open={open} onOpenChange={setOpen}>
          <Explain number={number} prefix={prefix} />
        </DetailPopover>
      </div>
      <div className="fw-kn-value">
        {value ?? (
          <span className="fw-kn-none">
            —
            <InfoTip tip={t(problemKey(number))} />
          </span>
        )}
        {value !== null && !number.complete && <InfoTip tip={t('numbers.atLeast')} />}
      </div>
      <div className="fw-kn-target">
        {number.targetWord === 'ON_TARGET' ? (
          <span className="fw-kn-word">
            <CheckCircle2 size={13} aria-hidden /> {t('numbers.word.ON_TARGET')}
          </span>
        ) : number.targetWord ? (
          <span className="fw-kn-word fw-kn-word--off">
            <TriangleAlert size={13} aria-hidden /> {t(`numbers.word.${number.targetWord}`)}
          </span>
        ) : null}
        <span className="fw-kn-muted">{target ?? t('numbers.noTarget')}</span>
      </div>
      {spark ? (
        <Sparkline values={spark} label={t('numbers.sparkLabel', { label })} shape="line" domain={[0, null]} format={(n) => valueText({ ...number, value: n }, locale) ?? ''} emptyLabel={t('numbers.sparkEmpty')} fluid height={24} />
      ) : (
        <span className="fw-kn-muted">{t('numbers.countedNow')}</span>
      )}
    </article>
  )
}

/** pop:number-explain "How this number is made": definition, formula in words, sources, period and cut-off, target. */
function Explain({ number, prefix }: { number: KeyNumber; prefix: string }) {
  const t = useT('home-reports')
  const locale = useLocale()
  const report = reportOfNumber(number)
  const target = targetText(number, t, locale)
  return (
    <div className="fw-kn-explain">
      <p className="fw-kn-explain-title">{t('numbers.explainTitle')}</p>
      <KeyValue
        dense
        labelCase="sentence"
        items={[
          { label: t('numbers.explain.definition'), value: t(`number.${number.key}.definition`) },
          { label: t('numbers.explain.formula'), value: t(`number.${number.key}.formula`) },
          { label: t('numbers.explain.sources'), value: t(`number.${number.key}.sources`) },
          { label: t('numbers.explain.period'), value: t(`number.${number.key}.period`) },
          { label: t('numbers.explain.cutOff'), value: t('numbers.cutOff') },
          { label: t('numbers.explain.target'), value: target ?? t('numbers.noTarget'), hint: target ? t('numbers.setBy') : undefined },
        ]}
      />
      <div className="fw-kn-explain-actions">
        {report ? (
          <Button size="sm" variant="secondary" asChild>
            <Link href={`${prefix}${report}`}>{t('numbers.openReport')}</Link>
          </Button>
        ) : null}
        <span className="fw-kn-muted">{t('numbers.kpiLater')}</span>
      </div>
    </div>
  )
}
