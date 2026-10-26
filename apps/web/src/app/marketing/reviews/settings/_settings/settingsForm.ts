/**
 * Reviews › Settings — the part of the page saved with the EditModeBar (⌘S, Discard, Save changes): the reply voice
 * (tone, reply languages, sign-off, words to avoid) and the review alerts (on/off, who, how). Pure: the page keeps the
 * saved form and the draft, counts what differs, holds Save with the first reason that applies, and sends only what
 * changed (`PUT /api/reviews/settings { voice?, alerts? }`). Tested in settingsForm.vitest.test.ts.
 *
 * The API checks the same rules again (review-settings.service.ts); these words match its words.
 */

export type Tone = 'WARM' | 'NEUTRAL' | 'FORMAL'
export type ReplyLanguage = 'buyer' | 'it' | 'de' | 'fr' | 'es' | 'en'
export type AlertKey = 'negative' | 'digest'
export type AlertVia = 'app' | 'email'

export interface SenderView {
  name: string | null
  address: string | null
  replyTo: string | null
  editHref: string
  problem: string | null
}

/** GET /api/reviews/settings. */
export interface SettingsResponse {
  voice: { tone: Tone; languages: ReplyLanguage[]; signOff: string | null; avoidWords: string[] }
  alerts: Array<{ key: AlertKey; on: boolean; recipients: Array<{ userId: string; name: string }>; via: AlertVia[] }>
  sender: SenderView
  team: Array<{ userId: string; name: string; owner: boolean }>
  digestFallback: string[]
  automationTemplates: { total: number; missing: number }
  updatedAt: string | null
  updatedBy: string | null
}

export interface VoiceForm {
  tone: Tone
  languages: ReplyLanguage[]
  signOff: string
  avoidWords: string[]
}

export interface AlertForm {
  key: AlertKey
  on: boolean
  recipients: string[]
  via: AlertVia[]
}

export interface SettingsForm {
  voice: VoiceForm
  alerts: AlertForm[]
}

export const SIGN_OFF_MAX = 80

export const TONE_OPTIONS: ReadonlyArray<{ value: Tone; label: string }> = [
  { value: 'WARM', label: 'Warm' },
  { value: 'NEUTRAL', label: 'Neutral' },
  { value: 'FORMAL', label: 'Formal' },
]

export const TONE_HINT: Record<Tone, string> = {
  WARM: 'First names, short sentences, thanks first.',
  NEUTRAL: 'Plain and polite, no small talk.',
  FORMAL: 'The polite form of address (Lei, Sie, vous, usted), no first names.',
}

export const LANGUAGE_OPTIONS: ReadonlyArray<{ value: ReplyLanguage; label: string }> = [
  { value: 'buyer', label: 'Buyer’s language' },
  { value: 'it', label: 'Italian' },
  { value: 'de', label: 'German' },
  { value: 'fr', label: 'French' },
  { value: 'es', label: 'Spanish' },
  { value: 'en', label: 'English' },
]

export const ALERT_NAME: Record<AlertKey, string> = { negative: 'New negative review', digest: 'Daily digest' }
export const ALERT_WHEN: Record<AlertKey, string> = {
  negative: 'A new review of 1 or 2 stars, or negative feedback, on any channel. Imported files never alert.',
  digest: 'Every morning at 08:00 UTC: new reviews, what waits for a reply, open spikes and pipeline problems.',
}

export function formFromSettings(s: Pick<SettingsResponse, 'voice' | 'alerts'>): SettingsForm {
  return {
    voice: { tone: s.voice.tone, languages: [...s.voice.languages], signOff: s.voice.signOff ?? '', avoidWords: [...s.voice.avoidWords] },
    alerts: s.alerts.map((a) => ({ key: a.key, on: a.on, recipients: a.recipients.map((r) => r.userId), via: [...a.via] })),
  }
}

// ── Edits ────────────────────────────────────────────────────────────────────────────────────────────────────────

const ORDER: ReplyLanguage[] = LANGUAGE_OPTIONS.map((o) => o.value)

export function setTone(form: SettingsForm, tone: Tone): SettingsForm {
  return { ...form, voice: { ...form.voice, tone } }
}

export function toggleLanguage(form: SettingsForm, language: ReplyLanguage, on: boolean): SettingsForm {
  const next = new Set(form.voice.languages)
  if (on) next.add(language)
  else next.delete(language)
  return { ...form, voice: { ...form.voice, languages: ORDER.filter((l) => next.has(l)) } }
}

export function setSignOff(form: SettingsForm, signOff: string): SettingsForm {
  return { ...form, voice: { ...form.voice, signOff } }
}

export function setAvoidWords(form: SettingsForm, words: string[]): SettingsForm {
  const seen = new Set<string>()
  const clean: string[] = []
  for (const w of words.map((x) => x.trim()).filter(Boolean)) {
    if (seen.has(w.toLowerCase())) continue
    seen.add(w.toLowerCase())
    clean.push(w)
  }
  return { ...form, voice: { ...form.voice, avoidWords: clean } }
}

function withAlert(form: SettingsForm, key: AlertKey, change: (a: AlertForm) => AlertForm): SettingsForm {
  return { ...form, alerts: form.alerts.map((a) => (a.key === key ? change(a) : a)) }
}

export function setAlertOn(form: SettingsForm, key: AlertKey, on: boolean): SettingsForm {
  return withAlert(form, key, (a) => ({ ...a, on }))
}

export function setAlertRecipients(form: SettingsForm, key: AlertKey, recipients: string[]): SettingsForm {
  return withAlert(form, key, (a) => ({ ...a, recipients: [...new Set(recipients)] }))
}

export function toggleAlertVia(form: SettingsForm, key: AlertKey, via: AlertVia, on: boolean): SettingsForm {
  return withAlert(form, key, (a) => {
    const next = new Set(a.via)
    if (on) next.add(via)
    else next.delete(via)
    return { ...a, via: (['app', 'email'] as AlertVia[]).filter((v) => next.has(v)) }
  })
}

// ── What changed ─────────────────────────────────────────────────────────────────────────────────────────────────

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x))
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

function voiceChanges(saved: VoiceForm, draft: VoiceForm): number {
  return [
    saved.tone !== draft.tone,
    !sameSet(saved.languages, draft.languages),
    saved.signOff.trim() !== draft.signOff.trim(),
    !sameList(saved.avoidWords, draft.avoidWords),
  ].filter(Boolean).length
}

function alertChanges(saved: AlertForm | undefined, draft: AlertForm): number {
  if (!saved) return 1
  return [saved.on !== draft.on, !sameSet(saved.recipients, draft.recipients), !sameSet(saved.via, draft.via)].filter(Boolean).length
}

/** How many settings differ from what is saved (the EditModeBar's count). */
export function dirtyCount(saved: SettingsForm, draft: SettingsForm): number {
  return voiceChanges(saved.voice, draft.voice) + draft.alerts.reduce((n, a) => n + alertChanges(saved.alerts.find((s) => s.key === a.key), a), 0)
}

/** The PUT body: the voice when any of it changed, and only the alerts that changed. Null when nothing did. */
export function settingsPayload(saved: SettingsForm, draft: SettingsForm): { voice?: Record<string, unknown>; alerts?: AlertForm[] } | null {
  const body: { voice?: Record<string, unknown>; alerts?: AlertForm[] } = {}
  if (voiceChanges(saved.voice, draft.voice) > 0) {
    body.voice = { tone: draft.voice.tone, languages: draft.voice.languages, signOff: draft.voice.signOff.trim() || null, avoidWords: draft.voice.avoidWords }
  }
  const alerts = draft.alerts.filter((a) => alertChanges(saved.alerts.find((s) => s.key === a.key), a) > 0)
  if (alerts.length) body.alerts = alerts.map((a) => ({ key: a.key, on: a.on, recipients: a.recipients, via: a.via }))
  return body.voice || body.alerts ? body : null
}

/** Why Save is held now, or null: the first problem in the draft (the API refuses the same). */
export function saveHeldReason(draft: SettingsForm): string | null {
  if (draft.voice.languages.length === 0) return 'Pick at least one reply language.'
  const signOff = draft.voice.signOff.trim()
  if (signOff.length > SIGN_OFF_MAX) return `Keep the sign-off to ${SIGN_OFF_MAX} characters (it has ${signOff.length}).`
  const negative = draft.alerts.find((a) => a.key === 'negative')
  if (negative?.on && negative.via.length === 0) return 'Choose how “New negative review” arrives: in Nexus, by e-mail or both.'
  return null
}

/** Under the "who" picker: what happens when nobody is picked. */
export function recipientsHint(alert: AlertForm, digestFallback: readonly string[]): string {
  if (alert.recipients.length > 0) return alert.recipients.length === 1 ? 'Goes to 1 person.' : `Goes to ${alert.recipients.length} people.`
  if (alert.key === 'digest') {
    return digestFallback.length ? `Nobody picked: it goes to ${digestFallback.join(', ')}, as today.` : 'Nobody picked and no address to fall back on: nobody gets it.'
  }
  return 'Nobody picked: the business’s owners get it.'
}
