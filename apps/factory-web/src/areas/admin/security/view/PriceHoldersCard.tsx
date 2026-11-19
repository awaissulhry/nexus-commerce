'use client'

import Link from 'next/link'
import { Lock, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { adminHref } from '../../shared/model'
import { useRoleWords } from '../../shared/view/parts'
import type { PriceHolders } from '../api'
import { grainsShown, MAKE_PRICE_ROLE, priceHolderCount, reachWords, type Read } from '../model'

export interface PriceHoldersCardProps {
  read: Read<PriceHolders>
  prefix: string
  /** roles.manage: "Make a role that sees prices only ›" opens New role on Finance; without it the link is held in words. */
  canMakeRole: boolean
  onRetry?: () => void
}

/**
 * F-CP-145 (customer page plan O3, the money wall; design 11-money §4.4) — Admin › Security › "Who sees prices": every office person
 * whose live role sees prices (the role, the money it sees, its reach — all customers or how many —, since and until when, the person's
 * two-factor set up or not, an invited or paused person said so) and every outside accountant (the firm, until when its access lasts).
 * "Only the Owner gives a role that sees prices." under the title (the API's rule since B-CP-011); "Make a role that sees prices only ›"
 * opens Admin › Roles with New role started on Finance (the Owner then keeps only the price); the footer "Only you and the people listed
 * here see our prices." The card exists only for a reader who sees prices (SecurityPage reads it then; else no card and no call).
 * Names, states and dates: never a price. Draws its read; fetches nothing.
 */
export function PriceHoldersCard({ read, prefix, canMakeRole, onRetry }: PriceHoldersCardProps) {
  const t = useT('admin-security')
  const ta = useT('admin')
  const locale = useLocale()
  const words = useRoleWords()
  if (read.state === 'no-right') return null
  const day = (value: string) => formatDate(value, { locale })
  const make = canMakeRole ? (
    <Button size="sm" variant="quiet" asChild>
      <Link href={adminHref(prefix, MAKE_PRICE_ROLE)}>{t('sec.priceHolders.make')}</Link>
    </Button>
  ) : (
    <Button size="sm" variant="quiet" heldReason={t('sec.priceHolders.makeHeld')}>
      {t('sec.priceHolders.make')}
    </Button>
  )
  const value = read.state === 'ok' ? read.value : null
  const rows = (value?.people ?? []).flatMap((person) =>
    person.roles.map((role, index) => ({
      id: role.assignmentId,
      cells: [
        <span key="person" className="fw-sec-fact">
          {index === 0 ? <strong>{person.name}</strong> : <span className="fw-adm-hint">{person.name}</span>}
          {person.status !== 'ACTIVE' && <Tag tone="warning">{ta(`users.status.${person.status}`)}</Tag>}
        </span>,
        <span key="role" className="fw-sec-fact">
          <span>{words.name(role)}</span>
          {!role.system && <Tag tone="info">{t('sec.tf.custom')}</Tag>}
        </span>,
        <span key="sees" className="fw-sec-fact" aria-label={ta('grains.labelOf', { name: words.name(role) })}>
          {grainsShown(role).map((grain) => (
            <Tag key={grain} tone="success">
              {ta(`grains.short.${grain}`)}
            </Tag>
          ))}
        </span>,
        reachWords(role)
          .map((entry) => t(entry.key, entry.params))
          .join(' · '),
        role.until ? t('sec.priceHolders.sinceUntil', { since: day(role.since), until: day(role.until) }) : t('sec.priceHolders.since', { since: day(role.since) }),
        person.twoFactor ? (
          <Tag key="mfa" tone="success">
            <ShieldCheck size={12} aria-hidden /> {t('sec.priceHolders.twoFactor.yes')}
          </Tag>
        ) : (
          <Tag key="mfa" tone="warning">
            <ShieldAlert size={12} aria-hidden /> {t('sec.priceHolders.twoFactor.no')}
          </Tag>
        ),
      ],
    })),
  )
  return (
    <section id="prices" aria-labelledby="sec-prices" className="fw-sec-section">
      <Card header={<span id="sec-prices">{t('sec.priceHolders.title')}</span>} description={t('sec.priceHolders.hint')} headingLevel={2} padded headerAction={make}>
        {read.state === 'loading' ? (
          <div className="fw-adm-skeleton" aria-busy="true">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} height={20} />
            ))}
          </div>
        ) : read.state === 'failed' ? (
          <EmptyState
            title={t('sec.failed.title')}
            description={t('sec.priceHolders.failed')}
            action={
              <Button size="sm" onClick={() => onRetry?.()}>
                {t('sec.retry')}
              </Button>
            }
          />
        ) : (
          <div className="fw-adm-stack">
            <p className="fw-adm-hint" role="status">
              {t('sec.priceHolders.count', { count: priceHolderCount(value!) })}
            </p>
            {rows.length > 0 && (
              <SummaryTable
                label={t('sec.priceHolders.tableLabel')}
                columns={[t('sec.priceHolders.col.person'), t('sec.priceHolders.col.role'), t('sec.priceHolders.col.sees'), t('sec.priceHolders.col.reach'), t('sec.priceHolders.col.since'), t('sec.priceHolders.col.twoFactor')]}
                widths={['20%', '18%', '18%', '16%', '14%', '14%']}
                align={['left', 'left', 'left', 'left', 'left', 'left']}
                rows={rows}
                density="roomy"
                stackOnPhone
              />
            )}
            <h3 className="fw-sec-sub">{t('sec.priceHolders.guests.title')}</h3>
            {value!.guests.length === 0 ? (
              <p className="fw-adm-hint">{t('sec.priceHolders.guests.none')}</p>
            ) : (
              <ul className="fw-sec-people" aria-label={t('sec.priceHolders.guests.label')}>
                {value!.guests.map((guest) => (
                  <li key={guest.userId}>
                    <span className="fw-sec-fact">
                      <strong>{guest.name}</strong>
                      <span className="fw-adm-hint">{guest.firm?.name ? t('sec.priceHolders.guests.firm', { firm: guest.firm.name }) : t('sec.priceHolders.guests.noFirm')}</span>
                      {guest.status !== 'ACTIVE' && <Tag tone="warning">{ta(`users.status.${guest.status}`)}</Tag>}
                    </span>
                    <span className="fw-adm-hint">{guest.until ? t('sec.priceHolders.guests.until', { date: day(guest.until) }) : t('sec.priceHolders.guests.noEnd')}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="fw-adm-hint fw-sec-fact">
              <Lock size={13} aria-hidden /> {t('sec.priceHolders.foot')}
            </p>
          </div>
        )}
      </Card>
    </section>
  )
}
