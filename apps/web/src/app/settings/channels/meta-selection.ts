/**
 * Meta ads (steps 1–2) — the pure half of Settings › Channels › Meta: the "Connect Meta" form (app id, app secret,
 * system-user token), the token's health in words, the asset picker (one ad account, optional Page and Instagram
 * account) and the Meta card's chips.
 *
 * JSX-free so the node-only web suite tests it; `MetaCredentialsDialog.tsx`, `MetaAccountsDialog.tsx`, `ConnectTab.tsx`
 * and `[type]/MetaConnectionCard.tsx` are thin over these. The words are the ones a person reads: plain English, no id
 * as a name, never "reading" for something Nexus has not read yet, and never a secret echoed back.
 */
import type { ListboxPanelOption } from '@/design-system/components'
import { formatDay } from '@/app/marketing/ads/meta/metaAds'
import type {
  MetaChoices, MetaConnectAnswer, MetaConnectCode, MetaConnection, MetaCredentialsBody, MetaProduct, MetaSelectionBody, MetaSelectionConflict, MetaTokenHealth, MetaTokenView,
} from '@/lib/meta-ads/contract'

export { META_KEY } from '@/lib/meta-ads/contract'

/** The Listbox value of "None" (Page, Instagram account). */
export const NONE = ''

/** What an asset another business in Nexus already picked says in the list. One business per asset; never which. */
export const TAKEN_ELSEWHERE = 'Used by another business in Nexus'
/** An Instagram account goes with its linked Page: one whose Page another business uses is held too. */
export const PAGE_TAKEN_ELSEWHERE = 'Its Facebook Page is used by another business in Nexus'

const held = (taken: boolean, reason: string = TAKEN_ELSEWHERE) => (taken ? { heldReason: reason, note: reason } : {})

// ─── The form ───────────────────────────────────────────────────────────

/**
 * The app secret and the system-user token are typed in once and never kept: the DS secret pattern (a masked input with
 * autoComplete="new-password", as the app-secrets card) plus the password managers' own "ignore this field" attributes
 * (1Password, LastPass, Bitwarden, Dashlane), so no browser or manager offers to save or fill them.
 */
export const SECRET_INPUT_PROPS = {
  type: 'password',
  autoComplete: 'new-password',
  spellCheck: false,
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
} as const

export interface CredentialsDraft { appId: string; appSecret: string; systemUserToken: string }
export const EMPTY_CREDENTIALS: CredentialsDraft = { appId: '', appSecret: '', systemUserToken: '' }

/** Each field's problem in words (the server checks again), or null when the field looks like Meta's. */
export function credentialProblems(d: CredentialsDraft): { appId: string | null; appSecret: string | null; systemUserToken: string | null } {
  const appId = d.appId.trim()
  const secret = d.appSecret.trim()
  const token = d.systemUserToken.trim()
  return {
    appId: !appId ? 'Paste the App ID.' : /^\d{5,25}$/.test(appId) ? null : 'The App ID is digits only (App settings › Basic).',
    appSecret: !secret ? 'Paste the App secret.' : /^[A-Fa-f0-9]{16,128}$/.test(secret) ? null : 'The App secret is letters a–f and digits, with no spaces.',
    systemUserToken: !token ? 'Paste the system-user token.' : /^[A-Za-z0-9._|-]{20,2048}$/.test(token) ? null : 'Paste the token exactly as Meta showed it, with no spaces.',
  }
}

export function canSubmitCredentials(d: CredentialsDraft): boolean {
  const p = credentialProblems(d)
  return !p.appId && !p.appSecret && !p.systemUserToken
}

/** The body sent once; the dialog forgets the values right after (never kept in browser storage). */
export function credentialsBody(d: CredentialsDraft): MetaCredentialsBody {
  return { appId: d.appId.trim(), appSecret: d.appSecret.trim(), systemUserToken: d.systemUserToken.trim() }
}

const CONNECT_TITLE: Record<MetaConnectCode, string> = {
  invalid_app_id: 'The App ID is not one Meta uses',
  invalid_app_secret: 'The App secret is not in Meta\'s form',
  invalid_token: 'The token is not in Meta\'s form',
  token_refused: 'Meta does not accept this token',
  wrong_app: 'The token and the app do not match',
  not_system_user: 'This is not a system-user token',
  missing_permission: 'The token lacks a permission',
  meta_unreachable: 'Meta could not be reached',
  already_connected: 'This system user is already connected here',
  not_found: 'This connection is not in this business',
}

/** A refused connect, in words: the server's own sentence under a short title. Nothing was saved. */
export function connectRefusal(code: MetaConnectCode | null, error: string): { title: string; text: string } {
  return { title: code ? CONNECT_TITLE[code] : 'Meta was not connected', text: `${error} Nothing was saved.` }
}

// ─── The token, in words ────────────────────────────────────────────────

// The Ads pages' own words for a day ("30 Oct 2026").
const day = (iso: string | null) => formatDay(iso?.slice(0, 10))

export interface TokenLine { label: string; value: string; tone?: 'success' | 'warning' | 'danger' | 'neutral' }

/** The token's health as the card's facts: valid, expiry and renewal, type, permissions lacking. Never the token. */
export function tokenLines(t: MetaTokenView, now: number = Date.now()): TokenLine[] {
  const lines: TokenLine[] = []
  lines.push(t.isValid === null
    ? { label: 'Token', value: 'Not checked yet', tone: 'neutral' }
    : t.isValid ? { label: 'Token', value: 'Valid', tone: 'success' } : { label: 'Token', value: t.problem ?? 'Meta says it is not valid', tone: 'danger' })
  if (t.neverExpires) lines.push({ label: 'Expires', value: 'Does not expire by date' })
  else if (t.expiresAt) {
    const left = Date.parse(t.expiresAt) - now
    lines.push({ label: 'Expires', value: day(t.expiresAt), tone: left <= 0 ? 'danger' : left < 14 * 86_400_000 ? 'warning' : undefined })
    if (t.renewsFrom) lines.push({ label: 'Renewal', value: `Nexus renews it from ${day(t.renewsFrom)} (60 days each time)` })
  } else lines.push({ label: 'Expires', value: 'Not known yet' })
  lines.push({ label: 'Token type', value: t.type ? t.typeText : 'Token type not reported by Meta' })
  if (t.checkedAt) lines.push({ label: 'Last checked', value: day(t.checkedAt) })
  return lines
}

/** What "Check token now" found, in words. Never the token. */
export function tokenCheckNote(h: MetaTokenHealth): { tone: 'success' | 'warning' | 'danger'; title: string; text?: string } {
  if (!h.isValid) return { tone: 'danger', title: 'Meta says the token is not valid', text: `${h.problem ?? 'Meta gave no reason.'} Replace the credentials with a new system-user token.` }
  if (!h.appMatches) return { tone: 'danger', title: 'The token belongs to another app', text: 'Meta made this token for a different app than the App ID saved here. Replace the credentials.' }
  const required = h.missing.filter((m) => m.required)
  if (required.length > 0) return { tone: 'warning', title: 'The token lacks a required permission', text: `Generate a new token with ${required.map((m) => m.scope).join(', ')}, then replace the credentials.` }
  return { tone: 'success', title: 'Meta says the token is valid.', text: h.neverExpires ? 'It does not expire by date.' : h.expiresAt ? `It expires on ${day(h.expiresAt)}.` : undefined }
}

/** The permissions the token lacks, required first, each with what Nexus needs it for. */
export function missingPermissionLines(t: MetaTokenView): string[] {
  return [...t.missing].sort((a, b) => Number(b.required) - Number(a.required))
    .map((m) => `${m.scope}${m.required ? ' (required)' : ''}: to ${m.neededFor}`)
}

// ─── The picker ─────────────────────────────────────────────────────────

const adName = (a: { name: string | null }) => a.name?.trim() || 'Unnamed ad account'

/** An asset another business uses: its id and "used by another business", held, in a group of its own — never a name. */
const takenOption = (id: string, shownId: string = id): ListboxPanelOption & { group: string } => ({
  value: id, label: 'Used by another business', group: TAKEN_ELSEWHERE, trailing: shownId, searchText: id, ...held(true),
})

export function adAccountOptions(choices: MetaChoices | null): ListboxPanelOption[] {
  return (choices?.adAccounts.items ?? [])
    .map((a) => (a.takenByAnotherBusiness ? takenOption(a.adAccountId, `act_${a.adAccountId}`) : {
      value: a.adAccountId,
      label: adName(a),
      group: a.businessName?.trim() || 'Ad accounts',
      trailing: `act_${a.adAccountId}`,
      searchText: [a.adAccountId, a.currency, a.businessName].filter(Boolean).join(' '),
      note: [a.statusText, a.currency, a.timeZone].filter(Boolean).join(' · ') || undefined,
    }))
    .sort((a, b) => (a.group === b.group ? a.label.localeCompare(b.label) : a.group.localeCompare(b.group)))
}

export function pageOptions(choices: MetaChoices | null): ListboxPanelOption[] {
  return [
    { value: NONE, label: 'None' },
    ...(choices?.pages.items ?? []).map((p) => (p.takenByAnotherBusiness ? takenOption(p.pageId) : { value: p.pageId, label: p.name?.trim() || 'Unnamed Facebook Page', searchText: p.pageId })),
  ]
}

export function instagramOptions(choices: MetaChoices | null): ListboxPanelOption[] {
  return [
    { value: NONE, label: 'None' },
    ...(choices?.instagram.items ?? []).map((i) => (i.takenByAnotherBusiness ? takenOption(i.instagramId) : {
      value: i.instagramId, label: i.username ? `@${i.username}` : 'Instagram account', searchText: i.instagramId, ...held(i.pageTakenByAnotherBusiness === true, PAGE_TAKEN_ELSEWHERE),
    })),
  ]
}

const keepable = (options: ListboxPanelOption[], value: string) => value === NONE || options.some((o) => o.value === value && !o.heldReason)
const choosable = (choices: MetaChoices | null) => (choices?.adAccounts.items ?? []).filter((a) => !a.takenByAnotherBusiness)

export interface MetaDraft { adAccount: string; page: string; instagram: string }

/** What the picker opens on: the saved choice where it is still offered and free; the only free ad account otherwise. */
export function initialMetaDraft(current: MetaConnection | null | undefined, choices: MetaChoices | null): MetaDraft {
  const free = choosable(choices)
  const saved = current?.adAccount?.adAccountId
  const adAccount = saved && free.some((a) => a.adAccountId === saved) ? saved : free.length === 1 && (choices?.adAccounts.items.length ?? 0) === 1 ? free[0]!.adAccountId : NONE
  const page = current?.page?.pageId ?? NONE
  const instagram = current?.instagram?.instagramId ?? NONE
  return {
    adAccount,
    page: keepable(pageOptions(choices), page) ? page : NONE,
    instagram: keepable(instagramOptions(choices), instagram) ? instagram : NONE,
  }
}

/** After the lists are read again: keep each pick still offered and still free. */
export function reconcileMetaDraft(d: MetaDraft, choices: MetaChoices | null): MetaDraft {
  return {
    adAccount: choosable(choices).some((a) => a.adAccountId === d.adAccount) ? d.adAccount : NONE,
    page: keepable(pageOptions(choices), d.page) ? d.page : NONE,
    instagram: keepable(instagramOptions(choices), d.instagram) ? d.instagram : NONE,
  }
}

export function canSaveMeta(d: MetaDraft, choices: MetaChoices | null): boolean {
  return d.adAccount !== NONE && choosable(choices).some((a) => a.adAccountId === d.adAccount)
    && keepable(pageOptions(choices), d.page) && keepable(instagramOptions(choices), d.instagram)
}

/** Why Save is held, in words; null when it may be pressed. Never names another business. */
export function metaSaveHeldReason(d: MetaDraft | null, choices: MetaChoices | null): string | null {
  if (d && canSaveMeta(d, choices)) return null
  const all = choices?.adAccounts.items ?? []
  if (all.length === 0) return 'Meta lists no ad account for this system user. Assign the ad account to the system user in Meta Business settings, then read the lists again.'
  if (choosable(choices).length === 0) return all.length === 1
    ? 'The only ad account here is used by another business in Nexus. An ad account can belong to one business only.'
    : 'Every ad account here is used by another business in Nexus. An ad account can belong to one business only.'
  if (!d || d.adAccount === NONE) return 'Choose the ad account Nexus reads first.'
  return 'One of the chosen assets is no longer offered or is used by another business. Choose again.'
}

export function metaSelectionBody(d: MetaDraft): MetaSelectionBody {
  return { adAccountId: d.adAccount, pageId: d.page || null, instagramId: d.instagram || null }
}

const TAKEN_TITLE: Record<MetaProduct, string> = {
  AD_ACCOUNT: 'This ad account belongs to another business',
  PAGE: 'This Facebook Page belongs to another business',
  INSTAGRAM: 'This Instagram account belongs to another business',
}

/** A refused save (409), in words. Never names the other business. */
export function metaConflictText(code: MetaSelectionConflict | null, fallback: string, product: MetaProduct | null): { title: string; text: string } {
  if (code === 'taken_by_other_business') return { title: TAKEN_TITLE[product ?? 'AD_ACCOUNT'], text: fallback || 'Another business in Nexus already uses it. Choose another one.' }
  if (code === 'account_taken') return { title: 'Another Meta connection holds the choice', text: fallback || 'This business already reads an ad account through another Meta connection.' }
  if (code === 'not_offered') return { title: 'Meta no longer offers this choice', text: fallback || 'The system user can no longer see one of the chosen assets. Read the lists again and choose again.' }
  return { title: 'The choice was not saved', text: fallback }
}

export function metaSavedNotice(c: MetaConnection): { title: string; text: string } {
  const name = c.adAccount?.name?.trim() || 'the chosen ad account'
  return { title: 'Meta assets saved.', text: `Nexus has queued the first read of ${name}. Its campaigns appear in Ads › Meta when the read finishes. Nothing is changed in Meta.` }
}

/** What a saved connect or replace says. A new connection that sees ad accounts goes on to the asset picker. */
export function metaConnectedNotice(answer: MetaConnectAnswer): { title: string; text: string } {
  const seen = answer.adAccountsSeen
  if (answer.placement === 'reconsent') return { title: 'Meta credentials replaced.', text: 'Meta accepted the new token. The assets chosen before stay chosen.' }
  return {
    title: 'Meta connected.',
    text: seen > 0
      ? `Meta accepted the token. Choose which of the ${seen} ad account${seen === 1 ? '' : 's'} Nexus reads.`
      : 'Meta accepted the token, but lists no ad account for this system user yet. Assign the ad account to the system user in Meta Business settings, then choose it here.',
  }
}

// ─── The card ───────────────────────────────────────────────────────────

export interface MetaChip { text: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }

/** The Meta card's chips: the chosen assets, what lacks, and a token about to expire. */
export function metaChips(c: MetaConnection, now: number = Date.now()): MetaChip[] {
  const chips: MetaChip[] = []
  if (!c.adAccount) chips.push({ text: 'Ad account: not chosen', tone: 'warning' })
  else chips.push({ text: ['Ad account: ' + (c.adAccount.name?.trim() || 'unnamed'), c.adAccount.currency?.trim()].filter(Boolean).join(' · '), tone: c.state === 'ok' ? 'success' : c.state === 'read_failed' ? 'danger' : 'neutral' })
  if (c.page) chips.push({ text: `Page: ${c.page.name?.trim() || 'unnamed'}`, tone: 'neutral' })
  if (c.instagram) chips.push({ text: `Instagram: ${c.instagram.username ? `@${c.instagram.username}` : 'account'}`, tone: 'neutral' })
  const exp = c.token.expiresAt ? Date.parse(c.token.expiresAt) : NaN
  if (Number.isFinite(exp) && exp - now < 14 * 86_400_000) chips.push({ text: `Token expires ${day(c.token.expiresAt)}`, tone: exp <= now ? 'danger' : 'warning' })
  if (c.token.isValid === false) chips.push({ text: 'Token not valid', tone: 'danger' })
  return chips
}

/** Whether the card offers "Choose assets". */
export function needsMetaChoice(c: MetaConnection): boolean {
  return c.state === 'choose_account'
}
