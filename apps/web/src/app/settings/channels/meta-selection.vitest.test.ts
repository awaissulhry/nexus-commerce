/**
 * Meta ads step 1 — the pure rules of Settings › Channels › Meta: the three-field form (never a secret echoed back), the
 * token in words, the asset picker (one ad account required, an asset another business picked is held and never
 * chosen for the person), every refusal in words without naming another business. Made-up ids and names only.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { MetaChoices, MetaConnection, MetaTokenHealth, MetaTokenView } from '@/lib/meta-ads/contract'
import {
  EMPTY_CREDENTIALS, NONE, PAGE_TAKEN_ELSEWHERE, SECRET_INPUT_PROPS, TAKEN_ELSEWHERE, adAccountOptions, canSaveMeta, canSubmitCredentials, connectRefusal, credentialProblems,
  credentialsBody, initialMetaDraft, instagramOptions, metaChips, metaConflictText, metaConnectedNotice, metaSaveHeldReason, metaSavedNotice,
  metaSelectionBody, missingPermissionLines, needsMetaChoice, pageOptions, reconcileMetaDraft, tokenCheckNote, tokenLines,
} from './meta-selection'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 20)
const token = (over: Partial<MetaTokenView> = {}): MetaTokenView => ({
  checkedAt: '2026-10-20T06:00:00Z', isValid: true, expiresAt: null, neverExpires: true, renewsFrom: null, lastRenewedAt: null,
  type: 'SYSTEM_USER', typeText: 'System-user token', scopes: ['ads_read'], missing: [], problem: null, ...over,
})
const connection = (over: Partial<MetaConnection> = {}): MetaConnection => ({
  connectionId: 'conn-1', label: 'Meta', state: 'ok', stateText: 'Nexus reads “Shop A” once a day.', authStatus: 'connected',
  systemUser: { id: '120000000000001', name: 'Shop A system user' }, appId: '1234567', token: token(),
  adAccount: { adAccountId: '1234567890', name: 'Shop A', currency: 'EUR', timeZone: 'Europe/Rome', statusText: 'Active', businessId: null },
  page: null, instagram: null, lastError: null,
  read: { lastReadAt: null, lastDataDay: null, nextReadAt: null, lastStatus: null, lastError: null },
  ...over,
})
const account = (id: string, name: string) => ({
  adAccountId: id, name, currency: 'EUR', timeZone: 'Europe/Rome', accountStatus: 1, statusText: 'Active', businessId: '900000000000001',
  businessName: 'Shop A portfolio', takenByAnotherBusiness: false as const,
})
// An asset another business uses arrives as its id only (the API never sends its name or details).
const taken = (adAccountId: string) => ({ adAccountId, takenByAnotherBusiness: true as const })
const choices = (over: Partial<MetaChoices> = {}): MetaChoices => ({
  systemUser: { id: '120000000000001', name: 'Shop A system user' },
  adAccounts: { items: [account('1234567890', 'Shop A')], error: null },
  pages: { items: [{ pageId: '100000000000001', name: 'Shop A Page', instagram: null, takenByAnotherBusiness: false as const }], error: null },
  instagram: { items: [{ instagramId: '170000000000001', username: 'shop_a', pageId: '100000000000001', takenByAnotherBusiness: false as const }], error: null },
  ...over,
})

describe('the secret fields', () => {
  it('are masked and carry every password manager\'s ignore attribute, so nothing offers to save or fill them', () => {
    expect(SECRET_INPUT_PROPS).toEqual({
      type: 'password', autoComplete: 'new-password', spellCheck: false,
      'data-1p-ignore': 'true', 'data-lpignore': 'true', 'data-bwignore': 'true', 'data-form-type': 'other',
    })
  })
  it('both the app secret and the token use them, and no other password input is in the dialog', () => {
    const source = readFileSync(fileURLToPath(new URL('./MetaCredentialsDialog.tsx', import.meta.url)), 'utf8')
    expect(source.match(/<Input \{\.\.\.SECRET_INPUT_PROPS\} value=\{draft\.(appSecret|systemUserToken)\}/g)).toHaveLength(2)
    expect(source).not.toMatch(/type="password"/)
  })
})

describe('the form', () => {
  it('says what each field lacks, and sends the three values trimmed', () => {
    expect(credentialProblems(EMPTY_CREDENTIALS)).toEqual({ appId: 'Paste the App ID.', appSecret: 'Paste the App secret.', systemUserToken: 'Paste the system-user token.' })
    const draft = { appId: ' 1234567 ', appSecret: ' 0123456789abcdef0123456789abcdef ', systemUserToken: ' fixture-system-user-token-000000 ' }
    expect(canSubmitCredentials(draft)).toBe(true)
    expect(credentialsBody(draft)).toEqual({ appId: '1234567', appSecret: '0123456789abcdef0123456789abcdef', systemUserToken: 'fixture-system-user-token-000000' })
    expect(credentialProblems({ ...draft, appId: 'act_1234567890' }).appId).toMatch(/digits only/)
    expect(credentialProblems({ ...draft, systemUserToken: 'has a space in it, which Meta never shows' }).systemUserToken).toMatch(/no spaces/)
  })
  it('a refused connect is the server\'s sentence under a short title, and says nothing was saved', () => {
    expect(connectRefusal('wrong_app', 'Meta made this token for another app.')).toEqual({ title: 'The token and the app do not match', text: 'Meta made this token for another app. Nothing was saved.' })
    expect(connectRefusal(null, 'The server did not answer.').title).toBe('Meta was not connected')
  })
  it('a new connection that sees ad accounts asks to choose one; a replace keeps the choice', () => {
    const answer = { connectionId: 'conn-1', systemUser: { id: '120000000000001', name: null }, token: {} as MetaTokenHealth }
    expect(metaConnectedNotice({ ...answer, placement: 'new', adAccountsSeen: 2 }).text).toMatch(/Choose which of the 2 ad accounts/)
    expect(metaConnectedNotice({ ...answer, placement: 'new', adAccountsSeen: 0 }).text).toMatch(/lists no ad account/)
    expect(metaConnectedNotice({ ...answer, placement: 'reconsent', adAccountsSeen: 2 }).title).toBe('Meta credentials replaced.')
  })
})

describe('the token, in words', () => {
  it('valid and does not expire; a type Meta did not report is said', () => {
    expect(tokenLines(token(), NOW)).toEqual(expect.arrayContaining([
      { label: 'Token', value: 'Valid', tone: 'success' },
      { label: 'Expires', value: 'Does not expire by date' },
      { label: 'Token type', value: 'System-user token' },
    ]))
    expect(tokenLines(token({ type: null, typeText: '' }), NOW)).toContainEqual({ label: 'Token type', value: 'Token type not reported by Meta' })
  })
  it('a 60-day token: its date, a warning 14 days or less ahead, and when Nexus renews it', () => {
    const soon = token({ neverExpires: false, expiresAt: new Date(NOW + 10 * DAY).toISOString(), renewsFrom: '2026-10-01T00:00:00Z' })
    expect(tokenLines(soon, NOW)).toEqual(expect.arrayContaining([
      { label: 'Expires', value: '30 Oct 2026', tone: 'warning' },
      { label: 'Renewal', value: 'Nexus renews it from 1 Oct 2026 (60 days each time)' },
    ]))
    expect(tokenLines(token({ isValid: false, problem: 'The token was revoked.' }), NOW)[0]).toEqual({ label: 'Token', value: 'The token was revoked.', tone: 'danger' })
  })
  it('the permissions it lacks, required first, each with what it is for', () => {
    const t = token({ missing: [
      { scope: 'pages_show_list', required: false, neededFor: 'list the Facebook Pages' },
      { scope: 'ads_read', required: true, neededFor: 'read the ad account, its campaigns and its numbers' },
    ] })
    expect(missingPermissionLines(t)).toEqual(['ads_read (required): to read the ad account, its campaigns and its numbers', 'pages_show_list: to list the Facebook Pages'])
  })
  it('"Check token now" says what Meta found', () => {
    const health: MetaTokenHealth = { checkedAt: '2026-10-20T06:00:00Z', isValid: true, appId: '1234567', appMatches: true, type: 'SYSTEM_USER', userId: '120000000000001', expiresAt: null, neverExpires: true, dataAccessExpiresAt: null, scopes: ['ads_read'], missing: [], problem: null }
    expect(tokenCheckNote(health)).toEqual({ tone: 'success', title: 'Meta says the token is valid.', text: 'It does not expire by date.' })
    expect(tokenCheckNote({ ...health, isValid: false, problem: 'Session expired.' })).toMatchObject({ tone: 'danger', text: expect.stringMatching(/^Session expired\. Replace/) })
    expect(tokenCheckNote({ ...health, appMatches: false }).tone).toBe('danger')
    expect(tokenCheckNote({ ...health, missing: [{ scope: 'ads_read', required: true, neededFor: 'x' }] })).toMatchObject({ tone: 'warning', text: expect.stringMatching(/with ads_read/) })
  })
})

describe('the picker', () => {
  it('an asset another business picked is held with that sentence and its id only, never chosen for the person', () => {
    const c = choices({ adAccounts: { items: [taken('1234567890')], error: null } })
    // Its id and "used by another business" — never a name (the API sends none).
    expect(adAccountOptions(c)[0]).toMatchObject({ value: '1234567890', label: 'Used by another business', heldReason: TAKEN_ELSEWHERE, trailing: 'act_1234567890' })
    const pages = choices({ pages: { items: [{ pageId: '100000000000002', takenByAnotherBusiness: true as const }], error: null } })
    expect(pageOptions(pages)[1]).toMatchObject({ value: '100000000000002', label: 'Used by another business', heldReason: TAKEN_ELSEWHERE, trailing: '100000000000002' })
    // An Instagram account whose Page another business uses is held too (it goes with that Page).
    const ig = choices({ instagram: { items: [{ instagramId: '170000000000002', username: 'shop_b', pageId: '100000000000002', pageTakenByAnotherBusiness: true as const, takenByAnotherBusiness: false as const }], error: null } })
    expect(instagramOptions(ig)[1]).toMatchObject({ value: '170000000000002', label: '@shop_b', heldReason: PAGE_TAKEN_ELSEWHERE })
    expect(initialMetaDraft(null, c).adAccount).toBe(NONE)
    expect(metaSaveHeldReason(initialMetaDraft(null, c), c)).toMatch(/The only ad account here is used by another business/)
  })
  it('the only free ad account is chosen; the saved choice is kept while offered; Page and Instagram start at None', () => {
    expect(initialMetaDraft(null, choices())).toEqual({ adAccount: '1234567890', page: NONE, instagram: NONE })
    const two = choices({ adAccounts: { items: [account('1234567890', 'Shop A'), account('1234567891', 'Shop A outlet')], error: null } })
    expect(initialMetaDraft(null, two).adAccount).toBe(NONE)
    expect(metaSaveHeldReason(initialMetaDraft(null, two), two)).toBe('Choose the ad account Nexus reads first.')
    const saved = connection({ adAccount: { ...connection().adAccount!, adAccountId: '1234567891' }, page: { pageId: '100000000000001', name: 'Shop A Page' } })
    expect(initialMetaDraft(saved, two)).toEqual({ adAccount: '1234567891', page: '100000000000001', instagram: NONE })
  })
  it('lists read again keep only what is still offered and free', () => {
    const d = { adAccount: '1234567890', page: '100000000000001', instagram: '170000000000001' }
    const gone = choices({ pages: { items: [], error: null }, instagram: { items: [{ instagramId: '170000000000001', takenByAnotherBusiness: true as const }], error: null } })
    expect(reconcileMetaDraft(d, gone)).toEqual({ adAccount: '1234567890', page: NONE, instagram: NONE })
    expect(canSaveMeta(d, choices())).toBe(true)
    expect(metaSelectionBody({ adAccount: '1234567890', page: NONE, instagram: NONE })).toEqual({ adAccountId: '1234567890', pageId: null, instagramId: null })
  })
  it('no ad account at all says where to assign one', () => {
    expect(metaSaveHeldReason(null, choices({ adAccounts: { items: [], error: null } }))).toMatch(/Assign the ad account to the system user/)
  })
  it('Page and Instagram lists offer None first and name an account by its username', () => {
    expect(pageOptions(choices()).map((o) => o.label)).toEqual(['None', 'Shop A Page'])
    expect(instagramOptions(choices()).map((o) => o.label)).toEqual(['None', '@shop_a'])
  })
  it('every 409 in words, never naming the other business', () => {
    expect(metaConflictText('taken_by_other_business', 'Another business in Nexus already uses this Instagram account.', 'INSTAGRAM'))
      .toEqual({ title: 'This Instagram account belongs to another business', text: 'Another business in Nexus already uses this Instagram account.' })
    expect(metaConflictText('account_taken', '', null).title).toBe('Another Meta connection holds the choice')
    expect(metaConflictText('not_offered', 'Meta does not offer this ad account.', 'AD_ACCOUNT')).toEqual({ title: 'Meta no longer offers this choice', text: 'Meta does not offer this ad account.' })
    expect(metaConflictText(null, 'The server did not answer.', null)).toEqual({ title: 'The choice was not saved', text: 'The server did not answer.' })
  })
  it('a saved choice says the first read is queued and nothing changes in Meta', () => {
    expect(metaSavedNotice(connection()).text).toMatch(/queued the first read of Shop A.*Nothing is changed in Meta/)
  })
})

describe('the Meta card', () => {
  it('chips: the chosen assets, what lacks, a token about to expire', () => {
    expect(metaChips(connection({ page: { pageId: '100000000000001', name: 'Shop A Page' } }), NOW)).toEqual([
      { text: 'Ad account: Shop A · EUR', tone: 'success' },
      { text: 'Page: Shop A Page', tone: 'neutral' },
    ])
    const c = connection({ state: 'choose_account', adAccount: null, token: token({ neverExpires: false, expiresAt: new Date(NOW + 5 * DAY).toISOString() }) })
    expect(metaChips(c, NOW)).toEqual([{ text: 'Ad account: not chosen', tone: 'warning' }, { text: 'Token expires 25 Oct 2026', tone: 'warning' }])
    expect(needsMetaChoice(c)).toBe(true)
    expect(needsMetaChoice(connection())).toBe(false)
  })
})
