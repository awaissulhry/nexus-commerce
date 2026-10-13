/**
 * Google Ads step 1a, W1 — the account picker's decisions and words (the dialog and the cards are thin over these).
 * Fixture names and ids are made up; the repo is public.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'http://localhost:8091' }))

import type { GoogleAccount, GoogleChoices } from '@/lib/google-ads/contract'
import {
  NONE,
  TAKEN_ELSEWHERE,
  adsAccountOptions,
  analyticsOptions,
  canSave,
  adsAccountHint,
  chooseAds,
  conflictText,
  currencyAndTimeZone,
  formatCustomerId,
  googleChips,
  googleScopeName,
  initialDraft,
  managerOptions,
  merchantOptions,
  needsChoice,
  choosableCustomers,
  readableCustomers,
  reconcileDraft,
  saveHeldReason,
  savedNotice,
  sectionError,
  selectionBody,
} from './google-selection'

const MANAGER = { customerId: '9990001111', name: 'Agency Manager' }

function choices(over: Partial<GoogleChoices> = {}): GoogleChoices {
  return {
    missingProducts: [],
    ads: {
      customers: [
        { customerId: '1112223333', name: 'Shop One', currency: 'EUR', timeZone: 'Europe/Rome', isTest: false, direct: true, managers: [] },
        { customerId: '4445556666', name: 'Shop Two', currency: 'JPY', timeZone: 'Asia/Tokyo', isTest: true, direct: false, managers: [MANAGER] },
        { customerId: '7778889999', name: null, currency: 'EUR', timeZone: 'Europe/Rome', isTest: false, direct: true, managers: [MANAGER] },
        // A manager that a buggy list offered as an account of its own.
        { customerId: MANAGER.customerId, name: MANAGER.name, currency: 'EUR', timeZone: 'Europe/Rome', isTest: false, direct: true, managers: [] },
      ],
      error: null,
    },
    merchantCenter: { accounts: [{ id: '5550001', name: 'Feed A' }], error: null },
    analytics: { properties: [{ propertyId: '321', name: 'Web shop', accountName: 'Analytics account' }], error: null },
    ...over,
  }
}

function account(over: Partial<GoogleAccount> = {}): GoogleAccount {
  return {
    connectionId: 'conn_1',
    label: 'Google sign-in',
    state: 'ok',
    stateText: '',
    authStatus: 'connected',
    missingProducts: [],
    ads: { customerId: '1112223333', name: 'Shop One', currency: 'EUR', timeZone: 'Europe/Rome', isTest: false },
    manager: null,
    merchantCenter: null,
    analytics: null,
    read: { lastReadAt: null, lastDataDay: null, nextReadAt: null, lastError: null },
    ...over,
  }
}

describe('the Google Ads account list', () => {
  it('never offers a manager account as the account Nexus reads', () => {
    expect(readableCustomers(choices()).map((c) => c.customerId)).not.toContain(MANAGER.customerId)
    expect(adsAccountOptions(choices()).map((o) => o.value)).not.toContain(MANAGER.customerId)
  })

  it('groups direct accounts under "Your accounts", the rest under their manager, direct first', () => {
    const opts = adsAccountOptions(choices())
    expect(opts.map((o) => [o.group, o.value])).toEqual([
      ['Your accounts', '1112223333'],
      ['Your accounts', '7778889999'],
      ['Through manager Agency Manager', '4445556666'],
    ])
  })

  it('names a test account and an unnamed one in words, never by customer id', () => {
    const opts = adsAccountOptions(choices())
    expect(opts.find((o) => o.value === '4445556666')?.label).toBe('Shop Two (test account)')
    expect(opts.find((o) => o.value === '7778889999')?.label).toBe('Unnamed Google Ads account')
    for (const o of opts) expect(o.label).not.toMatch(/\d{3}-\d{3}-\d{4}|\d{10}/)
    // The id rides along at the end of the row, as Google Ads prints it, and is searchable.
    expect(opts[0]!.trailing).toBe('111-222-3333')
    expect(opts[0]!.searchText).toContain('1112223333')
  })

  it('notes the currency and time zone it knows, and nothing (never " · ") for an account whose details were not read', () => {
    const past20 = { customerId: '1231231234', name: null, currency: '', timeZone: '', isTest: false, direct: true, managers: [] }
    const opts = adsAccountOptions(choices({ ads: { customers: [choices().ads.customers[0]!, past20], error: null } }))
    expect(opts.find((o) => o.value === '1112223333')?.note).toBe('EUR · Europe/Rome')
    expect(opts.find((o) => o.value === '1231231234')?.note).toBeUndefined()
    expect(opts.find((o) => o.value === '1231231234')?.searchText).toBe('1231231234 123-123-1234')
    expect(currencyAndTimeZone({ currency: 'EUR', timeZone: '' })).toBe('EUR')
    expect(currencyAndTimeZone({ currency: '', timeZone: 'Europe/Rome' })).toBe('Europe/Rome')
    expect(currencyAndTimeZone({ currency: ' ', timeZone: null })).toBeUndefined()
  })

  it('formats a customer id the way Google Ads does', () => {
    expect(formatCustomerId('1112223333')).toBe('111-222-3333')
    expect(formatCustomerId('abc')).toBe('abc')
  })
})

describe('the manager field', () => {
  const [direct, viaManager, both] = readableCustomers(choices())

  it('is hidden for an account with no manager route', () => {
    expect(managerOptions(direct)).toBeNull()
  })

  it('offers only the managers when the account is reached through one', () => {
    expect(managerOptions(viaManager)?.map((o) => o.value)).toEqual([MANAGER.customerId])
  })

  it('offers "None — direct access" first when the account is also reached directly', () => {
    expect(managerOptions(both)?.map((o) => o.label)).toEqual(['None — direct access', 'Agency Manager'])
  })

  it('picking an account resets the manager to that account’s own route', () => {
    const c = choices()
    const draft = { ads: '1112223333', manager: NONE, merchantCenter: NONE, analytics: NONE }
    expect(chooseAds(draft, '4445556666', c).manager).toBe(MANAGER.customerId)
    expect(chooseAds(draft, '7778889999', c).manager).toBe(NONE)
  })
})

describe('the draft', () => {
  it('opens on the saved choice', () => {
    const c = choices()
    const saved = account({ ads: { customerId: '4445556666', name: 'Shop Two', currency: 'JPY', timeZone: 'Asia/Tokyo', isTest: true }, manager: MANAGER, merchantCenter: { id: '5550001', name: 'Feed A' }, analytics: { propertyId: '321', name: 'Web shop' } })
    expect(initialDraft(saved, c)).toEqual({ ads: '4445556666', manager: MANAGER.customerId, merchantCenter: '5550001', analytics: '321' })
  })

  it('preselects the only account, and nothing when there are several', () => {
    const one = choices({ ads: { customers: [choices().ads.customers[0]!], error: null } })
    expect(initialDraft(null, one).ads).toBe('1112223333')
    expect(initialDraft(null, choices()).ads).toBe(NONE)
  })

  it('drops a saved pick Google no longer offers', () => {
    const saved = account({ merchantCenter: { id: 'gone', name: 'Old feed' } })
    expect(initialDraft(saved, choices()).merchantCenter).toBe(NONE)
    expect(reconcileDraft({ ads: 'gone', manager: NONE, merchantCenter: '5550001', analytics: 'gone' }, choices()))
      .toEqual({ ads: NONE, manager: NONE, merchantCenter: '5550001', analytics: NONE })
  })

  it('can be saved only with an offered Google Ads account', () => {
    expect(canSave({ ads: NONE, manager: NONE, merchantCenter: NONE, analytics: NONE }, choices())).toBe(false)
    expect(canSave({ ads: MANAGER.customerId, manager: NONE, merchantCenter: NONE, analytics: NONE }, choices())).toBe(false)
    expect(canSave({ ads: '1112223333', manager: NONE, merchantCenter: NONE, analytics: NONE }, choices())).toBe(true)
  })

  it('sends "None" as null', () => {
    expect(selectionBody({ ads: '1112223333', manager: NONE, merchantCenter: NONE, analytics: '321' }))
      .toEqual({ adsCustomerId: '1112223333', managerCustomerId: null, merchantCenterId: null, analyticsPropertyId: '321' })
  })

  it('offers "None" first for Merchant Center and Analytics', () => {
    expect(merchantOptions(choices())[0]).toEqual({ value: NONE, label: 'None' })
    expect(analyticsOptions(choices())[0]).toEqual({ value: NONE, label: 'None' })
    expect(analyticsOptions(choices())[1]).toMatchObject({ value: '321', label: 'Web shop', group: 'Analytics account' })
  })
})

describe('an account another business in Nexus already picked (C2 takenByAnotherBusiness)', () => {
  /** choices() with these ids marked as picked by another business (Ads accounts, Merchant Center accounts, properties). */
  function takenChoices(taken: string[], over: Partial<GoogleChoices> = {}): GoogleChoices {
    const c = choices(over)
    const mark = <T extends object>(item: T, id: string) => ({ ...item, takenByAnotherBusiness: taken.includes(id) })
    return {
      ...c,
      ads: { ...c.ads, customers: c.ads.customers.map((x) => mark(x, x.customerId)) },
      merchantCenter: { ...c.merchantCenter, accounts: c.merchantCenter.accounts.map((x) => mark(x, x.id)) },
      analytics: { ...c.analytics, properties: c.analytics.properties.map((x) => mark(x, x.propertyId)) },
    }
  }
  const only = (customer = choices().ads.customers[0]!) => ({ ads: { customers: [customer], error: null } })
  const blank = { ads: NONE, manager: NONE, merchantCenter: NONE, analytics: NONE }

  it('is listed, held, and says so in plain words; it never names the other business', () => {
    const c = takenChoices(['1112223333', '5550001', '321'])
    const ads = adsAccountOptions(c)
    expect(ads.find((o) => o.value === '1112223333')).toMatchObject({ label: 'Shop One', trailing: '111-222-3333', heldReason: TAKEN_ELSEWHERE, note: TAKEN_ELSEWHERE })
    expect(TAKEN_ELSEWHERE).toBe('Chosen in another business in Nexus')
    // The free ones are as before: no reason, their currency and time zone as the note.
    expect(ads.find((o) => o.value === '7778889999')).toMatchObject({ note: 'EUR · Europe/Rome' })
    expect(ads.find((o) => o.value === '7778889999')).not.toHaveProperty('heldReason')
    expect(merchantOptions(c)[1]).toMatchObject({ value: '5550001', label: 'Feed A', heldReason: TAKEN_ELSEWHERE, note: TAKEN_ELSEWHERE })
    expect(analyticsOptions(c)[1]).toMatchObject({ value: '321', label: 'Web shop', heldReason: TAKEN_ELSEWHERE, note: TAKEN_ELSEWHERE })
    // "None" is never held.
    expect(merchantOptions(c)[0]).toEqual({ value: NONE, label: 'None' })
    expect(analyticsOptions(c)[0]).toEqual({ value: NONE, label: 'None' })
    expect(choosableCustomers(c).map((x) => x.customerId)).toEqual(['4445556666', '7778889999'])
  })

  it('a flag the server did not send (an older server) holds nothing: Save still guards it', () => {
    expect(adsAccountOptions(choices()).every((o) => !o.heldReason)).toBe(true)
    expect(takenChoices([]).ads.customers.every((x) => x.takenByAnotherBusiness === false)).toBe(true)
    expect(adsAccountOptions(takenChoices([])).every((o) => !o.heldReason)).toBe(true)
  })

  it('the only Google Ads account is never preselected when another business picked it', () => {
    expect(initialDraft(null, takenChoices([], only())).ads).toBe('1112223333')
    expect(initialDraft(null, takenChoices(['1112223333'], only())).ads).toBe(NONE)
  })

  it('a saved pick another business now holds is not kept, for each product', () => {
    const saved = account({ merchantCenter: { id: '5550001', name: 'Feed A' }, analytics: { propertyId: '321', name: 'Web shop' } })
    expect(initialDraft(saved, takenChoices([]))).toEqual({ ads: '1112223333', manager: NONE, merchantCenter: '5550001', analytics: '321' })
    expect(initialDraft(saved, takenChoices(['1112223333', '5550001', '321']))).toEqual(blank)
  })

  it('after the lists are read again, a pick another business took meanwhile is dropped; the others are kept', () => {
    const draft = { ads: '7778889999', manager: NONE, merchantCenter: '5550001', analytics: '321' }
    expect(reconcileDraft(draft, takenChoices([]))).toEqual(draft)
    expect(reconcileDraft(draft, takenChoices(['7778889999']))).toEqual({ ...draft, ads: NONE })
    expect(reconcileDraft(draft, takenChoices(['5550001', '321']))).toEqual({ ...draft, merchantCenter: NONE, analytics: NONE })
  })

  it('Save never accepts a taken pick: not the Google Ads account, not Merchant Center, not Analytics', () => {
    const draft = { ads: '1112223333', manager: NONE, merchantCenter: '5550001', analytics: '321' }
    expect(canSave(draft, takenChoices([]))).toBe(true)
    expect(canSave(draft, takenChoices(['1112223333']))).toBe(false)
    expect(canSave(draft, takenChoices(['5550001']))).toBe(false)
    expect(canSave(draft, takenChoices(['321']))).toBe(false)
    expect(canSave({ ...draft, merchantCenter: NONE, analytics: NONE }, takenChoices(['5550001', '321']))).toBe(true)
  })

  it('Save is held with a plain reason; the only Google Ads account taken says that choosing will not help', () => {
    expect(saveHeldReason({ ...blank, ads: '1112223333' }, takenChoices([]))).toBeNull()
    expect(saveHeldReason(blank, takenChoices([]))).toBe('Choose the Google Ads account Nexus reads first.')
    expect(saveHeldReason(blank, takenChoices(['1112223333'], only())))
      .toBe('The only Google Ads account here is chosen in another business in Nexus. An account can belong to one business only.')
    expect(saveHeldReason(blank, takenChoices(['1112223333', '4445556666', '7778889999'])))
      .toBe('Every Google Ads account here is chosen in another business in Nexus. An account can belong to one business only.')
    // Some still free: choosing one is the way on.
    expect(saveHeldReason(blank, takenChoices(['1112223333']))).toBe('Choose the Google Ads account Nexus reads first.')
    expect(saveHeldReason({ ...blank, ads: '1112223333' }, takenChoices(['1112223333']))).toBe('This Google Ads account is chosen in another business in Nexus. Choose another one.')
    expect(saveHeldReason({ ...blank, ads: '7778889999', merchantCenter: '5550001' }, takenChoices(['5550001'])))
      .toBe('This Merchant Center account is chosen in another business in Nexus. Choose another one, or None.')
    expect(saveHeldReason({ ...blank, ads: '7778889999', analytics: '321' }, takenChoices(['321'])))
      .toBe('This Google Analytics property is chosen in another business in Nexus. Choose another one, or None.')
    expect(saveHeldReason({ ...blank, ads: '7778889999', merchantCenter: 'gone' }, takenChoices([])))
      .toBe('This Google sign-in can no longer see one of the chosen accounts. Choose again.')
    expect(saveHeldReason(null, null)).toBe('Choose the Google Ads account Nexus reads first.')
    for (const reason of [saveHeldReason(blank, takenChoices(['1112223333'], only())), TAKEN_ELSEWHERE]) expect(reason).not.toMatch(/\d{6,}|business profile/)
  })
})

describe('section errors, in words', () => {
  it('permission_missing asks for a reconnect that ticks every box', () => {
    expect(sectionError('analytics', { code: 'permission_missing', message: '' }))
      .toMatchObject({ action: 'reconnect', text: "Google did not give Nexus access to Google Analytics. Reconnect and tick every box on Google's screen." })
  })

  it('no_access for Google Ads says who can fix it', () => {
    expect(sectionError('ads', { code: 'no_access', message: '' })?.text).toBe("This Google sign-in cannot see any Google Ads account. Sign in with a Google user that has access, or ask the account's owner to add you.")
  })

  it('app_not_approved says only test accounts can be read', () => {
    expect(sectionError('ads', { code: 'app_not_approved', message: '' })?.text).toBe('Google has not yet approved Nexus to read real Google Ads accounts; only test accounts can be read.')
  })

  it('not_registered explains the one-time Merchant Center step', () => {
    expect(sectionError('merchant_center', { code: 'not_registered', message: '' }))
      .toMatchObject({ action: null, text: 'Google has not registered Nexus with this Merchant Center account yet. Nexus cannot list or read it until that one-time step is done.' })
  })

  it('google_unavailable offers Try again', () => {
    expect(sectionError('merchant_center', { code: 'google_unavailable', message: '' })).toMatchObject({ action: 'retry', text: 'Google did not answer. Try again.' })
  })

  it('google_unavailable carries the server\'s sentence: Nexus may not have asked at all (its daily allowance is used up)', () => {
    const message = 'Nexus did not ask Google Ads: its daily Google allowance is used up. Try again after 14:00 UTC on 13 October.'
    const view = sectionError('ads', { code: 'google_unavailable', message })
    expect(view).toMatchObject({ action: 'retry', title: 'Google Ads could not be listed', text: message })
    expect(`${view?.title} ${view?.text}`).not.toMatch(/did not answer/)
  })

  it('no error, no banner', () => {
    expect(sectionError('ads', null)).toBeNull()
  })
})

describe('a refused save (409)', () => {
  it('customer_taken: another Google sign-in of THIS business holds the choice', () => {
    const words = conflictText('customer_taken', 'The server said no.')
    expect(words.title).toBe('Another Google sign-in holds the choice')
    expect(words.text).toContain('through another Google sign-in')
  })

  it('taken_by_other_business: one title per product and the server’s sentence, which names no business', () => {
    const said = 'Another business in Nexus already uses this Merchant Center account. A Merchant Center account can belong to one business only.'
    expect(conflictText('taken_by_other_business', said, 'merchant_center')).toEqual({ title: 'This Merchant Center account belongs to another business', text: said })
    expect(conflictText('taken_by_other_business', 'x', 'analytics').title).toBe('This Google Analytics property belongs to another business')
    expect(conflictText('taken_by_other_business', 'x', 'ads').title).toBe('This Google Ads account belongs to another business')
    expect(conflictText('taken_by_other_business', '').text).toMatch(/one business only/)
  })

  it('not_offered says the lists were read again', () => {
    expect(conflictText('not_offered', '').text).toContain('read again')
  })

  it('anything else carries the server’s sentence', () => {
    expect(conflictText(null, 'The server said no.')).toEqual({ title: 'The choice was not saved', text: 'The server said no.' })
  })
})

describe('the Google card and the notices', () => {
  it('chips say what is chosen, and that Merchant Center and Analytics are not read yet', () => {
    const chips = googleChips(account({ manager: MANAGER, merchantCenter: { id: '1', name: 'Feed A' }, analytics: { propertyId: '2', name: 'Web shop' } }))
    expect(chips.map((c) => c.text)).toEqual([
      'Google Ads: Shop One · EUR',
      'Manager: Agency Manager',
      'Merchant Center (not read yet): Feed A',
      'Analytics (not read yet): Web shop',
    ])
    // A chip ends in an ellipsis when it is wider than the card: what it says comes before the name, so a long name is
    // what gets cut, never "not read yet".
    for (const chip of chips.slice(2)) expect(chip.text.indexOf('not read yet')).toBeLessThan(chip.text.indexOf(': '))
  })

  it('a chip never prints an empty currency (an account chosen before its first read, past the first 20)', () => {
    const a = account({ ads: { customerId: '1231231234', name: 'Shop Three', currency: '', timeZone: '', isTest: true } })
    expect(googleChips(a)[0]!.text).toBe('Google Ads: Shop Three · test account')
    expect(googleChips(account({ ads: { customerId: '1231231234', name: null, currency: '', timeZone: '', isTest: false } }))[0]!.text).toBe('Google Ads: unnamed account')
    // The detail card's line under the account: only the parts known, nothing when none is.
    expect(adsAccountHint({ currency: 'EUR', timeZone: 'Europe/Rome' })).toBe('EUR · days in Europe/Rome')
    expect(adsAccountHint({ currency: 'EUR', timeZone: '' })).toBe('EUR')
    expect(adsAccountHint({ currency: '', timeZone: '' })).toBeUndefined()
  })

  it('no Google Ads account chosen: a chip says so and the card offers Choose accounts', () => {
    const a = account({ ads: null, state: 'choose_account' })
    expect(googleChips(a)[0]).toEqual({ text: 'Google Ads account: not chosen', tone: 'warning' })
    expect(needsChoice(a)).toBe(true)
    expect(needsChoice(account())).toBe(false)
  })

  it('the saved notice says a read is queued, never that anything is read or live', () => {
    const n = savedNotice(account())
    expect(n.text).toContain('queued the first read of Shop One')
    expect(`${n.title} ${n.text}`).not.toMatch(/\blive\b|is reading|now reading/i)
  })

  it('Google’s scopes have names', () => {
    expect(googleScopeName('https://www.googleapis.com/auth/adwords')).toBe('Google Ads')
    expect(googleScopeName('https://www.googleapis.com/auth/content')).toBe('Merchant Center')
    expect(googleScopeName('https://www.googleapis.com/auth/analytics.readonly')).toBe('Google Analytics (read)')
    expect(googleScopeName('sell.inventory')).toBeNull()
  })
})

describe('the Google screens on Settings › Channels', () => {
  const src = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')

  it('a Google chip is one line inside the card: clipped with an ellipsis, its full text on hover', () => {
    expect(src('./ConnectTab.tsx')).toMatch(/googleChips\(item\)\.map\(\(chip\) => \(\s*<Tag [^>]*title=\{chip\.text\} truncate>/)
  })

  it('a sign-in\'s name or e-mail is clipped with an ellipsis (full text in title), never broken inside a word', () => {
    const css = src('./channels.css')
    expect(css).toMatch(/\.nds-connect-ident \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/)
    expect(src('./ConnectTab.tsx')).toMatch(/<span className="nds-connect-ident" title=\{names\}>\{names\}<\/span>/)
    expect(src('./[type]/ChannelDetailClient.tsx')).toMatch(/label: 'Account', value: <span className="nds-connect-ident" title=\{identityLine\(connection\)\}>/)
  })

  it('the dialog holds Save with saveHeldReason, and reads the lists again after a taken_by_other_business refusal', () => {
    const dialog = src('./GoogleAccountsDialog.tsx')
    expect(dialog).toMatch(/heldReason=\{busy \? null : loading && !choices \? '[^']+' : saveHeldReason\(draft, choices\)\}/)
    expect(dialog).toMatch(/if \(result\.code === 'not_offered' \|\| result\.code === 'taken_by_other_business'\) void load\(\)/)
  })

  it('the Google accounts card writes days and times as the Ads page does ("10 Oct 2026"), never ISO or a US date', () => {
    const card = src('./[type]/GoogleAccountsCard.tsx')
    expect(card).toMatch(/formatDay\(account\.read\.lastDataDay\)/)
    expect(card).toMatch(/formatMoment\(account\.read\.nextReadAt\)/)
    expect(card).not.toMatch(/toLocaleString|toLocaleDateString/)
  })
})
