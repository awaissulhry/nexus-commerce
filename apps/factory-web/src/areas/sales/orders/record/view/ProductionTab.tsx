'use client'

import Link from 'next/link'
import { Card } from '@nexus/ui/components'
import { Skeleton } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Order } from '../../api'
import { dayInstant } from '../../model'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
import { readOf } from '../overview/model'
// ---- F-SA-235: Holds, quality & problems, Materials (the customer-supplied materials card, moved from Lines), Specs in force (the
// tech pack in force, moved from the tab's foot). F-PT-102: the order's health moved into Production now (one strip, shared rule). ----
import { Lock } from 'lucide-react'
import { useProductionWords } from '../../../../../lib/production/words'
import { MaterialsCard } from '../../materials/view/MaterialsCard'
import { TechPackCard } from '../../confirmation/view/ConfirmationCard'
import { say } from '../overview/model'
// ---- end F-SA-235
// F-SA-266: Discuss on Production's rows — holds and quality in office notes only (never a reply), a line's dates by its reference.
import { DiscussDoor } from './Discuss'
// ---- F-PT-101 … F-PT-105 (order PRODUCTION tab, W1): the layout, Production now, Work orders (one file per section, view/production) ----
import { NowSection } from './production/NowSection'
import { WorkOrdersSection } from './production/WorkOrdersSection'
import { DatesSection } from './production/DatesSection' // F-PT-201 … 204: Dates, Milestones and Promise moves in one section
import './production/production.css'
// ---- end F-PT-101

/** The readiness words are the production lane's (`production-work-orders` readiness.*), reused in place. */
const WORK_ORDERS_NS = 'production-work-orders'

/**
 * F-PT-101 (order PRODUCTION tab, 10-design §1; 18-lead-settles L10) — the tab's LAYOUT: its root is a size container (production.css:
 * every section chooses by the room the tab has, never the screen — the thread dock opening or closing re-lays it at once), the six
 * sections top to bottom with their addresses: Production now (#now) · Work orders (#work-orders) · Dates & plan (#dates) · Problems &
 * holds (#holds) | What we make it to (#specs) — side by side from 900 px — · Materials (#materials). Each section is its own file
 * (view/production/*); the cards below that W3 – W4 replace stay here until then (one path per job: each goes when its section lands).
 * F-PT-201 … 204: Dates & plan (#dates, with #promise-moves) replaced the Dates card, the milestones' card and Promise moves.
 */
export function ProductionTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  return (
    <WithMessages namespaces={[WORK_ORDERS_NS, 'production' /* F-SA-235 · F-PT-102: the health's and the stages' words */]}>
      <div className="fw-pt">
        <NowSection order={order} model={model} actions={actions} />
        <WorkOrdersSection order={order} model={model} actions={actions} />
        <DatesSection order={order} model={model} actions={actions} />
        {/* F-SA-235: what holds it, its quality and its problems; the specs it is made to — F-PT-101 (L10): a pair by the tab's room. */}
        <div className="fw-pt-pairs">
          <HoldsQualityCard order={order} model={model} />
          <div id="specs" className="fw-so-anchor">
            <SpecsCard order={order} model={model} actions={actions} />
          </div>
        </div>
        <section id="materials" className="fw-so-anchor">
          <MaterialsCard order={order} model={model.depth} actions={actions?.depth} prefix={model.prefix} />
        </section>
      </div>
    </WithMessages>
  )
}

/**
 * P3 Holds, quality & problems (F-PT-102: the order's health moved into Production now — one strip, the shared mark rule): what holds its work (in plain words; the office's note per work
 * order with workorders.view, never shared), the open problems that need an answer, the final inspections and the NCRs of its own
 * work orders. Each block without its right is held in one line of words — never an empty list that looks like "none". A hold that
 * serves several customers names none of the others (the read's own words).
 */
function HoldsQualityCard({ order, model }: { order: Order; model: OrderRecordModel }) {
  const t = useT('orders')
  const w = useProductionWords()
  const locale = useLocale()
  const read = readOf(model.production)
  const headline = read?.headline ?? null
  const quality = read?.quality ?? null
  const withheld = new Set(read?.withheld ?? [])
  const holds = headline?.holds ?? []
  const notes = headline?.holdNotes ?? null
  const issues = quality?.issues ?? null
  const ncrs = quality?.ncrs ?? null
  const finals = quality?.final ?? null
  // "Nothing" only when every block was read and is empty (a block held back is never "none").
  const none = (list: readonly unknown[] | null) => list !== null && list.length === 0
  const nothing = !!read && holds.length === 0 && none(issues) && none(ncrs) && none(finals)
  const ncrHref = (id: string, number: string) => `${model.prefix}${recordAddress({ type: 'Nonconformance', id, label: number, companyId: order.companyId }, OFFICE_PAGES)}`
  return (
    <div className="fw-so-stack">
      {/* F-OP-115 (A11's Overview doors): the address #holds lands here. */}
      <Card padded id="holds" className="fw-so-anchor">
        <h2 className="fw-so-h2">{t('production.quality.title')}</h2>
        {!read ? (
          <Skeleton height={44} />
        ) : (
          <div className="fw-so-stack">
            {holds.map((hold, index) => (
              <div key={`${hold.kind}-${index}`} className="fw-so-cell">
                <span>{w.t('parts.hold.office.titleWhy', { date: w.day(hold.since), reason: say(hold.words, locale) })}</span>
                <span className="fw-so-cell-sub">{w.t(`parts.hold.office.${hold.kind}`)}</span>
              </div>
            ))}
            {notes && notes.length > 0 && (
              <ul className="fw-so-datelist" aria-label={t('production.quality.notes')}>
                {notes.map((note) => (
                  <li key={`${note.workOrderId}-${note.since}`}>
                    <span className="fw-so-inline">
                      <Lock size={12} aria-hidden /> <strong>{note.number}</strong> {note.note}
                      {/* F-SA-266: a hold is discussed in an office note only. */}
                      <DiscussDoor order={order} part={t('discuss.hold', { number: note.number })} target={{ kind: 'WorkOrder', id: note.workOrderId }} officeOnly />
                    </span>
                    <span className="fw-so-cell-sub">{t('production.quality.officeOnly', { date: formatDate(note.since, { locale }) })}</span>
                  </li>
                ))}
              </ul>
            )}
            {issues === null ? (
              withheld.has('quality.issues') && <p className="fw-so-hint">{t('production.quality.issuesHeld')}</p>
            ) : issues.length > 0 ? (
              <div className="fw-so-stack">
                <h3 className="fw-so-h3">{t('production.quality.needsAnswer', { count: issues.length })}</h3>
                <ul className="fw-so-datelist">
                  {issues.map((issue) => (
                    <li key={issue.id}>
                      <span>{t('production.quality.issue', { since: formatDate(issue.since, { locale }), due: formatDate(dayInstant(issue.dueOn), { locale }) })}</span>
                      {issue.escalation > 0 && <span className="fw-so-cell-sub">{t('production.quality.escalated', { count: issue.escalation })}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {ncrs === null ? (
              withheld.has('quality.ncrs') && <p className="fw-so-hint">{t('production.quality.ncrsHeld')}</p>
            ) : ncrs.length > 0 ? (
              <p className="fw-so-inline">
                <span>{t('production.quality.ncrs', { count: ncrs.length })}</span>
                {ncrs.map((ncr) => (
                  <Link key={ncr.id} className="fw-so-link" href={ncrHref(ncr.id, ncr.number)}>
                    {ncr.number}
                  </Link>
                ))}
              </p>
            ) : null}
            {finals === null ? (
              withheld.has('quality.final') && <p className="fw-so-hint">{t('production.quality.finalHeld')}</p>
            ) : finals.length > 0 ? (
              <ul className="fw-so-datelist" aria-label={t('production.quality.final')}>
                {finals.map((entry) => (
                  <li key={entry.workOrderId}>
                    <span className="fw-so-inline">
                      {t('production.quality.finalRow', { number: entry.number ?? '—', checked: entry.sampleSize })}
                      {/* F-SA-266: quality is discussed in an office note only. */}
                      <DiscussDoor order={order} part={t('discuss.quality', { number: entry.number ?? '—' })} target={{ kind: 'WorkOrder', id: entry.workOrderId }} officeOnly />
                    </span>
                    <span className="fw-so-cell-sub">{t(`production.quality.finalState.${entry.status === 'PASSED' || entry.status === 'FAILED' ? entry.status : 'WAITING'}`, { date: entry.on ? formatDate(dayInstant(entry.on), { locale }) : '—' })}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {nothing && <p className="fw-so-hint">{t('production.quality.nothing')}</p>}
          </div>
        )}
      </Card>
    </div>
  )
}

/**
 * P5 Specs in force: the revision of each style the order is made to (as the order fixes it; else the work order chooses), and the
 * customer's tech pack in force (the request's files: named vs newer, opened in the viewer). An open design change has its place
 * here once the change flow lands (S4).
 */
function SpecsCard({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const styles = [...new Map(order.lines.map((line) => [line.styleId, line])).values()]
  return (
    <div className="fw-so-stack">
      <Card padded>
        <h2 className="fw-so-h2">{t('production.specs.title')}</h2>
        <ul className="fw-so-datelist">
          {styles.map((line) => (
            <li key={line.styleId}>
              <span>{`${line.style?.code ?? '—'} · ${line.style?.name ?? ''}`}</span>
              <span className="fw-so-cell-sub">{line.styleRevision ? t('lines.revision', { revision: line.styleRevision.revision }) : t('lines.noRevision')}</span>
            </li>
          ))}
        </ul>
      </Card>
      <TechPackCard model={model.depth} actions={actions?.depth} />
    </div>
  )
}
// ---- end F-SA-235
