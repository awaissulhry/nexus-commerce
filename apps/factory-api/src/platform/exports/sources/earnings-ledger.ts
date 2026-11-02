import { ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { PEOPLE_EARNINGS_RECORDS } from '@nexus/factory-domain/people/earnings/permissions'
import { EARNINGS_KINDS, type EarningsKind } from '@nexus/factory-domain/people/earnings/rules'
import { ledger } from '../../../modules/people/earnings/entries'
import type { LedgerQuery } from '../../../modules/people/earnings/contract'
import { defineExportSource } from '../source'

/**
 * People › Piece rates › Earnings ledger (SCR-158; B-W2b-62, design header "Export earnings"): the list as the screen shows
 * it, through its own read (people.earnings.records over its sites): date, bundle, operation, pieces, minutes, rate, amount
 * (`pay` grain: a column of a grain the person does not hold is never read into the file), source, what it reverses or
 * corrects, why. Never a worker's name or key: the file carries what the list shows (Owner answer W1). The address is the
 * list's own (web areas/people/piecerates model.ts): `?ledgerPeriod=`, `?ledgerLine=`, `?ledgerKind=`, `?site=`.
 */

type Row = Awaited<ReturnType<typeof ledger>>['entries'][number]
type Query = Omit<LedgerQuery, 'cursor' | 'limit' | 'employeeId' | 'groupBy'>

const idOf = (address: URLSearchParams, term: string): string | undefined => {
  const value = address.get(term) || undefined
  if (value && !isUuid(value)) throw new ValidationError('Not a known filter.', [{ path: `query/${term}`, message: 'An id.' }])
  return value
}

export const earningsLedger = defineExportSource<Query, Row>({
  listKey: 'people.piecerates.ledger',
  permission: PEOPLE_EARNINGS_RECORDS,
  page: '/people/piecerates',
  query(address) {
    const kind = address.get('ledgerKind') ?? ''
    return { periodId: idOf(address, 'ledgerPeriod'), lineId: idOf(address, 'ledgerLine'), siteId: idOf(address, 'site'), kind: (EARNINGS_KINDS as readonly string[]).includes(kind) ? (kind as EarningsKind) : undefined }
  },
  async read(caller, query, cursor, limit) {
    const page = await ledger(caller, { ...query, limit: Math.min(limit, 200), ...(cursor ? { cursor } : {}) })
    return { rows: page.entries, next: page.nextCursor }
  },
  columns: {
    date: { value: (row) => ({ day: row.workDate }) },
    bundle: { value: (row) => row.bundle ?? '' },
    operation: { value: (row) => (row.operation ? `${row.operation.code} ${row.operation.name}` : '') },
    pieces: { value: (row) => row.pieces },
    minutes: { value: (row) => (row.minutes === null ? null : { decimal: row.minutes }) },
    rate: { grain: 'pay', value: (row) => (row.rate === null ? null : { decimal: row.rate }) },
    amount: { grain: 'pay', value: (row) => ({ minor: row.amount, currency: row.currency }) },
    source: { value: (row, words) => words(row.reversesId ? 'REVERSAL' : row.kind) },
    corrects: { value: (row) => row.correctsMonth ?? '' },
    reason: { value: (row) => row.reason ?? '' },
  },
  words: {
    it: { SCAN: 'Scansione', TEAM_SPLIT: 'Quota di squadra', MAKE_UP: 'Integrazione', OFF_STANDARD: 'Tempo fuori cottimo', ADJUSTMENT: 'Correzione', REVERSAL: 'Storno' },
    en: { SCAN: 'Scan', TEAM_SPLIT: 'Team share', MAKE_UP: 'Make-up', OFF_STANDARD: 'Off-standard time', ADJUSTMENT: 'Correction', REVERSAL: 'Reversal' },
  },
})
