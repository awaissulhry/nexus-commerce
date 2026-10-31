import { Banknote, FileInput, FileText, FolderArchive, HandCoins, PieChart, SlidersHorizontal, Receipt, Scale, TrendingUp } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * Finance (design 01 area 10 "Finance / Amministrazione", after Compliance): getting paid — invoices from
 * shipped goods through SDI with their status, deposit invoices and credit notes (SCR-080, the record SCR-081), payments
 * placed on deposits and invoices (SCR-082), and the finance settings invoicing reads (SCR-083). Receivables, supplier
 * invoices, bank, costing, margins and the accounting export come with W2a/W2b. Labels are message keys (`shell:` =
 * messages/<locale>/shell.json); each row's permission is the one its page's API needs.
 */
export const officeArea: OfficeAreaNav = {
  order: 10,
  area: {
    id: 'finance',
    label: 'shell:nav.finance.area',
    href: '/finance',
    icon: Receipt,
    phone: 'more',
    sections: [
      {
        id: 'finance-main',
        label: 'shell:nav.finance.main',
        hideLabel: true,
        noCrumb: true,
        items: [
          // SCR-080 / SCR-081: invoices, deposit invoices and credit notes, from shipped goods to SDI (invoices.view).
          { id: 'finance-invoices', label: 'shell:nav.finance.invoices', href: '/finance/invoices', icon: FileText, permission: 'invoices.view' },
          // SCR-082: payments received and where they are placed (payments.view).
          { id: 'finance-payments', label: 'shell:nav.finance.payments', href: '/finance/payments', icon: Banknote, permission: 'payments.view' },
          // B-W2a-81: Receivables & credit (SCR-151: what customers owe by age, statements, reminders to approve; receivables.view).
          { id: 'finance-receivables', label: 'shell:nav.finance.receivables', href: '/finance/receivables', icon: HandCoins, permission: 'receivables.view' },
        ],
      },
      // B-W2a-81: Payables & bank › Supplier invoices (SCR-153: from SDI or typed, matched to PO and receipt, approved, paid; payables.view). Bank: W2b.
      {
        id: 'finance-payables',
        label: 'shell:nav.finance.payablesGroup',
        items: [{ id: 'finance-payables-page', label: 'shell:nav.finance.payables', href: '/finance/payables', icon: FileInput, permission: 'payables.view' }],
      },
      // B-W2a-72: Costing › Standard vs actual (SCR-154) and Margins (SCR-155): costing.view; amounts by the cost, price and margin grains.
      {
        id: 'finance-costing',
        label: 'shell:nav.finance.costingGroup',
        items: [
          { id: 'finance-costing-page', label: 'shell:nav.finance.costing', href: '/finance/costing', icon: Scale, permission: 'costing.view' },
          { id: 'finance-margins', label: 'shell:nav.finance.margins', href: '/finance/margins', icon: TrendingUp, permission: 'costing.view' },
        ],
      },
      // B-W2a-51: Close › Accounting export (SCR-156: numbered batches for the accountant, the wizard, the period locks).
      {
        id: 'finance-close',
        label: 'shell:nav.finance.close',
        items: [{ id: 'finance-accounting', label: 'shell:nav.finance.accounting', href: '/finance/accounting', icon: FolderArchive, permission: 'accounting.view' }],
      },
      // B-W2a-51: Reports › Finance reports (SCR-239: the stock valuation at any date; inventory.stock.view, values by the cost grain).
      {
        id: 'finance-reports',
        label: 'shell:nav.finance.reportsGroup',
        items: [{ id: 'finance-reports-page', label: 'shell:nav.finance.reports', href: '/finance/reports', icon: PieChart, permission: 'inventory.stock.view' }],
      },
      {
        id: 'finance-settings',
        label: 'shell:nav.finance.settingsGroup',
        items: [
          // SCR-083: what invoicing reads per company (GET /invoicing/settings: invoices.view).
          { id: 'finance-settings-page', label: 'shell:nav.finance.settings', href: '/finance/settings', icon: SlidersHorizontal, permission: 'invoices.view' },
        ],
      },
    ],
  },
}
