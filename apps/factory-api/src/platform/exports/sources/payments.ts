import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { PAYMENTS_VIEW } from '@nexus/factory-domain/payments/permissions'
import { actorOf } from '../../../core/context'
import { listPayments, type ListPaymentsQuery } from '../../../modules/payments/payments'
import { officeContextOf } from '../../../modules/payments/store'
import { defineExportSource } from '../source'

/**
 * Finance › Payments (SCR-082, `/finance/payments`): the export of the list as the screen shows it, newest first. The
 * address is the screen's (apps/factory-web areas/finance/payments PaymentsPage.tsx): `?rows=received|voided` (the API's
 * status), nothing or `?rows=all`: every payment. `?rows=refunds` shows the refunds list in place of the payments (a list
 * of its own, not exported yet): asking for it is refused in words. Read through payments' own listPayments
 * (payments.view, its companies and customers). The amount and what is not placed are the price grain (absent from the
 * file without it); the placed state is made from those amounts, so without the price grain the state column says the
 * payment's status, as the screen does.
 */

type Row = Awaited<ReturnType<typeof listPayments>>['payments'][number] & { readonly price: boolean }
type Query = Pick<ListPaymentsQuery, 'status'>

const fill = (template: string, params: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))

/** Placed · Partly placed · Not placed · Voided (the screen's placedStateOf); null without the price grain. */
function placedState(row: Row): string | null {
  if (row.status === 'VOIDED') return 'VOIDED'
  if (!row.price) return null
  const unallocated = Number(row.unallocated)
  if (unallocated <= 0) return 'PLACED'
  return Number(row.allocated) > 0 ? 'PARTLY' : 'NOT_PLACED'
}

export const payments = defineExportSource<Query, Row>({
  listKey: 'finance.payments',
  permission: PAYMENTS_VIEW,
  query(address) {
    const rows = address.get('rows')
    if (rows === 'refunds') throw new ValidationError('The refunds view has no file yet: export the payments (all, received or voided).', [{ path: 'query/rows', message: 'refunds' }])
    if (rows === 'received') return { status: 'RECEIVED' }
    if (rows === 'voided') return { status: 'VOIDED' }
    return {}
  },
  async read(caller, query, cursor, limit) {
    const price = heldGrains(actorOf(officeContextOf(caller))).has('price')
    const page = await listPayments(caller, { ...query, cursor: cursor ?? undefined, limit })
    return { rows: page.payments.map((row) => ({ ...row, price })), next: page.nextCursor }
  },
  columns: {
    date: { value: (row) => ({ day: row.receivedOn }) },
    customer: { value: (row) => row.partyName },
    ref: { value: (row) => row.externalRef },
    amount: { grain: 'price', value: (row) => ({ minor: Number(row.amount), currency: row.currency }) },
    placed: {
      value: (row, words) => {
        if (row.placedOn.length === 0) return words(row.status === 'VOIDED' ? 'payments.voided' : 'payments.nothingPlaced')
        return row.placedOn
          .map((entry) => (entry.target === 'INVOICE' ? fill(words('item.invoice'), { number: entry.number ?? '—' }) : entry.orderNumber ? fill(words('item.deposit'), { order: entry.orderNumber }) : words('item.depositNoOrder')))
          .join(', ')
      },
    },
    left: { grain: 'price', value: (row) => (row.status === 'VOIDED' ? null : { minor: Number(row.unallocated), currency: row.currency }) },
    state: {
      value: (row, words) => {
        const state = placedState(row)
        return state ? words(`placed.${state}`) : words(`paymentStatus.${row.status}`)
      },
    },
  },
  words: {
    it: {
      'item.invoice': 'Fattura {number}',
      'item.deposit': 'Acconto dell’ordine {order}',
      'item.depositNoOrder': 'Acconto',
      'payments.nothingPlaced': 'Non ancora collocato',
      'payments.voided': 'Annullato',
      'placed.NOT_PLACED': 'Da collocare',
      'placed.PARTLY': 'Collocato in parte',
      'placed.PLACED': 'Collocato',
      'placed.VOIDED': 'Annullato',
      'paymentStatus.RECEIVED': 'Ricevuto',
      'paymentStatus.VOIDED': 'Annullato',
    },
    en: {
      'item.invoice': 'Invoice {number}',
      'item.deposit': 'Deposit of order {order}',
      'item.depositNoOrder': 'Deposit',
      'payments.nothingPlaced': 'Not placed yet',
      'payments.voided': 'Voided',
      'placed.NOT_PLACED': 'Not placed',
      'placed.PARTLY': 'Partly placed',
      'placed.PLACED': 'Placed',
      'placed.VOIDED': 'Voided',
      'paymentStatus.RECEIVED': 'Received',
      'paymentStatus.VOIDED': 'Voided',
    },
  },
})
