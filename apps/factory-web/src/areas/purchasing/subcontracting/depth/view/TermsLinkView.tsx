'use client'

import { Download, FileSignature } from 'lucide-react'
import { Banner, Card } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayAt } from '../../../../_shared/buying/model'
import { say } from '../../model'
import { DEPTH, downloadHeld, termsGap, type TermsActions, type TermsModel } from '../model'
import '../depth.css'

/**
 * The written terms link of a subcontract order (design purchasing.subcontracting › Operations & quantities "Written
 * terms link (W2b)"; SCM-049, L. 192/1998 art. 2): the signed revision whose days hold the order's date — its number,
 * title, when it was signed, the days it covers, whether it was replaced or ended since, whether the one in force ends
 * soon — with "Download the signed terms" (files.read; held with why), or, when none covers the order, why not in words
 * (a revision waiting for its signature, none written, the signed ones cover other days) beside the law. Loading draws
 * skeleton lines; a failed read says so with Try again (never drawn as "no terms").
 */
export function TermsLinkView({ model, actions }: { model: TermsModel; actions?: TermsActions }) {
  return (
    <WithMessages namespaces={[DEPTH]}>
      <Terms model={model} actions={actions} />
    </WithMessages>
  )
}

function Terms({ model, actions }: { model: TermsModel; actions?: TermsActions }) {
  const t = useT(DEPTH)
  const ds = useDsWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const head = (law: string | null) => (
    <div className="fw-by-card-head">
      <h3 className="fw-by-h3">
        <FileSignature size={14} aria-hidden /> {t('terms.title')}
      </h3>
      {law && <LawRef law={law} plain={t('terms.lawPlain')} labels={ds.lawRef} />}
    </div>
  )
  const loaded = model.terms
  if (loaded.status === 'loading') {
    return (
      <Card padded aria-busy="true">
        <div className="fw-by-stack">
          {head(null)}
          <span className="fw-by-hint" role="status">
            {model.slow ? t('terms.slow') : t('terms.loading')}
          </span>
          <Skeleton height={18} width="60%" />
        </div>
      </Card>
    )
  }
  if (loaded.status !== 'ready') {
    return (
      <Card padded>
        <div className="fw-by-stack">
          {head(null)}
          <Banner
            tone="danger"
            title={t('terms.failed')}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          >
            {t(loaded.status === 'error' ? loaded.problem : loaded.status === 'forbidden' ? 'problem.forbidden' : 'problem.gone')}
          </Banner>
        </div>
      </Card>
    )
  }
  const terms = loaded.value
  const covering = terms.covering
  const gap = termsGap(terms)
  const date = (day: string) => formatDate(dayAt(day), place)
  if (!covering) {
    const why = gap ?? { kind: 'none' as const }
    return (
      <Card padded>
        <div className="fw-by-stack">
          {head(terms.law)}
          <Banner tone="warning" title={t('terms.none.base', { workshop: terms.order.workshop.name, date: date(terms.order.orderDate) })}>
            {why.kind === 'draft' ? t('terms.none.draft', { revision: why.revision }) : t(`terms.none.${why.kind}`)}
          </Banner>
        </div>
      </Card>
    )
  }
  const reason = downloadHeld(terms, model.can)
  // Not held while the link is fetched (the focus stays on the button; a second press is ignored by the container).
  const held = reason ? say(t, reason) : null
  const valid = covering.validUntil ? t('terms.valid', { from: date(covering.validFrom), until: date(covering.validUntil) }) : t('terms.validOpen', { from: date(covering.validFrom) })
  return (
    <Card padded>
      <div className="fw-by-stack">
        {head(terms.law)}
        <div className="fw-scd-terms">
          <span className="fw-by-cell">
            <span className="fw-by-text">{t('terms.covered', { revision: covering.revision, title: covering.title })}</span>
            <span className="fw-by-cell-sub">
              {covering.signedAt ? t('terms.signed', { date: formatDate(covering.signedAt, place) }) : null} · {valid}
            </span>
          </span>
          <span className="fw-by-inline">
            {covering.status === 'SUPERSEDED' && <Tag tone="neutral">{t('terms.superseded')}</Tag>}
            {covering.status === 'TERMINATED' && <Tag tone="warning">{t('terms.terminated')}</Tag>}
            {covering.inForceToday && covering.expiresInDays !== null && <Tag tone="warning">{t('terms.ending', { count: covering.expiresInDays })}</Tag>}
            <Button size="sm" variant="secondary" heldReason={held} onClick={() => covering.file && actions?.onDownload?.(covering.file.id)}>
              <Download size={13} aria-hidden /> {t('terms.download')}
            </Button>
          </span>
        </div>
        {covering.status === 'SUPERSEDED' && <p className="fw-by-hint">{t('terms.supersededBody')}</p>}
        {model.problem && <Banner tone="danger" title={say(t, model.problem)} />}
      </div>
    </Card>
  )
}
