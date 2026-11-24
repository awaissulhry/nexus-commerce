'use client'

import type { KeyboardEvent, ReactNode } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, RadioCard, Select, Toggle } from '@nexus/ui/primitives'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { listChoices } from '../../../terms/model'
import { depositWords } from '../../terms/commercial'
import { paymentTermsInForce, termsInForce } from '../../terms/in-force'
import { said } from '../../terms/model'
import type { TermsTabActions, TermsWindowsModel } from '../../terms/tab'
import { companyProblems, type CompanyEndWindow, type CompanyWindow } from '../../terms/windows'
import { WhoLine } from './ChangeTermsDialog'
import { useTermsSay } from './say'

/**
 * F-CT-307 (customer page › TERMS & REQUIREMENTS tab, lane ct-; 10-design §6.4, §6.5; 18-lead-settles Z11, Z26) — NEW windows of one of
 * our companies (centred DS Modals, md):
 *   Set terms for {company}         three pairs — payment terms · default deposit · price list (only with pricelists.manage) — "The
 *                                   customer's" ({its value}) / "Its own for {company}", then the PO switch. ONE command for that company
 *                                   (its terms row at its version; none yet: made), said for that company only.
 *   Customer PO number              a customer of ONE company: the same window with the PO switch only (data, never a look prop).
 *   Back to the customer's terms…   what it changes — only what is true — then Back to the customer's terms (R6). Never offered while
 *                                   a credit limit is set (held on the ⋯ item with its words).
 * Draws its model.
 */

export interface CompanyTermsProps {
  readonly window: CompanyWindow
  readonly windows: TermsWindowsModel
  readonly actions?: TermsTabActions | undefined
}

const saveOnKeys = (actions: TermsTabActions | undefined) => (event: KeyboardEvent<HTMLDivElement>) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    actions?.onWindowConfirm?.()
  }
}

export function CompanyTermsDialog(props: CompanyTermsProps) {
  const say = useTermsSay()
  const { window, windows, actions } = props
  const entry = windows.entry
  if (!entry) return null
  const company = entry.company.name
  const count = Object.keys(companyProblems(window, windows.can)).length
  const since = entry.terms ? said('ct.win.co.since', { days: { date: entry.terms.setAt } }) : said('ct.win.co.today')
  return (
    <Modal
      open
      size="md"
      busy={window.busy}
      onClose={() => actions?.onWindowClose?.()}
      title={say(window.poOnly ? said('sales-customers-depth:po.title') : said('ct.win.co.title', { params: { company } }))}
      subtitle={say(window.poOnly ? said('ct.win.po.sub', { params: { customer: windows.customer, company } }) : said('ct.win.co.sub', { params: { customer: windows.customer, company }, words: { since } }))}
      footer={
        <>
          <span className="fw-ctr-fnote">{say(window.poOnly ? said('ct.win.po.foot') : said('ct.win.co.foot', { params: { company } }))}</span>
          <span className="grow" />
          <Button onClick={() => actions?.onWindowClose?.()}>{say(said('parties:common.cancel'))}</Button>
          <Button variant="primary" heldReason={window.busy ? say(said('parties:common.saving')) : window.tried && count > 0 ? say(said('terms.fixFirst', { params: { count } })) : null} onClick={() => actions?.onWindowConfirm?.()}>
            {say(window.poOnly ? said('parties:common.save') : said('ct.win.co.save', { params: { company } }))}
          </Button>
        </>
      }
    >
      <div onKeyDown={saveOnKeys(actions)}>
        <CompanyTermsBody {...props} />
      </div>
    </Modal>
  )
}

/** The window's inside (a design case draws it on a plain card). */
export function CompanyTermsBody({ window, windows, actions }: CompanyTermsProps) {
  const say = useTermsSay()
  const locale = useLocale()
  const entry = windows.entry
  const own = windows.own
  if (!entry) return null
  const company = entry.company.name
  const draft = (next: Partial<CompanyWindow>) => actions?.onWindowDraft?.({ ...window, ...next })
  const problems: Partial<Record<'paymentTermsId' | 'depositPct' | 'priceListId', string>> = window.tried ? companyProblems(window, windows.can) : {}
  const po = (
    <div className="fw-ctr-sw">
      <Toggle checked={window.po} onChange={(on) => draft({ po: on })} aria-labelledby="ct-po-label" aria-describedby="ct-po-hint" />
      <span>
        <b id="ct-po-label">{say(said('ct.win.co.po'))}</b>
        <span id="ct-po-hint" className="fw-ctr-sub">
          {say(said('ct.win.co.poHint', { params: { company } }))}
        </span>
      </span>
    </div>
  )
  if (window.poOnly)
    return (
      <fieldset className="fw-ctr-win" disabled={window.busy}>
        {po}
        <WhoLine say={say} words={said('ct.win.po.oneCommand', { params: { company } })} info />
        {window.problem ? <Banner tone="danger" title={say(said(window.problem))} /> : null}
      </fieldset>
    )
  // The customer's own values, as each pair names them ("The customer's (Net 30 end of month)").
  const customer = { commercial: own, companies: null, companyId: null, typed: null }
  const theirTerms = paymentTermsInForce(customer, locale)
  const theirDeposit = depositWords(termsInForce(customer, locale))
  const library = windows.library?.status === 'ready' ? windows.library.value : []
  const current = entry.terms?.paymentTermsId && entry.terms.paymentTermsLabel && !library.some((row) => row.id === entry.terms!.paymentTermsId) ? [{ id: entry.terms.paymentTermsId, code: entry.terms.paymentTermsLabel.code, name: entry.terms.paymentTermsLabel.name }] : []
  const termsRows = [...current, ...library.map((row) => ({ id: row.id, code: row.code, name: row.nameI18n?.[locale] ?? row.name }))]
  const lists = windows.lists?.status === 'ready' ? windows.lists.value : null
  const listRows = listChoices(lists, { companyId: entry.company.id, priceList: null }, own?.currency ?? 'EUR')
  const reading = windows.library?.status === 'loading' || windows.lists?.status === 'loading'
  const pair = (name: string, legend: string, isOwn: boolean, theirs: string, set: (own: boolean) => void, field: ReactNode) => (
    <fieldset className="fw-ctr-fs">
      <legend className="fw-ctr-legend">{legend}</legend>
      <RadioCard name={`ct-co-${name}`} value="party" checked={!isOwn} selected={!isOwn} onChange={() => set(false)} title={say(said('ct.win.co.theirs'))} description={theirs} />
      <RadioCard name={`ct-co-${name}`} value="own" checked={isOwn} selected={isOwn} onChange={() => set(true)} title={say(said('ct.win.co.own', { params: { company } }))} />
      {isOwn ? field : null}
    </fieldset>
  )
  return (
    <fieldset className="fw-ctr-win" disabled={window.busy}>
      {windows.library?.status === 'error' || windows.lists?.status === 'error' ? (
        <Banner
          tone="warning"
          title={say(said('terms.choicesFailed'))}
          action={
            <Button size="sm" onClick={() => actions?.onRetryChoices?.()}>
              {say(said('common.retry'))}
            </Button>
          }
        />
      ) : null}
      {windows.can.paymentTerms
        ? pair(
            'terms',
            say(said('termsField.paymentTerms')),
            window.payment === 'own',
            theirTerms ? theirTerms.name : say(said('ct.com.ptNone')),
            (isOwn) => draft({ payment: isOwn ? 'own' : 'party' }),
            <Field label={say(said('ct.win.co.pick'))} error={problems.paymentTermsId ? say(said(problems.paymentTermsId)) : undefined}>
              <Select value={window.paymentTermsId} disabled={reading} onChange={(event) => draft({ paymentTermsId: event.target.value })}>
                <option value="">{say(said('ct.win.co.pickOne'))}</option>
                {termsRows.map((row) => (
                  <option key={row.id} value={row.id}>{`${row.code} · ${row.name}`}</option>
                ))}
              </Select>
            </Field>,
          )
        : null}
      {pair(
        'deposit',
        say(said('customer-money:cm.credit.deposit')),
        window.deposit === 'own',
        say(theirDeposit),
        (isOwn) => draft({ deposit: isOwn ? 'own' : 'party' }),
        <Field label={say(said('termsField.deposit'))} hint={say(said('ct.win.co.depositHint'))} error={problems.depositPct ? say(said(problems.depositPct)) : undefined}>
          <Input value={window.depositPct} inputMode="decimal" onChange={(event) => draft({ depositPct: event.target.value })} />
        </Field>,
      )}
      {windows.can.listsManage && windows.can.lists ? (
        pair(
          'list',
          say(said('termsField.priceList')),
          window.list === 'own',
          own?.priceList ? `${own.priceList.code} · ${own.priceList.name}` : say(said('ct.com.baseList')),
          (isOwn) => draft({ list: isOwn ? 'own' : 'party' }),
          <Field label={say(said('ct.win.co.pickList'))} error={problems.priceListId ? say(said(problems.priceListId)) : undefined}>
            <Select value={window.priceListId} disabled={reading} onChange={(event) => draft({ priceListId: event.target.value })}>
              <option value="">{say(said('ct.win.co.pickOne'))}</option>
              {listRows.map((row) => (
                <option key={row.id} value={row.id}>{`${row.code} · ${row.name}`}</option>
              ))}
            </Select>
          </Field>,
        )
      ) : (
        <WhoLine say={say} words={said('ct.win.listByColleague')} />
      )}
      {po}
      <WhoLine say={say} words={said('ct.win.co.oneCommand', { params: { company } })} info />
      {window.problem ? <Banner tone="danger" title={say(said(window.problem))} /> : null}
    </fieldset>
  )
}

export interface CompanyEndProps {
  readonly window: CompanyEndWindow
  readonly windows: TermsWindowsModel
  readonly actions?: TermsTabActions | undefined
}

/** "Back to the customer's terms with {company}?" — what it changes, then ONE command (R6). */
export function CompanyEndDialog(props: CompanyEndProps) {
  const say = useTermsSay()
  const { window, windows, actions } = props
  const entry = windows.entry
  if (!entry?.terms) return null
  const company = entry.company.name
  return (
    <Modal
      open
      size="md"
      busy={window.busy}
      onClose={() => actions?.onWindowClose?.()}
      title={say(said('ct.win.end.title', { params: { company } }))}
      subtitle={say(said('ct.win.end.sub', { params: { customer: windows.customer }, days: { date: entry.terms.setAt } }))}
      footer={
        <>
          <span className="grow" />
          <Button onClick={() => actions?.onWindowClose?.()}>{say(said('parties:common.cancel'))}</Button>
          <Button variant="primary" heldReason={window.busy ? say(said('parties:common.saving')) : null} onClick={() => actions?.onWindowConfirm?.()}>
            {say(said('ct.win.end.confirm'))}
          </Button>
        </>
      }
    >
      <CompanyEndBody {...props} />
    </Modal>
  )
}

export function CompanyEndBody({ window, windows }: CompanyEndProps) {
  const say = useTermsSay()
  const entry = windows.entry
  if (!entry) return null
  return (
    <div className="fw-ctr-win">
      <p className="fw-ctr-p">{say(said('ct.win.end.what', { params: { company: entry.company.name } }))}</p>
      <ul className="fw-ctr-lines">
        {windows.endLines.map((line, at) => (
          <li key={at} className={line.tone === 'warning' ? 'is-warning' : undefined}>
            {say(line.words)}
          </li>
        ))}
      </ul>
      {window.problem ? <Banner tone="danger" title={say(said(window.problem))} /> : null}
    </div>
  )
}
