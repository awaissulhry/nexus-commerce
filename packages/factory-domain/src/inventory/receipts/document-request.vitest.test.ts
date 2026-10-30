import { describe, expect, it } from 'vitest'
import { DOCUMENT_REQUEST_LIMITS, documentRequestMail, wantedDocuments, type RequestLot } from './document-request'

/** "Request from supplier" (B-W2a-F4): what a delivery still waits for, and the standard mail that asks for it. Made up. */

const lot = (over: Partial<RequestLot> = {}): RequestLot => ({ id: 'lot-1', code: 'LOT-2026-0001', supplierLotRef: 'CONC-7', dyeBatch: 'DB-1', qualityStatus: 'QUARANTINE', crViStatus: 'PENDING', holds: ['CR_VI_TEST'], ...over })

describe('what the delivery waits for', () => {
  it('the Cr VI report of a lot in quarantine for it, a PPE certificate, a missing delivery note', () => {
    const wanted = wantedDocuments({ supplierDdtNumber: null, ddtPhotoCount: 0 }, [lot(), lot({ id: 'lot-2', code: 'LOT-2026-0002', supplierLotRef: null, dyeBatch: null, crViStatus: 'NOT_REQUIRED', holds: ['PPE_CERTIFICATE'] })])
    expect(wanted).toEqual([
      { key: 'lot-1:CR_VI_REPORT', ask: 'CR_VI_REPORT', lot: { id: 'lot-1', code: 'LOT-2026-0001', supplierLotRef: 'CONC-7', dyeBatch: 'DB-1' } },
      { key: 'lot-2:PPE_CERTIFICATE', ask: 'PPE_CERTIFICATE', lot: { id: 'lot-2', code: 'LOT-2026-0002', supplierLotRef: null, dyeBatch: null } },
      { key: 'receipt:DELIVERY_NOTE', ask: 'DELIVERY_NOTE', lot: null },
    ])
  })

  it('nothing for a released lot, a result already in (or failed), a DDT number or its photo', () => {
    expect(wantedDocuments({ supplierDdtNumber: 'DDT-1', ddtPhotoCount: 0 }, [lot({ qualityStatus: 'RELEASED', holds: [] })])).toEqual([])
    expect(wantedDocuments({ supplierDdtNumber: null, ddtPhotoCount: 1 }, [lot({ crViStatus: 'FAIL' })])).toEqual([])
    expect(wantedDocuments({ supplierDdtNumber: 'DDT-1', ddtPhotoCount: 0 }, [lot({ holds: ['QUALITY_HOLD'] })])).toEqual([])
  })
})

describe('the standard mail', () => {
  const asked = wantedDocuments({ supplierDdtNumber: null, ddtPhotoCount: 0 }, [lot()])

  it("in Italian: the supplier's DDT and its date, each document with the supplier's own lot refs, the note under the list", () => {
    const mail = documentRequestMail({ language: 'it', receiptNumber: 'GR-2026-0007', supplierDdtNumber: 'DDT-881', supplierDdtDate: '2026-10-28', asked, note: '  Ci servono entro venerdì.  ' })
    expect(mail.subject).toBe('Documenti mancanti — vostro DDT DDT-881, nostro ricevimento GR-2026-0007')
    expect(mail.body).toBe(
      [
        'Buongiorno,',
        '',
        'per la merce ricevuta con il vostro DDT DDT-881 del 28/10/2026 (nostro ricevimento GR-2026-0007) ci mancano i seguenti documenti:',
        '- il rapporto di prova del cromo esavalente (Cr VI) — lotto vostro CONC-7, bagno DB-1, nostro LOT-2026-0001',
        '- una copia del documento di trasporto (DDT)',
        '',
        'Ci servono entro venerdì.',
        '',
        'I lotti restano in quarantena finché non li riceviamo. Potete rispondere a questa e-mail allegandoli.',
        '',
        'Grazie e cordiali saluti',
      ].join('\n'),
    )
  })

  it('in English, without a note; only the delivery note asked: no word of quarantine', () => {
    const mail = documentRequestMail({ language: 'en', receiptNumber: 'GR-2026-0007', supplierDdtNumber: null, supplierDdtDate: null, asked: asked.filter((entry) => entry.lot === null), note: '   ' })
    expect(mail.subject).toBe('Missing documents — our receipt GR-2026-0007')
    expect(mail.body).toBe(['Hello,', '', 'for the goods we received (our receipt GR-2026-0007) we are missing these documents:', '- a copy of the delivery note (DDT)', '', 'You can answer this e-mail with the documents attached.', '', 'Thank you and kind regards'].join('\n'))
    expect(JSON.stringify(mail)).not.toMatch(/€|EUR|price|prezz|quarant/i)
  })

  it('a note is short', () => {
    expect(DOCUMENT_REQUEST_LIMITS.note).toBe(500)
  })
})
