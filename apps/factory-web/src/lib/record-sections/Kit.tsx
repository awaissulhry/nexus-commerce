'use client'

import type { ReactNode } from 'react'
import { Info } from 'lucide-react'
import { Banner, Card, DetailPopover } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { formatTime } from '../i18n/format'
import { useLocale, useT } from '../i18n/provider'
import { headButtonsOf } from './model'
import './record-sections.css'

/**
 * F-PT-101 (order PRODUCTION tab, 10-design §2) — the kit every section draws with, so the six look and behave as one:
 *
 *   Section     a DS Card that is its own size container (`sec`), its address (#now …) and its head
 *   head        h2 · ONE plain answer · at most three buttons (the rest in its ⋯) · one ⓘ (meaning and key hints, nowhere else) ·
 *               "Counts as of hh:mm" only where L2 says (Production now, Work orders)
 *   states      reading: rows of skeleton in the section's own shape; failed: one danger line with its own Try again (the rest of the tab
 *               still draws); empty: one quiet line; withheld: one line of words (never a right's name, never an empty "none")
 *
 * owb-b5 (w5.1; design plan § 5i "ONE section kit"): MOVED here from areas/sales/orders/record/view/production/Kit.tsx; only its imports
 * and its `id` type changed (no markup, class or word). The order's Production, Changes, Money, Shipments and Files tabs and the
 * customer page's tabs draw with it; a portal page may too. Its rules moved with it (record-sections.css: the kit's rules of
 * production.css, verbatim). A shared part imports no office or portal code: a section's `id` is the tab's own address (`now`,
 * `freeze`, `totals`, `party-hold` …), each tab's layout keeps its list (production/changes/money layout.ts, the customer tabs'
 * models). Owner after the base: S2.
 */

/** A section of the tab: a DS Card (padded), its address and its head; the body below. */
export function Section({ id, title, answer, asOf, buttons, info, more, children }: { id: string /* owb-b5 (w5.1): the tab's own address; was SectionId | ChangesSectionId (F-OC-101) | MoneySectionId (F-OM-101), office types a shared part may not import */; title: string; answer?: ReactNode; asOf?: string | null; buttons?: readonly ReactNode[]; info?: ReactNode; more?: ReactNode; children: ReactNode }) {
  const { shown } = headButtonsOf(buttons ?? [])
  const headId = `fw-pt-h-${id}`
  return (
    <section id={id} className="fw-pt-sec fw-so-anchor" aria-labelledby={headId}>
      <Card padded>
        <div className="fw-pt-body">
          <div className="fw-pt-head">
            <div className="fw-pt-head-t">
              <h2 className="fw-pt-h2" id={headId}>
                {title}
              </h2>
              {answer ? <p className="fw-pt-answer">{answer}</p> : null}
            </div>
            <div className="fw-pt-head-r">
              {asOf ? <CountsAsOf at={asOf} /> : null}
              {shown}
              {more}
              {info ? <InfoTip section={title}>{info}</InfoTip> : null}
            </div>
          </div>
          {children}
        </div>
      </Card>
    </section>
  )
}

/** L2: "Counts as of 10:42" — the minute the piece counts were taken (the read's `asOf`), quiet, at the head's end. */
export function CountsAsOf({ at }: { at: string }) {
  const t = useT('orders')
  const locale = useLocale()
  return <span className="fw-pt-asof">{t('productionTab.countsAsOf', { time: formatTime(at, { locale }) })}</span>
}

/** The section's ONE ⓘ: what it means and its keys (a DS toggletip on a square icon button, like every ⋯ of the page). */
export function InfoTip({ section, children }: { section: string; children: ReactNode }) {
  const t = useT('orders')
  return (
    <DetailPopover trigger={<Info size={16} aria-hidden />} triggerLabel={t('productionTab.info', { section })} triggerClassName="nds-btn icon" label={t('productionTab.info', { section })} hoverDelay={0}>
      <div className="fw-pt-info">{children}</div>
    </DetailPopover>
  )
}

/** Reading: a few rows of skeleton in the part's own shape (never a spinner over the whole tab). */
export function PartReading({ rows = 2, height = 22 }: { rows?: number; height?: number }) {
  return (
    <div className="fw-pt-skel" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={height} />
      ))}
    </div>
  )
}

/** Failed: "Couldn't load {part}" with why and its own Try again — only this part; the rest of the tab still draws (B27, B45). */
export function PartFailed({ part, problem, onRetry }: { part: string; problem: string; onRetry?: () => void }) {
  const t = useT('orders')
  return (
    <Banner
      tone="danger"
      title={t('part.failed', { part })}
      action={
        onRetry ? (
          <Button size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        ) : undefined
      }
    >
      {t(problem)}
    </Banner>
  )
}

/** Empty or withheld: one quiet line of words. */
export function Quiet({ children }: { children: ReactNode }) {
  return <p className="fw-pt-quiet">{children}</p>
}

/**
 * fx5 #12: a unit in words — "pcs", "m", "ft²" — the catalogue's own (stock `uom.*`, the stock pages' words), never the code; a unit the
 * catalogue does not know: the code in small letters.
 */
export function useUnitWords(): (uom: string | null | undefined) => string {
  const s = useT('stock')
  return (uom) => {
    if (!uom) return ''
    const key = `uom.${uom}`
    const words = s(key)
    return words === key ? uom.toLowerCase() : words
  }
}
