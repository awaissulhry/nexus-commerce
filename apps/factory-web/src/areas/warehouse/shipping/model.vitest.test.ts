import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import type { CarrierAccount, Printer, ShippingSettings } from './api'
import { abilitiesOf, accountState, bodyOf, changedFields, chosenSite, formOf, formProblems, printersFor, saveProblem, serverProblems, siteAccounts, testMode } from './model'

const SETTINGS: ShippingSettings = {
  id: 'site-1',
  siteId: 'site-1',
  companyId: 'co-1',
  senderAddress: { name: 'Demo S.r.l.', line1: 'Via Uno 1', line2: null, postalCode: '40100', city: 'Bologna', province: 'BO', country: 'IT', phone: null, email: null },
  returnAddress: null,
  integrationAccountId: 'acc-1',
  defaultCarrierCode: 'brt',
  defaultServiceCode: null,
  defaultTransportBy: 'CARRIER',
  defaultGoodsAppearance: 'Scatole',
  labelPrinterId: 'p-1',
  documentPrinterId: null,
  cutOffTime: '17:00',
  version: 3,
  updatedAt: '2026-10-28T09:00:00.000Z',
}

const account = (over: Partial<CarrierAccount> = {}): CarrierAccount => ({
  id: 'acc-1',
  companyId: 'co-1',
  provider: 'SENDCLOUD',
  code: 'sc',
  label: 'Sendcloud',
  mode: 'LIVE',
  status: 'ACTIVE',
  credentials: { saved: true, savedAt: null },
  lastOkAt: null,
  lastErrorAt: null,
  ...over,
})

describe('the settings form and the PUT body (saved whole)', () => {
  it('opens saved settings and sends them back unchanged, with the version read; nothing the person cannot see is cleared', () => {
    const form = formOf(SETTINGS)
    expect(changedFields(formOf(SETTINGS), form)).toEqual([])
    expect(bodyOf(form, SETTINGS.version)).toEqual({
      version: 3,
      senderAddress: { name: 'Demo S.r.l.', line1: 'Via Uno 1', line2: null, postalCode: '40100', city: 'Bologna', province: 'BO', country: 'IT', phone: null, email: null },
      returnAddress: null,
      integrationAccountId: 'acc-1',
      defaultCarrierCode: 'brt',
      defaultServiceCode: null,
      defaultTransportBy: 'CARRIER',
      defaultGoodsAppearance: 'Scatole',
      labelPrinterId: 'p-1',
      documentPrinterId: null,
      cutOffTime: '17:00',
    })
  })

  it('a site without settings starts empty (Italy, a carrier) and saves without a version; blanks are sent as null, the country in capitals', () => {
    const form = formOf(null)
    expect(form.sender.country).toBe('IT')
    expect(form.defaultTransportBy).toBe('CARRIER')
    const body = bodyOf({ ...form, sender: { ...form.sender, name: '  Demo  ', country: 'it', phone: ' ' } }, null)
    expect(body).not.toHaveProperty('version')
    expect(body.senderAddress).toMatchObject({ name: 'Demo', country: 'IT', phone: null, line2: null })
    expect(body.integrationAccountId).toBeNull()
  })

  it('a return address is sent only while "Returns go to another address" is ticked; the tick counts as a change', () => {
    const saved = formOf(SETTINGS)
    const draft = { ...saved, returnDifferent: true, returns: { ...saved.sender, line1: 'Via Resi 2' } }
    expect(bodyOf(draft, 3).returnAddress).toMatchObject({ line1: 'Via Resi 2' })
    expect(changedFields(saved, draft)).toEqual(['returnDifferent'])
    expect(bodyOf({ ...draft, returnDifferent: false }, 3).returnAddress).toBeNull()
  })

  it('counts each changed field once', () => {
    const saved = formOf(SETTINGS)
    expect(changedFields(saved, { ...saved, cutOffTime: '16:30', sender: { ...saved.sender, city: 'Modena' } })).toEqual(['sender.city', 'cutOffTime'])
  })
})

describe('the field problems (the same rules as factory-domain shipping/settings)', () => {
  it('an address names who, street, postal code, city and a two-letter country; an e-mail when given', () => {
    const form = formOf(null)
    expect(formProblems(form)).toMatchObject({ 'sender.name': 'problem.name', 'sender.line1': 'problem.required', 'sender.postalCode': 'problem.required', 'sender.city': 'problem.required' })
    const filled = formOf(SETTINGS)
    expect(formProblems(filled)).toEqual({})
    expect(formProblems({ ...filled, sender: { ...filled.sender, country: 'Italia', email: 'x@' } })).toEqual({ 'sender.country': 'problem.country', 'sender.email': 'problem.email' })
  })

  it('the return address is checked only while it is used', () => {
    const filled = formOf(SETTINGS)
    expect(formProblems({ ...filled, returnDifferent: false, returns: formOf(null).returns })).toEqual({})
    expect(formProblems({ ...filled, returnDifferent: true, returns: { ...formOf(null).returns } })).toMatchObject({ 'returns.city': 'problem.required' })
  })

  it("carrier and service are the aggregator's codes; a service needs its carrier; the cut-off is HH:MM", () => {
    const filled = formOf(SETTINGS)
    expect(formProblems({ ...filled, defaultCarrierCode: 'BRT Express' })).toEqual({ defaultCarrierCode: 'problem.carrierCode' })
    expect(formProblems({ ...filled, defaultServiceCode: 'two words' })).toEqual({ defaultServiceCode: 'problem.serviceCode' })
    expect(formProblems({ ...filled, defaultCarrierCode: '', defaultServiceCode: 'express' })).toEqual({ defaultServiceCode: 'problem.serviceNeedsCarrier' })
    expect(formProblems({ ...filled, cutOffTime: '5pm' })).toEqual({ cutOffTime: 'problem.cutOff' })
    expect(formProblems({ ...filled, cutOffTime: '24:00' })).toEqual({ cutOffTime: 'problem.cutOff' })
    expect(formProblems({ ...filled, cutOffTime: '' })).toEqual({})
  })

  it("the server's refusals by path become the page's words; a moved version is a conflict that keeps the typing", () => {
    const invalid = new ApiError('invalid', 400, 'validation_failed', 'The shipping settings are not valid.', null, [
      { path: 'body/senderAddress/city', message: 'Required.' },
      { path: 'body/labelPrinterId', message: 'Carrier labels print on a label printer (ZPL).' },
      { path: 'body/integrationAccountId', message: "Not a Sendcloud account of this site's company." },
      { path: 'body.cutOffTime', message: 'Expected a time of day, HH:MM.' },
    ])
    expect(serverProblems(invalid)).toEqual({ 'sender.city': 'problem.required', labelPrinterId: 'problem.labelPrinter', integrationAccountId: 'problem.account', cutOffTime: 'problem.cutOff' })
    expect(saveProblem(invalid)).toEqual({ key: 'save.problem.invalid', conflict: false })
    expect(saveProblem(new ApiError('conflict', 409, 'stale_version', 'changed'))).toEqual({ key: 'save.problem.conflict', conflict: true })
    expect(saveProblem(new ApiError('forbidden', 403, 'forbidden', 'no'))).toEqual({ key: 'save.problem.forbidden', conflict: false })
    expect(serverProblems(new ApiError('conflict', 409, 'x', 'y'))).toEqual({})
    expect(saveProblem(new Error('x'))).toEqual({ key: 'save.problem.internal', conflict: false })
  })
})

describe('the carrier account, its TEST mode, the printers and the sites', () => {
  it("offers only the company's own Sendcloud accounts that are not disabled", () => {
    const accounts = [account(), account({ id: 'acc-2', companyId: 'co-2' }), account({ id: 'acc-3', companyId: null }), account({ id: 'acc-4', status: 'DISABLED' }), account({ id: 'acc-5', provider: 'SES' })]
    expect(siteAccounts(accounts, 'co-1').map((entry) => entry.id)).toEqual(['acc-1'])
  })

  it('says the state: none, set but unseen, not the company’s, test, paused, disabled, keys missing, connected', () => {
    expect(accountState('', [account()])).toBe('none')
    expect(accountState('acc-1', null)).toBe('unknown')
    expect(accountState('acc-9', [account()])).toBe('missing')
    expect(accountState('acc-1', [account({ mode: 'FAKE' })])).toBe('test')
    expect(accountState('acc-1', [account({ status: 'PAUSED' })])).toBe('paused')
    expect(accountState('acc-1', [account({ status: 'DISABLED' })])).toBe('disabled')
    expect(accountState('acc-1', [account({ credentials: { saved: false, savedAt: null } })])).toBe('noCredentials')
    expect(accountState('acc-1', [account()])).toBe('connected')
    expect(testMode('acc-1', [account({ mode: 'FAKE' })])).toBe('FAKE')
    expect(testMode('acc-1', [account({ mode: 'SANDBOX' })])).toBe('SANDBOX')
    expect(testMode('acc-1', [account()])).toBeNull()
    expect(testMode('acc-1', null)).toBeNull()
  })

  it('a slot takes its kind of printer of the site, not archived, by code', () => {
    const printer = (id: string, code: string, kind: Printer['kind'], status: Printer['status'] = 'ACTIVE'): Printer => ({ id, companyId: 'co-1', siteId: 'site-1', code, name: code, kind, status })
    const printers = [printer('a', 'LBL-2', 'LABEL_ZPL'), printer('b', 'A4', 'A4_PDF'), printer('c', 'LBL-1', 'LABEL_ZPL', 'PAUSED'), printer('d', 'LBL-0', 'LABEL_ZPL', 'ARCHIVED')]
    expect(printersFor(printers, 'LABEL_ZPL').map((entry) => entry.id)).toEqual(['c', 'a'])
    expect(printersFor(printers, 'A4_PDF').map((entry) => entry.id)).toEqual(['b'])
  })

  it('shows the site the address names when the person reaches it, else the first', () => {
    const sites = [
      { site: { id: 's1', companyId: 'co-1', code: 'A', name: 'A' }, settings: null },
      { site: { id: 's2', companyId: 'co-1', code: 'B', name: 'B' }, settings: null },
    ]
    expect(chosenSite(sites, 's2')?.site.id).toBe('s2')
    expect(chosenSite(sites, 'elsewhere')?.site.id).toBe('s1')
    expect(chosenSite([], null)).toBeNull()
  })

  it('what a person may do comes from their permissions', () => {
    expect(abilitiesOf(['shipping.settings.view'])).toEqual({ view: true, manage: false, accounts: false, printers: false, openConnections: false, openDevices: false })
    expect(abilitiesOf(['shipping.settings.view', 'shipping.settings.manage', 'integrations.view', 'print.view', 'devices.view'])).toEqual({ view: true, manage: true, accounts: true, printers: true, openConnections: true, openDevices: true })
  })
})
