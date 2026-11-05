import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { SAFETY_CHEMICALS_MANAGE } from './permissions'
import { cabinetAddress, cabinetCodeOf, cabinetOfScan, chemicalProblems, replaceRefusal, sheetFor, sheetProblems, sheetStateOf, statementsOf, type ChemicalInput } from './rules'

const base: ChemicalInput = {
  name: 'Contact glue',
  supplierName: 'Made-up Adhesives',
  use: 'GLUE',
  ghsPictograms: ['GHS02', 'GHS07'],
  signalWord: 'DANGER',
  hazardStatements: ['H225', 'H319', 'EUH066'],
  precautionStatements: ['P210', 'P305+P351+P338'],
  storagePlace: 'Glue cabinet, cutting room',
  cabinetCode: 'CAB-CUT-1',
  maxQuantity: '25',
  maxQuantityUnit: 'L',
  roleSheetIds: [],
  ppeItemIds: [],
}

describe('the chemical register (QHS-277; D.Lgs. 81/2008 art. 223)', () => {
  it('reads statements as CLP writes them, each once, the letters after the digits kept', () => {
    expect(statementsOf('h225, H319 ; euh066 H225')).toEqual(['H225', 'H319', 'EUH066'])
    expect(statementsOf('P305 + P351 + p338 P210')).toEqual(['P305+P351+P338', 'P210'])
    expect(statementsOf('H360Fd')).toEqual(['H360Fd'])
    expect(statementsOf('   ')).toEqual([])
  })

  it('takes a well-formed chemical and says what is wrong with a bad one, field by field', () => {
    expect(chemicalProblems(base)).toEqual([])
    const paths = (input: Partial<ChemicalInput>) => chemicalProblems({ ...base, ...input }).map((problem) => problem.path)
    expect(paths({ name: ' ' })).toEqual(['name'])
    expect(paths({ supplierPartyId: '00000000-0000-7000-8000-000000000001' })).toEqual(['supplierName'])
    expect(paths({ ghsPictograms: ['GHS02', 'GHS02'] })).toEqual(['ghsPictograms'])
    expect(paths({ hazardStatements: ['H22'] })).toEqual(['hazardStatements'])
    expect(paths({ precautionStatements: ['P210', 'P210'] })).toEqual(['precautionStatements'])
    expect(paths({ storagePlace: '' })).toEqual(['storagePlace'])
    expect(paths({ cabinetCode: 'CAB CUT' })).toEqual(['cabinetCode'])
    expect(paths({ maxQuantityUnit: null })).toEqual(['maxQuantityUnit'])
    expect(paths({ maxQuantity: '0' })).toEqual(['maxQuantity'])
    expect(paths({ maxQuantity: '', maxQuantityUnit: null })).toEqual([])
    expect(paths({ ghsPictograms: [], hazardStatements: [] })).toEqual(['signalWord'])
  })

  it('keeps a cabinet as a code in capitals', () => {
    expect(cabinetCodeOf('  cab-cut-1 ')).toBe('CAB-CUT-1')
    expect(cabinetCodeOf('')).toBeNull()
  })
})

describe('the data sheet library (QHS-278; REACH art. 35)', () => {
  it("checks a sheet's facts against today", () => {
    expect(sheetProblems({ versionLabel: '3.1', revisedOn: '2026-05-01', language: 'it' }, '2026-11-03')).toEqual([])
    expect(sheetProblems({ versionLabel: '', revisedOn: '2026-11-04', language: 'ita' }, '2026-11-03').map((problem) => problem.path)).toEqual(['versionLabel', 'revisedOn', 'language'])
  })

  it('replaces a current sheet only with a newer version', () => {
    const current = { versionLabel: '3.1', revisedOn: '2026-05-01' }
    expect(replaceRefusal(null, { versionLabel: '1', revisedOn: '2020-01-01', language: 'it' })).toBeNull()
    expect(replaceRefusal(current, { versionLabel: '3.2', revisedOn: '2026-09-01', language: 'it' })).toBeNull()
    expect(replaceRefusal(current, { versionLabel: '3.0', revisedOn: '2025-01-01', language: 'it' })?.code).toBe('OLDER_THAN_CURRENT')
    expect(replaceRefusal(current, { versionLabel: ' 3.1 ', revisedOn: '2026-05-01', language: 'it' })?.code).toBe('SAME_VERSION')
  })

  it('says whether a product has no sheet, none in the company language, or one to read', () => {
    expect(sheetStateOf([], 'it')).toBe('MISSING')
    expect(sheetStateOf([{ status: 'SUPERSEDED', language: 'it' }], 'it')).toBe('MISSING')
    expect(sheetStateOf([{ status: 'CURRENT', language: 'en' }], 'it')).toBe('OTHER_LANGUAGE')
    expect(sheetStateOf([{ status: 'CURRENT', language: 'en' }, { status: 'CURRENT', language: 'it' }], 'it')).toBe('OK')
  })

  it("opens the reader's language first, else the company's, else the newest current", () => {
    const sheets = [
      { id: 'a', status: 'CURRENT', language: 'en', revisedOn: '2026-01-01' },
      { id: 'b', status: 'CURRENT', language: 'de', revisedOn: '2026-03-01' },
      { id: 'c', status: 'SUPERSEDED', language: 'it', revisedOn: '2025-01-01' },
    ] as const
    expect(sheetFor(sheets, ['it', 'en'])?.id).toBe('a')
    expect(sheetFor(sheets, ['fr'])?.id).toBe('b')
    expect(sheetFor([], ['it'])).toBeNull()
  })
})

describe('the cabinet QR', () => {
  it('holds the floor address of its cabinet, and a scan of it names the cabinet', () => {
    const address = cabinetAddress('https://factory.example.com/', 'CAB-CUT-1')
    expect(address).toBe('https://factory.example.com/floor/sds?cabinet=CAB-CUT-1')
    expect(cabinetOfScan(address)).toBe('CAB-CUT-1')
    expect(cabinetOfScan('/floor/sds?cabinet=cab-2')).toBe('CAB-2')
    expect(cabinetOfScan('https://factory.example.com/floor/sdsx?cabinet=A')).toBeNull()
    expect(cabinetOfScan('HD-7K-0003RJ-M')).toBeNull()
    expect(cabinetOfScan('/floor/sds')).toBeNull()
  })
})

describe('the catalogues', () => {
  it('declares safety.chemicals.manage, gives it to the safety officer and the owner only, and declares the two events', () => {
    expect(FACTORY_PERMISSIONS.isDeclared(SAFETY_CHEMICALS_MANAGE)).toBe(true)
    const holders = ROLE_TEMPLATES.filter((template) => template.permissions.includes(SAFETY_CHEMICALS_MANAGE)).map((template) => template.key)
    expect(holders.sort()).toEqual(['owner', 'safety_officer'])
    expect(ROLE_TEMPLATES.find((template) => template.key === 'read_only')?.permissions).not.toContain(SAFETY_CHEMICALS_MANAGE)
    expect(EVENT_CATALOGUE.get('chemical.changed', 1).live?.floor).toBe('floor.work')
    expect(EVENT_CATALOGUE.get('sds.replaced', 1).live?.permission).toBe('safety.view')
  })
})
