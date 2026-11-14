import { defineKpi } from '../catalogue'

/** Receipt lines posted (B-W2b-428): the goods receipt lines posted at the sites. */
export default defineKpi({
  key: 'purchasing.receipt_lines',
  unit: 'COUNT',
  grain: null,
  ownerRole: 'warehouse',
  sourceRecords: ['GoodsReceipt', 'GoodsReceiptLine'],
  calc: { kind: 'SUM', measure: 'receipts.lines' },
  period: 'WEEK',
  drill: { kind: 'LIST', api: '/inventory/receipts', query: { status: 'POSTED' } },
  words: {
    nameIt: 'Righe ricevute',
    nameEn: 'Receipt lines posted',
    definitionIt: 'Il numero di righe dei ricevimenti merce registrati nel periodo, nel giorno del sito. Un ricevimento stornato non conta più.',
    definitionEn: "The number of lines of the goods receipts posted in the period, on the site's day. A reversed receipt no longer counts.",
    formulaIt: 'conteggio delle righe dei ricevimenti registrati nel periodo',
    formulaEn: 'count of the lines of the receipts posted in the period',
  },
})
