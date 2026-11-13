'use client'

import Link from 'next/link'
import { FileImage } from 'lucide-react'
import { Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { ReadState, Section } from '../../../../quality/_shared/parts'
import type { ProfileRecord } from '../../api'
import { quoteHref, unitQuotes } from '../../model'
import { useWords } from '../../parts'
import type { ProfileRecordModel } from '../view-model'

/**
 * The rider profile's Proofs tab (design rider.proofs, "Colour and graphic layouts sent to the rider for a yes"): a rider's proofs
 * travel with the quote they are signed with (B-W2b-165): every proof of the quotes the rider's units are on, per version — the
 * proof (PDF or picture), whether it was sent (shared with the customer by the send), and the decision on the accept link (accepted
 * by whom and when, or not yet). "Send proof (link)" is the quote's own: proofs are added on its Documents tab and go with its send.
 */
export function ProofsTab({ model, record }: { model: ProfileRecordModel; record: ProfileRecord }) {
  const { t, when } = useWords()
  const quotes = unitQuotes(record.units)
  const send = quotes[0] ? (
    <Button size="sm" variant="primary" asChild>
      <Link href={quoteHref(model.prefix, quotes[0].id, 'documents')}>{t('proofs.send', { number: quotes[0].number })}</Link>
    </Button>
  ) : (
    <Button size="sm" variant="primary" heldReason={t('proofs.sendHeld')} onClick={() => undefined}>
      {t('proofs.sendNone')}
    </Button>
  )
  const head = (
    <div className="fw-mtm-head">
      <p className="fw-mtm-hint">{t('proofs.intro')}</p>
      <div className="fw-mtm-actions">{send}</div>
    </div>
  )
  if (!model.can.quotesView)
    return (
      <div className="fw-mtm-stack">
        {head}
        <Card padded>
          <EmptyState title={t('proofs.noRight')} description={t('held.right', { right: t('right.quotesView') })} />
        </Card>
      </div>
    )
  if (quotes.length === 0)
    return (
      <div className="fw-mtm-stack">
        {head}
        <Card padded>
          <EmptyState icon={<FileImage size={20} aria-hidden />} title={t('proofs.none')} description={t('proofs.noneBody')} />
        </Card>
      </div>
    )
  if (model.proofs.problem || model.proofs.items === null)
    return (
      <div className="fw-mtm-stack">
        {head}
        <ReadState problem={model.proofs.problem} loading={model.proofs.items === null && !model.proofs.problem} failedTitle={t('proofs.failed')} />
      </div>
    )
  const lines = model.proofs.items
  return (
    <div className="fw-mtm-stack">
      {head}
      <Section id="proofs" title={t('proofs.title')} sub={t('proofs.sub', { count: quotes.length })}>
        {lines.length === 0 ? (
          <EmptyState title={t('proofs.none')} description={t('proofs.noneOnQuotes')} />
        ) : (
          <SummaryTable
            label={t('proofs.title')}
            stackOnPhone
            density="roomy"
            columns={[t('proofs.col.proof'), t('proofs.col.quote'), t('proofs.col.sent'), t('proofs.col.decision')]}
            widths={['34%', '22%', '18%', undefined]}
            rows={lines.map((line) => ({
              id: line.key,
              cells: [
                <span key="p" className="fw-mtm-row">
                  <Tag tone="neutral">{t(`shape.${line.shape}`)}</Tag>
                  <span>{line.name}</span>
                  {line.state !== 'READY' && <Tag tone={line.state === 'REFUSED' ? 'danger' : 'warning'}>{t(`proofState.${line.state}`)}</Tag>}
                </span>,
                <Link key="q" className="fw-mtm-link" href={quoteHref(model.prefix, line.quoteId, 'documents')}>
                  {t('proofs.quoteVersion', { number: line.number, revision: line.revision })}
                </Link>,
                line.shared ? t('proofs.sentOn', { when: when(line.sentAt) }) : t('proofs.notSent'),
                line.accepted ? (
                  <Pill key="d" tone="success">
                    {t('proofs.accepted', { name: line.accepted.signer ?? t('proofs.theCustomer'), when: when(line.accepted.at) })}
                  </Pill>
                ) : (
                  <Pill key="d" tone={line.shared ? 'warning' : 'neutral'}>
                    {line.shared ? t('proofs.waiting') : t('proofs.draft')}
                  </Pill>
                ),
              ],
            }))}
          />
        )}
      </Section>
    </div>
  )
}
