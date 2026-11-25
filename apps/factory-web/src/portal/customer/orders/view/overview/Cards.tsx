'use client'

import type { ReactNode } from 'react'
import { Button, Pill } from '@nexus/ui/primitives'
import { CardState, Fact, FactCols, Group, GroupRow, Groups, OverviewCard, QuietLine, Row, RowAge, RowList, useOverviewWords } from '../../../../../lib/record-overview/Overview'
import { PiecesGrid } from '../../../../../lib/production/view/PiecesGrid'
import type { DatesModel, FactsModel, OverviewRow, PayModel, ProgressModel, RequestsModel } from '../../overview/model'
import { useOrderWords } from '../../words'
import type { OrderRecordActions } from '../OrderRecordView'
import type { ChangeRequest } from '../../api'

/**
 * pp-w2 (w2.2, w2.3; 10-design § 5.2–5.5) — the Overview's other cards, each the SHARED kit's `OverviewCard` with the kit's rows (no
 * look of their own): Progress by line (the shared PiecesGrid), Next dates (`RowList`), Requests & changes (`Groups`: who waits, ONE
 * Withdraw for every kind), What you pay (`RowList`, facts only: the Pay door is the deposit strip), Order facts (`FactCols`). Each
 * draws its model (overview/model.ts) and its doors; a card without its right is left out by the tab.
 */

/** 5.2 Progress by line: the pieces of its own cells per line and size; "Pieces as of 10:44". */
export function ProgressCard({ model, onRetry }: { model: ProgressModel; onRetry?: () => void }): ReactNode {
  if (model.state !== 'ready') return <CardState part={model.title} problem={model.failed} onRetry={onRetry} />
  return (
    <OverviewCard title={model.title} aside={model.asOf ? <span className="fw-ro-hint">{model.asOf}</span> : null}>
      <PiecesGrid colourways={model.colourways} />
    </OverviewCard>
  )
}

/** One row of a kit list: label | value (its chip, its quiet line) | its ONE door. */
function ListRow({ row }: { row: OverviewRow }): ReactNode {
  const kit = useOverviewWords()
  return (
    <Row
      label={row.label}
      doors={
        row.door ? (
          <Button asChild size="sm" variant="quiet">
            <a href={row.door.href}>{kit.door(row.door.words)}</a>
          </Button>
        ) : null
      }
    >
      <span className="fw-ro-stack">
        <span>
          {row.value}
          {row.chip ? (
            <>
              {' '}
              <Pill tone={row.chip.tone}>{row.chip.words}</Pill>
            </>
          ) : null}
        </span>
        {row.hint ? <span className="fw-ro-hint">{row.hint}</span> : null}
      </span>
    </Row>
  )
}

/** 5.3 Next dates: the requested date, our published plan, its gates and approvals — the promise is in Where (once). */
export function DatesCard({ model }: { model: DatesModel }): ReactNode {
  return (
    <OverviewCard title={model.title}>
      <RowList label={model.title}>
        {model.rows.map((row) => (
          <ListRow key={row.id} row={row} />
        ))}
        {model.none ? <QuietLine>{model.none}</QuietLine> : null}
      </RowList>
    </OverviewCard>
  )
}

/** 5.3 Requests & changes: by who waits — on you (our counter-offer), on us (ONE Withdraw, every kind: O1-B6), answered. */
export function RequestsCard({ model, items, actions }: { model: RequestsModel; items: readonly ChangeRequest[]; actions?: OrderRecordActions }): ReactNode {
  const { t } = useOrderWords()
  if (model.state !== 'ready') return <CardState part={model.title} problem={model.failed} onRetry={actions?.onRetryRequests} />
  return (
    <OverviewCard title={model.title}>
      {model.groups.length === 0 ? (
        <p className="fw-ro-hint">{model.nothing}</p>
      ) : (
        <Groups>
          {model.groups.map((group) => (
            <Group key={group.id} title={group.title}>
              {group.rows.map((row) => {
                const request = items.find((item) => item.id === row.id) ?? null
                return (
                  <GroupRow
                    key={row.id}
                    age={<RowAge since={row.since} words={row.age} title={row.askedDay} />}
                    doors={
                      row.withdraw && request ? (
                        <Button size="sm" variant="quiet" heldReason={row.withdraw.held} onClick={() => actions?.onWithdraw?.(request)}>
                          {t('requests.withdraw')}
                        </Button>
                      ) : row.door ? (
                        <Button asChild size="sm" variant="quiet">
                          <a href={row.door.href}>{row.door.words}</a>
                        </Button>
                      ) : null
                    }
                  >
                    <span className="fw-ro-stack" id={`change-request:${row.id}`}>
                      <span>
                        {row.what} <Pill tone={row.chip.tone}>{row.chip.words}</Pill>
                      </span>
                      {row.yourNote ? <span className="fw-ro-hint">{row.yourNote}</span> : null}
                      {row.answer ? <span className="fw-ro-hint">{row.answer}</span> : null}
                    </span>
                  </GroupRow>
                )
              })}
            </Group>
          ))}
        </Groups>
      )}
    </OverviewCard>
  )
}

/** 5.4 What you pay (price holders only): the order total, each deposit with its part paid, paid, still to pay. */
export function PayCard({ model }: { model: PayModel }): ReactNode {
  return (
    <OverviewCard title={model.title}>
      <RowList label={model.title}>
        {model.rows.map((row) => (
          <ListRow key={row.id} row={row} />
        ))}
      </RowList>
    </OverviewCard>
  )
}

/** 5.5 Order facts: no doors (a change is the band's Ask); the delivery address as its lines. */
export function FactsCard({ model }: { model: FactsModel }): ReactNode {
  return (
    <OverviewCard title={model.title}>
      <FactCols>
        {model.facts.map((fact) => (
          <Fact
            key={fact.id}
            label={fact.label}
            value={
              fact.lines && fact.lines.length > 1 ? (
                <span className="fw-ro-stack">
                  {fact.lines.map((line, index) => (
                    <span key={index}>{line}</span>
                  ))}
                </span>
              ) : (
                fact.value
              )
            }
            door={null}
          />
        ))}
      </FactCols>
    </OverviewCard>
  )
}
