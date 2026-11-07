'use client'

import { Printer } from 'lucide-react'
import { Banner, SummaryTable } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { WithMessages } from '../../../../../record-panels/i18n'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { PersonCard } from '../../api'
import { categoryMark, itemName } from '../../model'
import '../../ppe.css'
import { NoPpeAccess, PPE_NAMESPACES, useDay, useWhen, useWords } from '../../view/parts'

/** SCR-211-card — the PPE card window's view model: one card per person asked (Gaps › card, Print PPE cards). */
export interface CardTabModel {
  readonly canView: boolean
  /** When it was printed and by whom (the card says so). */
  readonly at: string
  readonly person: string
  readonly cards: readonly { readonly id: string; readonly value: PersonCard | null; readonly problem: string | null }[]
}

/**
 * tab:card — "Person PPE card (print)" (design plant.ppe new tab, "For the person's file"): per person, their role and its kit
 * against what they hold (needed, held, missing, past its life, when to wear), every receipt with its lines and void marks and
 * how it was signed, and the leaver step "PPE returned" when they are leaving. One card per printed page; Print is not printed.
 * Names only the person the card is about (a legal register, art. 77 c.4).
 */
export function CardTabView({ model }: { model: CardTabModel }) {
  return (
    <WithMessages namespaces={PPE_NAMESPACES}>
      <Cards model={model} />
    </WithMessages>
  )
}

function Cards({ model }: { model: CardTabModel }) {
  const t = useWords()
  const when = useWhen()
  if (!model.canView) return <NoPpeAccess />
  const ready = model.cards.filter((entry) => entry.value).length
  return (
    <article className="fw-ppe-tab">
      <div className="fw-ppe-tab-band fw-ppe-noprint">
        <h1 className="fw-ppe-h">{model.cards.length === 1 && model.cards[0]?.value ? t('card.titleOne', { name: model.cards[0].value.employee.name }) : t('card.title', { count: model.cards.length })}</h1>
        <Button size="sm" variant="primary" heldReason={ready === 0 ? t('card.held') : null} onClick={() => window.print()}>
          <Printer size={13} aria-hidden /> {t('card.print')}
        </Button>
      </div>
      {model.cards.length === 0 && <Banner tone="info" title={t('card.none')} />}
      {model.cards.map((entry) =>
        entry.problem ? (
          <Banner key={entry.id} tone="danger" title={t('card.failed')}>
            {t(entry.problem)}
          </Banner>
        ) : !entry.value ? (
          <p key={entry.id} className="fw-ppe-muted" role="status">
            <Spinner size={14} /> {t('common.reading')}
          </p>
        ) : (
          <Card key={entry.id} card={entry.value} />
        ),
      )}
      <p className="fw-ppe-muted">{t('card.printed', { at: when(model.at), person: model.person })}</p>
    </article>
  )
}

function Card({ card }: { card: PersonCard }) {
  const t = useWords()
  const locale = useLocale()
  const ds = useDsWords()
  const day = useDay()
  const when = useWhen()
  const { employee } = card
  return (
    <section className="fw-ppe-card" aria-label={t('card.of', { name: employee.name })}>
      <div className="fw-ppe-head">
        <span className="fw-ppe-head-title">
          <h2 className="fw-ppe-h">{employee.name}</h2>
          <span className="fw-ppe-muted">{[employee.employeeCode, employee.site.name, card.role?.name ?? t('gaps.noRole')].filter(Boolean).join(' · ')}</span>
        </span>
        <span className="fw-ppe-row">
          <LawRef law={card.law.issue} plain={t('law.issue')} labels={ds.lawRef} />
          <LawRef law={card.law.receipt} plain={t('law.receipt')} labels={ds.lawRef} />
        </span>
      </div>
      {employee.status !== 'ACTIVE' && <p className="fw-ppe-muted">{t('card.notActive')}</p>}

      <h3 className="fw-ppe-h3">{card.role ? t('card.kit', { role: card.role.name }) : t('card.noKit')}</h3>
      {card.kit.length > 0 ? (
        <SummaryTable
          label={t('card.kitLabel')}
          columns={[t('card.col.item'), t('card.col.category'), t('card.col.needed'), t('card.col.held'), t('card.col.missing'), t('card.col.replace'), t('card.col.when')]}
          align={[undefined, undefined, 'right', 'right', 'right', 'right', 'left']}
          stackOnPhone
          rows={card.kit.map((line) => ({
            id: line.ppeItemId,
            cells: [`${line.item.code} · ${itemName(line.item, locale)}`, categoryMark(line.item.category), String(line.quantity), String(line.held), String(line.missing), String(line.replace), line.whenToWear || t('kits.always')],
          }))}
        />
      ) : card.role ? (
        <p className="fw-ppe-muted">{t('card.emptyKit')}</p>
      ) : null}

      <h3 className="fw-ppe-h3">{t('card.receipts', { count: card.receipts.length })}</h3>
      {card.receipts.length > 0 ? (
        <SummaryTable
          label={t('card.receiptsLabel')}
          columns={[t('card.col.date'), t('card.col.signed'), t('card.col.lines'), t('card.col.units')]}
          align={[undefined, undefined, undefined, 'right']}
          widths={['18%', '24%', undefined, '10%']}
          stackOnPhone
          rows={card.receipts.map((receipt) => ({
            id: receipt.id,
            cells: [
              when(receipt.issuedAt),
              `${t(`method.${receipt.method}`)} · ${t(`receiptState.${receipt.state}`)}`,
              receipt.lines.map((line) => `${itemName(line.item, locale)}${line.size ? ` ${line.size}` : ''} ×${line.quantity}${line.voided ? ` (${t('issues.voided')})` : ''}`).join('; '),
              String(receipt.units),
            ],
          }))}
        />
      ) : (
        <p className="fw-ppe-muted">{t('card.noReceipts')}</p>
      )}

      {card.returned && (
        <p className="fw-ppe-muted">{card.returned.status === 'DONE' && card.returned.doneAt ? t('card.returnedOn', { date: day(card.returned.doneAt) }) : t('card.returnedOpen')}</p>
      )}
    </section>
  )
}
