'use client'

import { Printer } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { QrCode } from '@nexus/ui/components/QrCode/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Read } from '../../../_shared/model'
import type { Hold } from '../../api'
import { nounKey, ownerWords, quantityWords, reasonText } from '../../model'
import { HoldsMessages } from '../../view/parts'

/** SCR-078-tag — the hold tags on paper: one view model, nothing fetched. */
export interface HoldTagsModel {
  readonly me: string
  readonly person: string
  readonly at: string
  /** The address a tag's QR opens (the hold in its DetailModal), by hold id. */
  readonly addressOf: Readonly<Record<string, string>>
  readonly holds: Read<readonly Hold[]>
  readonly reasons: ReadonlyMap<string, { labelIt: string; labelEn: string }>
}

/**
 * Quality › Holds › Hold tag (design quality.holds/tab:qh-tag "Hold tag (label PDF)", a new tab): one tag per hold to
 * stick on the goods — "ON HOLD" big, what is held (kind and codes), why, since when, the owner, the hold's address as a
 * QR (a phone or a station's scanner opens the hold), and "Do not use until quality releases it". Printed from the
 * browser (it saves it as a PDF too): the API has no label PDF for a hold yet, so this print page stands in for it.
 */
export function HoldTagsView({ model }: { model: HoldTagsModel }) {
  return (
    <HoldsMessages>
      <Tags model={model} />
    </HoldsMessages>
  )
}

function Tags({ model }: { model: HoldTagsModel }) {
  const t = useT('holds')
  const q = useT('quality')
  const locale = useLocale()
  const holds = model.holds.value
  const labels = { copy: t('tag.copy'), copied: t('tag.copied'), copyFailed: t('tag.copyFailed'), loading: q('common.loading'), tooLong: t('tag.tooLong') }
  return (
    <article className="fw-hd-print">
      <header className="fw-hd-print-head">
        <h1 className="fw-hd-print-title">{t('tag.title', { count: holds?.length ?? 0 })}</h1>
        <p className="fw-q-hint">{t('tag.meta', { at: formatDateTime(model.at, { locale }), person: model.person })}</p>
        <Button className="fw-hd-print-button" variant="secondary" onClick={() => window.print()} heldReason={holds && holds.length > 0 ? null : t('tag.held')}>
          <Printer size={14} aria-hidden /> {t('tag.print')}
        </Button>
      </header>
      {model.holds.problem ? (
        <Banner tone="danger" title={t('tag.failed')}>
          {q(model.holds.problem)}
        </Banner>
      ) : !holds ? (
        <p className="fw-q-loading" role="status">
          <Spinner size={14} /> {q('common.loading')}
        </p>
      ) : holds.length === 0 ? (
        <p className="fw-q-hint">{t('tag.none')}</p>
      ) : (
        <div className="fw-hd-tags">
          {holds.map((hold) => {
            const owner = ownerWords(hold, model.me)
            return (
              <section key={hold.id} className="fw-hd-tag" aria-label={t('tag.one', { code: hold.subjects[0]?.label ?? '—' })}>
                <p className="fw-hd-tag-big">{t('tag.onHold')}</p>
                <p className="fw-hd-tag-what">
                  {hold.subjects.length} {t(nounKey(hold.subjectType), { count: hold.subjects.length })}
                </p>
                <p className="fw-hd-tag-codes fw-q-code">{hold.subjects.map((subject) => subject.label ?? '—').join(' · ')}</p>
                <dl className="fw-q-facts">
                  <div className="fw-q-fact">
                    <dt>{t('tag.reason')}</dt>
                    <dd>{reasonText(hold, model.reasons, locale)}</dd>
                  </div>
                  <div className="fw-q-fact">
                    <dt>{t('tag.since')}</dt>
                    <dd>{formatDate(hold.placedAt, { locale })}</dd>
                  </div>
                  <div className="fw-q-fact">
                    <dt>{t('tag.owner')}</dt>
                    <dd>{t(owner.key, owner.params)}</dd>
                  </div>
                  {hold.quantity && (
                    <div className="fw-q-fact">
                      <dt>{t('tag.quantity')}</dt>
                      <dd>{quantityWords(hold.quantity, t)}</dd>
                    </div>
                  )}
                  {hold.quarantineLocation && (
                    <div className="fw-q-fact">
                      <dt>{t('tag.place')}</dt>
                      <dd>{hold.quarantineLocation.code}</dd>
                    </div>
                  )}
                </dl>
                <div className="fw-hd-tag-foot">
                  <QrCode value={model.addressOf[hold.id] ?? hold.id} code={hold.subjects[0]?.label ?? undefined} label={t('tag.qr', { code: hold.subjects[0]?.label ?? '—' })} size={112} labels={labels} />
                  <p className="fw-hd-tag-warn">{t('tag.doNotUse')}</p>
                </div>
              </section>
            )
          })}
        </div>
      )}
      <p className="fw-q-hint">{t('tag.foot')}</p>
    </article>
  )
}
