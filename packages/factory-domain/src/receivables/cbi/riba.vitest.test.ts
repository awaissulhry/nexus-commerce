import { describe, expect, it } from 'vitest'
import { abiCabOfIban, CBI_RECORD_LENGTH, cbiDay, cbiProblems, cbiRibaFile, cbiText, supportNameOf, type CbiFlow } from './riba'

// Every code is made up: SIA 00000, ABI and CAB 00000, a test IBAN with bank and branch code 00000.
const FLOW: CbiFlow = {
  creditor: { siaCode: 'A0000', abi: '00000', cab: '00000', account: '000000004021', name: 'Test Moto Atelier S.r.l.', street: 'Via di Prova 1', postcodeTown: '00000 PROVA PV', vatNumber: '00000004021' },
  receipts: [
    {
      dueDate: '2026-11-30',
      amount: 41000,
      debtorBank: { abi: '00000', cab: '00000', name: 'Banca di Prova' },
      debtor: { code: 'C-001', name: 'Cliente di Prova Società Àlfa S.r.l.', taxId: '00000001016', street: 'Via Esempio 2', postcode: '00000', town: 'Città di Prova', province: 'pv' },
      invoice: { number: 'FT-2026-00001', issueDate: '2026-10-28' },
    },
    {
      dueDate: '2026-12-31',
      amount: 123456,
      debtorBank: { abi: '00000', cab: '00000', name: null },
      debtor: { code: 'C-002', name: 'Second Test Customer', taxId: 'TSTCST00A00A000A', street: 'Piazza Prova', postcode: '00000', town: 'Prova', province: 'PV' },
      invoice: { number: 'FT-2026-00002', issueDate: '2026-11-02' },
    },
  ],
  createdOn: '2026-11-14',
  supportName: supportNameOf('0196a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', '2026-11-14'),
}

describe('the Ri.Ba. file in the CBI layout (FIN-126)', () => {
  it('writes IB, seven records per receipt and EF, each 120 characters ended by CR LF', () => {
    const file = cbiRibaFile(FLOW)
    const records = file.text.split('\r\n')
    expect(records.at(-1)).toBe('')
    const lines = records.slice(0, -1)
    expect(lines).toHaveLength(2 * 7 + 2)
    expect(file.records).toBe(16)
    for (const line of lines) expect(line).toHaveLength(CBI_RECORD_LENGTH)
    expect(lines.map((line) => line.slice(1, 3))).toEqual(['IB', '14', '20', '30', '40', '50', '51', '70', '14', '20', '30', '40', '50', '51', '70', 'EF'])
  })

  it('places the keys, the amounts in cents and the banks where the records keep them', () => {
    const lines = cbiRibaFile(FLOW).text.split('\r\n')
    const [ib, r14] = [lines[0]!, lines[1]!]
    expect(ib.slice(3, 8)).toBe('A0000')
    expect(ib.slice(8, 13)).toBe('00000')
    expect(ib.slice(13, 19)).toBe('141126')
    expect(ib.slice(19, 39)).toBe(FLOW.supportName)
    expect(ib[113]).toBe('E')
    expect(r14.slice(3, 10)).toBe('0000001')
    expect(r14.slice(22, 28)).toBe('301126')
    expect(r14.slice(28, 33)).toBe('30000')
    expect(r14.slice(33, 46)).toBe('0000000041000')
    expect(r14[46]).toBe('-')
    expect(r14.slice(91, 96)).toBe('A0000')
    expect(r14[96]).toBe('4')
    expect(r14.slice(97, 113).trim()).toBe('C-001')
    expect(r14[119]).toBe('E')
    // Capitals without accents in the debtor's name; the province in capitals.
    expect(lines[3]!.slice(10, 70).trim()).toBe('CLIENTE DI PROVA SOCIETA ALFA S.R.L.')
    expect(lines[4]!.slice(68, 70)).toBe('PV')
    expect(lines[5]!.slice(10, 90).trim()).toBe('PER LA FATTURA N. FT-2026-00001 DEL 28/10/2026 IMP 410,00')
  })

  it('totals the receipts in EF: the count, the sum in cents, 15 zeros, 7 × n + 2 records', () => {
    const file = cbiRibaFile(FLOW)
    const ef = file.text.split('\r\n').at(-2)!
    expect(file.total).toBe(164456)
    expect(ef.slice(45, 52)).toBe('0000002')
    expect(ef.slice(52, 67)).toBe('000000000164456')
    expect(ef.slice(67, 82)).toBe('0'.repeat(15))
    expect(ef.slice(82, 89)).toBe('0000016')
  })

  it('refuses what the bank needs and the factory does not know, each at its path', () => {
    const missing: CbiFlow = { ...FLOW, creditor: { ...FLOW.creditor, siaCode: 'x' }, receipts: [{ ...FLOW.receipts[0]!, debtorBank: { abi: '', cab: '', name: null }, debtor: { ...FLOW.receipts[0]!.debtor, postcode: '' } }] }
    expect(cbiProblems(missing).map((problem) => problem.path)).toEqual(['creditor/siaCode', 'receipts/0/debtorBank', 'receipts/0/debtor/postcode'])
    expect(() => cbiRibaFile(missing)).toThrow(/siaCode/)
    expect(cbiProblems({ ...FLOW, receipts: [] }).map((problem) => problem.path)).toEqual(['receipts'])
  })

  it('reads an Italian IBAN for its ABI, CAB and account; anything else is no Italian account', () => {
    expect(abiCabOfIban('IT60 X000 0000 0000 0000 0123 456')).toEqual({ abi: '00000', cab: '00000', account: '000000123456' })
    expect(abiCabOfIban('DE00000000000000000000')).toBeNull()
    expect(abiCabOfIban(null)).toBeNull()
    expect(cbiText('  Größe & Co. — via Ünità ')).toBe('GROSSE & CO. VIA UNITA')
    expect(cbiDay('2026-01-05')).toBe('050126')
    expect(supportNameOf('0196a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', '2026-11-14')).toBe('RIBA2611140196A1B2C3')
  })
})
