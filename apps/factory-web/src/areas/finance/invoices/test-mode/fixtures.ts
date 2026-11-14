import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, PREFIX, type Role } from '../../_demo/fixtures'
import { NewMenu } from '../debit-note/view/NewMenu'
import { designScreen as listScreen } from '../list/fixtures'
import { InvoicesListView } from '../list/view/InvoicesListView'
import { designScreen as recordScreen } from '../record/fixtures'
import { InvoiceRecordView } from '../record/view/InvoiceRecordView'
import type { CompanyEInvoicing } from './api'
import { financeCanOf, LIVE, TESTING_FAKE, TESTING_SIMULATED } from './demo/fixtures'
import { bannerOf } from './model'
import { DepthWord } from './view/DepthWord'
import { TestModeBannerView } from './view/TestModeBannerView'

/**
 * SCR-443 — Invoices in test mode (design finance.invoices page.h "test mode banner 'E-invoice test mode — nothing goes to
 * SDI' when on", "New ▾ (credit note · debit note · deposit invoice)", the ⋯ "Monthly invoice run" and "Stamp duty this
 * quarter"; B-W2b-417 on B-W2b-401's API), made-up data only: the banner on the invoices page and on the invoice record —
 * the FAKE intermediary answering, answers simulated (rejected on the first send) on a sandbox connection, two companies
 * named, a live company (no banner) — with New ▾ and the band's ⋯ in place, and the roles Finance and Sales (New ▾'s items
 * held with why).
 */

interface PageCase {
  role: Role
  page: 'list' | 'record'
  /** The companies' e-invoicing settings the banner reads. */
  companies: CompanyEInvoicing[]
  recordCase?: string
}

function PageDesign({ model }: { model: PageCase }) {
  const banner = createElement(TestModeBannerView, { model: bannerOf(model.companies) })
  if (model.page === 'record') {
    const found = recordScreen.cases.find((item) => item.id === (model.recordCase ?? 'draft-ready'))!.model
    const depth = { banner, more: found.record.invoice.status === 'ready' && found.record.invoice.value.status !== 'DRAFT' ? [{ id: 'debit', label: createElement(DepthWord, { k: 'debit.menu' }) }] : [] }
    return inShell(`/finance/invoices/${found.record.invoice.status === 'ready' ? found.record.invoice.value.id : 'x'}`, createElement(InvoiceRecordView, { model: { ...found.record, can: financeCanOf(model.role) }, depth }), model.role)
  }
  const list = listScreen.cases.find((item) => item.id === (model.role === 'sales' ? 'sales-read-only' : 'finance'))!.model
  const depth = {
    banner,
    newMenu: createElement(NewMenu, { can: financeCanOf(model.role), paymentsHref: `${PREFIX}/finance/payments?new=1` }),
    more: [
      { id: 'run', label: createElement(DepthWord, { k: 'more.run' }) },
      { id: 'stamp', label: createElement(DepthWord, { k: 'more.stamp' }) },
    ],
  }
  return inShell('/finance/invoices', createElement(InvoicesListView, { model: list.list, depth }), model.role)
}

export const designScreen = defineDesignScreen<PageCase>({
  screen: 'SCR-443',
  title: 'Invoices in test mode: the banner on every invoice page, New ▾ and the band’s ⋯ (monthly run, stamp duty)',
  view: PageDesign,
  cases: [
    { id: 'list-fake', label: 'Finance · Invoices: test mode on, the FAKE intermediary answers; New ▾ and ⋯ in the band', model: { role: 'finance', page: 'list', companies: [TESTING_FAKE] } },
    { id: 'list-simulated', label: 'Finance · Invoices: test mode on a sandbox connection, the first send of each invoice rejected', model: { role: 'finance', page: 'list', companies: [TESTING_SIMULATED] } },
    { id: 'list-two-companies', label: 'Finance · Two companies in test mode: each named with who answers', model: { role: 'finance', page: 'list', companies: [TESTING_FAKE, TESTING_SIMULATED] } },
    { id: 'list-live', label: 'Finance · Live: no banner', model: { role: 'finance', page: 'list', companies: [LIVE] } },
    { id: 'list-sales', label: 'Sales · Test mode on; New ▾ credit and debit note held with why', model: { role: 'sales', page: 'list', companies: [TESTING_FAKE] } },
    { id: 'record-draft', label: 'Finance · A draft invoice in test mode: the banner above its tabs', model: { role: 'finance', page: 'record', companies: [TESTING_FAKE], recordCase: 'draft-ready' } },
    { id: 'record-delivered', label: 'Finance · A delivered invoice in test mode: ⋯ offers Debit note', model: { role: 'finance', page: 'record', companies: [TESTING_SIMULATED], recordCase: 'delivered' } },
  ],
})
