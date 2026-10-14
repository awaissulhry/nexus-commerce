/**
 * Google Ads step 1a, W1 — the pure half of "Choose Google accounts" and of the Google card's chips.
 *
 * JSX-free so the node-only web suite tests it; `GoogleAccountsDialog.tsx`, `ConnectTab.tsx` and
 * `[type]/GoogleAccountsCard.tsx` are thin over these. The words here are the ones a person reads: plain English, no
 * customer id as a name, and never "reading" or "live" for something Nexus has not read yet.
 */
import type { ListboxPanelOption } from '@/design-system/components'
import type {
  GoogleAccount,
  GoogleAdsCustomerChoice,
  GoogleChoiceError,
  GoogleChoices,
  GoogleSignInProduct,
  GoogleSelectionBody,
  GoogleSelectionConflict,
} from '@/lib/google-ads/contract'

export { GOOGLE_KEY } from '@/lib/google-ads/contract'

/** The Listbox value of "None" (Merchant Center, Analytics) and of "None — direct access" (manager). */
export const NONE = ''

/**
 * What a Google account another business in Nexus already picked says in the list (C2 `takenByAnotherBusiness`). One
 * business per account: the option is HELD (shown, reachable, never chosen) and never names that business.
 */
export const TAKEN_ELSEWHERE = 'Chosen in another business in Nexus'

/** Whether another business in Nexus already picked this account. Absent (an older server) = not known: not held. */
const takenElsewhere = (c: { takenByAnotherBusiness?: boolean } | null | undefined) => c?.takenByAnotherBusiness === true

/** A held option's reason, shown under its label as well (the DS reads a note equal to the reason once). */
const held = (taken: boolean) => (taken ? { heldReason: TAKEN_ELSEWHERE, note: TAKEN_ELSEWHERE } : {})

/** "1234567890" → "123-456-7890", the way Google Ads prints a customer id. Anything else is returned as it came. */
export function formatCustomerId(id: string): string {
  const digits = id.replace(/\D/g, '')
  return digits.length === 10 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : id
}

const adsName = (c: { name: string | null }) => c.name?.trim() || 'Unnamed Google Ads account'

/**
 * "EUR · Europe/Rome" — only the parts Nexus knows. Past the first 20 accounts a sign-in reaches, Google Ads was not
 * asked for an account's details, so its currency and time zone come as empty text: nothing is shown, never " · ".
 */
export function currencyAndTimeZone(c: { currency: string | null; timeZone: string | null }): string | undefined {
  return [c.currency?.trim(), c.timeZone?.trim()].filter(Boolean).join(' · ') || undefined
}

/**
 * Manager (MCC) accounts are never offered as the account Nexus reads: a manager holds no campaigns of its own. The
 * server leaves them out; this is the second lock — an id that some other choice names as its manager is a manager.
 */
export function readableCustomers(choices: GoogleChoices | null): GoogleAdsCustomerChoice[] {
  const customers = choices?.ads.customers ?? []
  const managerIds = new Set(customers.flatMap((c) => c.managers.map((m) => m.customerId)))
  return customers.filter((c) => !managerIds.has(c.customerId))
}

/** The Google Ads accounts this business may choose: offered, not a manager, not picked by another business. */
export function choosableCustomers(choices: GoogleChoices | null): GoogleAdsCustomerChoice[] {
  return readableCustomers(choices).filter((c) => !takenElsewhere(c))
}

/**
 * The Google Ads account options. Each account appears once: under "Your accounts" when this sign-in reaches it
 * directly, else under "Through manager <name>". A test account says so. The customer id rides along at the end of
 * the row — it is how Google Ads itself tells two accounts apart — and is searchable, but it is never the name. An
 * account another business in Nexus already picked is held, and says so instead of its currency and time zone.
 */
export function adsAccountOptions(choices: GoogleChoices | null): ListboxPanelOption[] {
  return readableCustomers(choices)
    .map((c) => ({
      value: c.customerId,
      label: `${adsName(c)}${c.isTest ? ' (test account)' : ''}`,
      group: c.direct || c.managers.length === 0 ? 'Your accounts' : `Through manager ${adsName(c.managers[0]!)}`,
      trailing: formatCustomerId(c.customerId),
      searchText: [c.customerId, formatCustomerId(c.customerId), c.currency?.trim()].filter(Boolean).join(' '),
      note: currencyAndTimeZone(c),
      ...held(takenElsewhere(c)),
    }))
    .sort((a, b) => (a.group === b.group ? a.label.localeCompare(b.label) : a.group === 'Your accounts' ? -1 : b.group === 'Your accounts' ? 1 : a.group.localeCompare(b.group)))
}

/**
 * The manager field — shown only when the chosen account is reached through a manager. "None — direct access" is
 * offered only when this sign-in also reaches the account directly. `null` = do not show the field.
 */
export function managerOptions(customer: GoogleAdsCustomerChoice | null | undefined): ListboxPanelOption[] | null {
  if (!customer || customer.managers.length === 0) return null
  return [
    ...(customer.direct ? [{ value: NONE, label: 'None — direct access' }] : []),
    ...customer.managers.map((m) => ({ value: m.customerId, label: adsName(m), trailing: formatCustomerId(m.customerId), searchText: m.customerId })),
  ]
}

/** The manager a fresh choice starts on: none when the account is reached directly, else its first manager. */
export function defaultManager(customer: GoogleAdsCustomerChoice | null | undefined): string {
  if (!customer || customer.direct || customer.managers.length === 0) return NONE
  return customer.managers[0]!.customerId
}

/** Keep a manager choice only while it is still one of the chosen account's routes. */
export function reconcileManager(customer: GoogleAdsCustomerChoice | null | undefined, manager: string): string {
  const options = managerOptions(customer)
  if (!options) return NONE
  return options.some((o) => o.value === manager) ? manager : defaultManager(customer)
}

export function merchantOptions(choices: GoogleChoices | null): ListboxPanelOption[] {
  return [
    { value: NONE, label: 'None' },
    ...(choices?.merchantCenter.accounts ?? []).map((a) => ({
      value: a.id, label: a.name?.trim() || 'Unnamed Merchant Center account', trailing: a.id, searchText: a.id, ...held(takenElsewhere(a)),
    })),
  ]
}

export function analyticsOptions(choices: GoogleChoices | null): ListboxPanelOption[] {
  return [
    { value: NONE, label: 'None' },
    ...(choices?.analytics.properties ?? []).map((p) => ({
      value: p.propertyId,
      label: p.name?.trim() || 'Unnamed Google Analytics property',
      group: p.accountName?.trim() || 'Google Analytics',
      searchText: p.propertyId,
      ...held(takenElsewhere(p)),
    })),
  ]
}

/** A Merchant Center or Analytics pick this business may keep: None, or an option that is offered and not held. */
const keepable = (options: ListboxPanelOption[], value: string) => value === NONE || options.some((o) => o.value === value && !o.heldReason)

export interface SelectionDraft {
  ads: string
  manager: string
  merchantCenter: string
  analytics: string
}

/**
 * What the dialog opens on: the saved choice, kept only where this sign-in still offers it and no other business has
 * picked it. The only Google Ads account is preselected only when no other business has picked it.
 */
export function initialDraft(current: GoogleAccount | null | undefined, choices: GoogleChoices | null): SelectionDraft {
  const readable = readableCustomers(choices)
  const choosable = choosableCustomers(choices)
  const ads = current?.ads && choosable.some((c) => c.customerId === current.ads!.customerId)
    ? current.ads.customerId
    : readable.length === 1 && choosable.length === 1 ? choosable[0]!.customerId : NONE
  const customer = choosable.find((c) => c.customerId === ads)
  const savedManager = current?.manager?.customerId ?? (current?.ads ? NONE : defaultManager(customer))
  const merchant = current?.merchantCenter?.id ?? NONE
  const property = current?.analytics?.propertyId ?? NONE
  return {
    ads,
    manager: reconcileManager(customer, savedManager),
    merchantCenter: keepable(merchantOptions(choices), merchant) ? merchant : NONE,
    analytics: keepable(analyticsOptions(choices), property) ? property : NONE,
  }
}

/**
 * After the lists are read again (Try again, or a refused save): keep each pick that is still offered and that no other
 * business has picked in the meantime.
 */
export function reconcileDraft(draft: SelectionDraft, choices: GoogleChoices | null): SelectionDraft {
  const customer = choosableCustomers(choices).find((c) => c.customerId === draft.ads)
  return {
    ads: customer ? draft.ads : NONE,
    manager: reconcileManager(customer, draft.manager),
    merchantCenter: keepable(merchantOptions(choices), draft.merchantCenter) ? draft.merchantCenter : NONE,
    analytics: keepable(analyticsOptions(choices), draft.analytics) ? draft.analytics : NONE,
  }
}

/** Picking another Google Ads account resets the manager to that account's own default route. */
export function chooseAds(draft: SelectionDraft, ads: string, choices: GoogleChoices | null): SelectionDraft {
  const customer = readableCustomers(choices).find((c) => c.customerId === ads)
  return { ...draft, ads, manager: defaultManager(customer) }
}

/** Saved only with an offered Google Ads account, and nothing another business in Nexus already picked. */
export function canSave(draft: SelectionDraft, choices: GoogleChoices | null): boolean {
  return draft.ads !== NONE && choosableCustomers(choices).some((c) => c.customerId === draft.ads)
    && keepable(merchantOptions(choices), draft.merchantCenter) && keepable(analyticsOptions(choices), draft.analytics)
}

/**
 * Why Save is held, in plain words; null when it may be pressed. When every Google Ads account here is picked by another
 * business already, choosing is not enough, and the reason says so. Never names that business.
 */
export function saveHeldReason(draft: SelectionDraft | null, choices: GoogleChoices | null): string | null {
  if (draft && canSave(draft, choices)) return null
  const readable = readableCustomers(choices)
  if (readable.length > 0 && choosableCustomers(choices).length === 0) {
    return readable.length === 1
      ? 'The only Google Ads account here is chosen in another business in Nexus. An account can belong to one business only.'
      : 'Every Google Ads account here is chosen in another business in Nexus. An account can belong to one business only.'
  }
  if (!draft || draft.ads === NONE) return 'Choose the Google Ads account Nexus reads first.'
  const heldPick = (options: ListboxPanelOption[], value: string) => value !== NONE && options.some((o) => o.value === value && o.heldReason)
  if (readable.some((c) => c.customerId === draft.ads && takenElsewhere(c))) {
    return 'This Google Ads account is chosen in another business in Nexus. Choose another one.'
  }
  if (heldPick(merchantOptions(choices), draft.merchantCenter)) {
    return 'This Merchant Center account is chosen in another business in Nexus. Choose another one, or None.'
  }
  if (heldPick(analyticsOptions(choices), draft.analytics)) {
    return 'This Google Analytics property is chosen in another business in Nexus. Choose another one, or None.'
  }
  return 'This Google sign-in can no longer see one of the chosen accounts. Choose again.'
}

/** The C3 body. "None" travels as null. */
export function selectionBody(draft: SelectionDraft): GoogleSelectionBody {
  return {
    adsCustomerId: draft.ads,
    managerCustomerId: draft.manager || null,
    merchantCenterId: draft.merchantCenter || null,
    analyticsPropertyId: draft.analytics || null,
  }
}

export type SectionProduct = 'ads' | 'merchant_center' | 'analytics'

const PRODUCT_NAME: Record<SectionProduct, string> = {
  ads: 'Google Ads',
  merchant_center: 'Merchant Center',
  analytics: 'Google Analytics',
}

export interface SectionErrorView {
  tone: 'danger' | 'warning' | 'info'
  title: string
  text: string
  /** The one button the banner carries, if any. */
  action: 'reconnect' | 'retry' | null
}

/** One section's failure, in words. Each section fails on its own; the others stay usable. */
export function sectionError(product: SectionProduct, error: GoogleChoiceError | null): SectionErrorView | null {
  if (!error) return null
  const name = PRODUCT_NAME[product]
  switch (error.code) {
    case 'permission_missing':
      return { tone: 'warning', title: `No access to ${name}`, text: `Google did not give Nexus access to ${name}. Reconnect and tick every box on Google's screen.`, action: 'reconnect' }
    case 'no_access':
      return product === 'ads'
        ? { tone: 'warning', title: 'No Google Ads account found', text: "This Google sign-in cannot see any Google Ads account. Sign in with a Google user that has access, or ask the account's owner to add you.", action: 'reconnect' }
        : { tone: 'info', title: `No ${name} account found`, text: `This Google sign-in cannot see any ${name} account.`, action: null }
    case 'account_not_active':
      // Google sees the account but will not open it (cancelled, closed or not yet enabled); a reconnect changes nothing.
      return { tone: 'warning', title: `This ${name} account is not active`, text: `Google says this ${name} account is cancelled, closed or not yet enabled, so Nexus cannot read it. Turn it on again in ${name}, then open this window again a few minutes later.`, action: null }
    case 'app_not_approved':
      return { tone: 'warning', title: 'Google has not approved Nexus yet', text: 'Google has not yet approved Nexus to read real Google Ads accounts; only test accounts can be read.', action: null }
    case 'not_registered':
      return { tone: 'info', title: 'Merchant Center is not set up for Nexus yet', text: 'Google has not registered Nexus with this Merchant Center account yet. Nexus cannot list or read it until that one-time step is done.', action: null }
    case 'google_unavailable':
      // The server's sentence when it has one: it may be that Nexus did not ask at all (its daily Google allowance is
      // used up, with when to try again), which "Google did not answer" would misstate.
      return { tone: 'danger', title: `${name} could not be listed`, text: error.message?.trim() || 'Google did not answer. Try again.', action: 'retry' }
    default:
      return { tone: 'danger', title: `${name} could not be listed`, text: error.message || 'Google did not answer. Try again.', action: 'retry' }
  }
}

const TAKEN_TITLE: Record<GoogleSignInProduct, string> = {
  ads: 'This Google Ads account belongs to another business',
  merchant_center: 'This Merchant Center account belongs to another business',
  analytics: 'This Google Analytics property belongs to another business',
}

/** A refused save (409), in words. Never names the other business. */
export function conflictText(code: GoogleSelectionConflict | null, fallback: string, product?: GoogleSignInProduct): { title: string; text: string } {
  if (code === 'taken_by_other_business') {
    // One Google login may be connected in many businesses, but each Google account is picked by one business only.
    return {
      title: TAKEN_TITLE[product ?? 'ads'],
      text: fallback || 'Another business in Nexus already uses this account. An account can belong to one business only. Choose another one.',
    }
  }
  if (code === 'customer_taken') {
    return { title: 'Another Google sign-in holds the choice', text: 'This business already reads a Google Ads account through another Google sign-in. Change the choice there, or disconnect that sign-in first.' }
  }
  if (code === 'not_offered') {
    return { title: 'Google no longer offers this choice', text: 'This Google sign-in can no longer see one of the chosen accounts. The lists were read again: choose again.' }
  }
  return { title: 'The choice was not saved', text: fallback }
}

/** The notice after a save. It says what happens next, and never that anything is read or live yet. */
export function savedNotice(account: GoogleAccount): { title: string; text: string } {
  const name = account.ads?.name?.trim() || 'the chosen Google Ads account'
  return {
    title: 'Google accounts saved.',
    text: `Nexus has queued the first read of ${name}. Its campaigns appear in Ads › Google when the read finishes. Nothing is changed in Google Ads.`,
  }
}

export interface GoogleChip {
  text: string
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'
}

/**
 * The Google card's chips: what this business chose, and what is only chosen (not read). A chip is one line and ends in
 * an ellipsis when it is wider than the card, so what the chip SAYS comes before the name: a long name is what gets
 * cut, never "not read yet".
 */
export function googleChips(account: GoogleAccount): GoogleChip[] {
  const chips: GoogleChip[] = []
  if (!account.ads) chips.push({ text: 'Google Ads account: not chosen', tone: 'warning' })
  else chips.push({ text: ['Google Ads: ' + (account.ads.name?.trim() || 'unnamed account'), account.ads.currency?.trim(), account.ads.isTest ? 'test account' : ''].filter(Boolean).join(' · '), tone: account.state === 'ok' ? 'success' : account.state === 'read_failed' ? 'danger' : 'neutral' })
  if (account.manager) chips.push({ text: `Manager: ${account.manager.name?.trim() || 'unnamed manager account'}`, tone: 'neutral' })
  if (account.merchantCenter) chips.push({ text: `Merchant Center (not read yet): ${account.merchantCenter.name?.trim() || 'unnamed account'}`, tone: 'neutral' })
  if (account.analytics) chips.push({ text: `Analytics (not read yet): ${account.analytics.name?.trim() || 'unnamed property'}`, tone: 'neutral' })
  return chips
}

/** The detail card's line under the chosen Google Ads account: "EUR · days in Europe/Rome", only the parts known. */
export function adsAccountHint(ads: { currency: string | null; timeZone: string | null }): string | undefined {
  const timeZone = ads.timeZone?.trim()
  return currencyAndTimeZone({ currency: ads.currency, timeZone: timeZone ? `days in ${timeZone}` : null })
}

/** Whether the card offers "Choose accounts" (no Google Ads account chosen yet). */
export function needsChoice(account: GoogleAccount): boolean {
  return !account.ads || account.state === 'choose_account'
}

/** The read state in words, for the detail page's card. */
export function readStateText(account: GoogleAccount): string {
  if (account.stateText?.trim()) return account.stateText.trim()
  switch (account.state) {
    case 'sign_in_needed': return 'Google needs a new sign-in. Reconnect.'
    case 'permission_missing': return 'Google did not give Nexus every permission it asked for. Reconnect and tick every box.'
    case 'choose_account': return 'Choose the Google Ads account Nexus reads.'
    case 'first_read_pending': return 'Nexus has not finished the first read yet.'
    case 'read_failed': return 'The last read from Google failed.'
    default: return 'Nexus reads this account once a day.'
  }
}

/**
 * Google's scopes in words, for the detail page's Permissions card (`shortScope` falls through to this). Returns null
 * for a scope that is not Google's.
 */
export function googleScopeName(scope: string): string | null {
  switch (scope) {
    case 'https://www.googleapis.com/auth/adwords': return 'Google Ads'
    case 'https://www.googleapis.com/auth/content': return 'Merchant Center'
    case 'https://www.googleapis.com/auth/analytics.readonly': return 'Google Analytics (read)'
    case 'https://www.googleapis.com/auth/userinfo.email': return 'E-mail address'
    case 'openid': return 'Sign-in (OpenID)'
    default: return null
  }
}
