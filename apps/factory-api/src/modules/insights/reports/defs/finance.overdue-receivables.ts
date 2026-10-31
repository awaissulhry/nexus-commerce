import { RECEIVABLES_VIEW } from '@nexus/factory-domain/receivables/permissions'
import { ageing } from '../../../receivables/ageing'
import { numberOf } from '../kit'
import { defineReport } from '../report'

/**
 * Finance › Overdue from customers (Today's "Overdue from customers"; B-W2a-55): each customer that owes us money past
 * the due date, per company and currency, through the receivables ageing as the person (receivables.view over each
 * invoice's company and customer). The report is about amounts owed: without the price grain it stays listed and says
 * "Needs price rights".
 */

export default defineReport({
  key: 'finance.overdue-receivables',
  area: 'finance',
  title: 'Overdue from customers',
  question: 'Which customers owe us money past the due date?',
  permission: RECEIVABLES_VIEW,
  needs: 'price',
  columns: [
    { key: 'customer', label: 'Customer', kind: 'text' },
    { key: 'company', label: 'Company', kind: 'text', group: true },
    { key: 'invoices', label: 'Open invoices', kind: 'number', sum: true },
    { key: 'oldestDueDate', label: 'Oldest due', kind: 'day' },
    { key: 'daysLate', label: 'Days late', kind: 'number' },
    { key: 'overdueAmount', label: 'Overdue', kind: 'money', grain: 'price', sum: true },
    { key: 'over90Amount', label: 'Over 90 days', kind: 'money', grain: 'price', sum: true },
    { key: 'openAmount', label: 'Open', kind: 'money', grain: 'price', sum: true },
    { key: 'remindersSent', label: 'Reminders sent', kind: 'number', sum: true },
  ],
  filters: [],
  groupBy: null,
  sources: 'Issued invoices, credit notes and payments with their due dates',
  definition:
    'Every customer with an invoice past its due date, per company and currency, most overdue first. Open = what is still to be paid; overdue = the part past its due date; credit notes and payments are taken off.',
  numbers: ['finance.overdue'],
  mail: null,
  formats: ['CSV', 'PDF'],
  async read(run) {
    const customers = []
    let cursor: number | undefined
    let complete = true
    for (;;) {
      const page = await ageing(run.caller, { bucket: 'OVERDUE', limit: 500, ...(cursor === undefined ? {} : { cursor }) })
      customers.push(...page.customers)
      if (page.next === null) break
      if (customers.length >= run.limit) {
        complete = false
        break
      }
      cursor = page.next
    }
    return {
      complete: complete && customers.length <= run.limit,
      rows: customers.slice(0, run.limit).map((row) => ({
        id: `${row.company.id}:${row.customer.id}:${row.currency}`,
        record: { type: 'Party', id: row.customer.id, label: row.customer.name },
        currency: row.currency,
        cells: {
          customer: `${row.customer.code} · ${row.customer.name}`,
          company: row.company.code,
          invoices: row.invoices,
          oldestDueDate: row.oldestDueDate,
          daysLate: row.daysLate,
          overdueAmount: numberOf(row.overdue),
          over90Amount: numberOf((row.buckets as { OVER_90?: number } | undefined)?.OVER_90 ?? null),
          openAmount: numberOf(row.open),
          remindersSent: row.remindersSent,
        },
      })),
    }
  },
})
