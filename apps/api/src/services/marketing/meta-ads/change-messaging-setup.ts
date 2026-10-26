/**
 * Meta step 38 (2026-10-26) — message templates and the messaging setup as drafts (pure: built from a request and the live
 * state, no call). Master rows EN-923 … EN-925, EN-931, EN-932, EN-940 (set-meta-message-templates) and CR-216, CR-272, EN-045,
 * EN-901, EN-902, EN-904, EN-905, EN-907, EN-908, EN-917, EN-921 (set-meta-messaging-setup); Meta's pages and SDK names in
 * gateway/meta-messaging-rules.ts. Meta has no check (validate_only) for any of these: every preview says so. Nothing here
 * spends money (a WhatsApp template costs only when it is sent, which Nexus does not do).
 *
 * The tools take Nexus's own shapes (camelCase, each part described); these builders turn them into Meta's JSON exactly as the
 * gateway judges it (the same judge, templateComponentsProblem, runs here first, so a preview never shows what the gateway would
 * refuse), and turn what Meta answers back into Nexus's shape for an undo — when Meta's answer holds anything Nexus does not
 * send, that part has no undo and the preview says so.
 */
import type { MetaChangeDraft, MetaChangeRequest } from './change-draft.js'
import { changeLines } from './change-draft.js'
import type { MetaChangeResult } from './write-client.js'
import {
  META_MESSAGE_LIMITS, META_NLP_MODELS, META_PROFILE_FIELDS, META_INSTAGRAM_PROFILE_FIELDS, META_TEMPLATE_LANGUAGE, META_TEMPLATE_NAME, META_WEEK_DAYS,
  META_WHATSAPP_NUMBER, META_VERIFICATION_CODE, templateComponentsProblem,
} from '../../gateway/meta-messaging-rules.js'
import { META_COMMENT_TEXT, META_NAME_TEXT } from '../../gateway/meta-write-text.js'
import type { PageTemplate, TemplateGroupState, WhatsAppTemplate } from './live-messaging-change.js'
import type { MessagingPlatform } from './live-messaging.js'

type Row = Record<string, unknown>
const isObj = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
const json = (v: unknown) => JSON.stringify(v)
const same = (a: unknown, b: unknown) => json(a ?? null) === json(b ?? null)

function request(r: Omit<MetaChangeRequest, 'step' | 'check' | 'raisesSpend' | 'readBackInPost' | 'budget'>, asPage = true): MetaChangeRequest {
  return { step: 1, check: 'none', raisesSpend: false, readBackInPost: false, budget: false, ...(asPage ? { asPage: true as const } : {}), ...r }
}

function draftOf(input: { summary: string; lines: Array<[string, unknown, unknown]>; warnings: string[]; requests: MetaChangeRequest[]; stands: unknown; before: unknown; after: unknown; skipped?: string[] }): MetaChangeDraft {
  const { changes, more } = changeLines(input.lines)
  return {
    summary: input.summary, changes, totals: { requests: input.requests.length, ...(more ? { moreLines: more } : {}) },
    warnings: input.warnings, spendsMoney: [], skipped: input.skipped ?? [], requests: input.requests.map((r, i) => ({ ...r, step: i + 1 })),
    stands: input.stands, before: input.before, after: input.after,
  }
}

const nothing = (summary: string, stands: unknown, record: unknown): MetaChangeDraft => ({ summary, changes: {}, totals: { requests: 0 }, warnings: [], spendsMoney: [], skipped: [summary], requests: [], stands, before: record, after: record })
const madeSentence = (what: string, key = 'id') => (r: MetaChangeResult) => {
  const id = r.node?.[key]
  return `${what}: Meta made it${typeof id === 'string' || typeof id === 'number' ? ` (${id})` : ''}${typeof r.node?.status === 'string' ? `; Meta's review: ${r.node.status}` : ''}.`
}
const confirmedSentence = (what: string) => (r: MetaChangeResult) => `${what}: Meta ${r.node?.success === false || r.node?.result === 'failure' ? 'did not confirm it' : 'confirmed it'}.`

export const SETUP_NO_CHECK = 'Meta has no check (validate_only) for this change: the preview is built from the live settings, read again before it is sent.'

// ── templates ────────────────────────────────────────────────────────────────────────────────────────────────────

export const TEMPLATE_ACTIONS = ['create', 'edit', 'delete', 'group-create', 'group-update', 'group-delete'] as const
export type TemplateAction = typeof TEMPLATE_ACTIONS[number]
export const TEMPLATE_CHANNELS = ['messenger', 'whatsapp'] as const
export type TemplateChannel = typeof TEMPLATE_CHANNELS[number]
export const BUTTON_TYPES = ['url', 'phone', 'postback', 'quick-reply'] as const

/** A template in Nexus's shape: a text header, the body (with its examples), a footer (WhatsApp), buttons. */
export interface TemplateParts {
  header?: { text: string; example?: string }
  body: { text: string; examples?: string[]; namedExamples?: Array<{ name: string; example: string }> }
  footer?: string
  buttons?: Array<{ type: typeof BUTTON_TYPES[number]; text: string; url?: string; phone?: string; payload?: string }>
}
export type ParameterFormat = 'NAMED' | 'POSITIONAL'

const headerName = (text: string) => /\{\{\s*([a-z][a-z0-9_]{0,63})\s*\}\}/.exec(text)?.[1] ?? null
const hasHole = (text: string) => /\{\{/.test(text)

/** Nexus's shape → Meta's components (template reference / utility guide / WhatsApp templates). */
export function componentsOf(parts: TemplateParts, format: ParameterFormat, channel: TemplateChannel): Row[] {
  const out: Row[] = []
  if (parts.header) {
    const example = parts.header.example !== undefined && hasHole(parts.header.text)
      ? (format === 'NAMED' ? { header_text_named_params: [{ param_name: headerName(parts.header.text) ?? '', example: parts.header.example }] } : { header_text: [parts.header.example] })
      : null
    out.push({ type: 'HEADER', format: 'TEXT', text: parts.header.text, ...(example ? { example } : {}) })
  }
  const body = parts.body
  const bodyExample = format === 'NAMED'
    ? (body.namedExamples?.length ? { body_text_named_params: body.namedExamples.map((e) => ({ param_name: e.name, example: e.example })) } : null)
    : (body.examples?.length ? { body_text: [body.examples] } : null)
  out.push({ type: 'BODY', text: body.text, ...(bodyExample ? { example: bodyExample } : {}) })
  if (channel === 'whatsapp' && parts.footer !== undefined) out.push({ type: 'FOOTER', text: parts.footer })
  if (parts.buttons?.length) {
    out.push({
      type: 'BUTTONS',
      buttons: parts.buttons.map((b) => (b.type === 'url' ? { type: 'URL', text: b.text, url: b.url } : b.type === 'phone' ? { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone }
        : b.type === 'postback' ? { type: 'POSTBACK', text: b.text, payload: b.payload } : { type: 'QUICK_REPLY', text: b.text })),
    })
  }
  return out
}

/** Why Nexus's template parts are refused here (the gateway's own judge on the JSON it would send), or null. */
export function partsProblem(parts: TemplateParts, format: ParameterFormat, channel: TemplateChannel): string | null {
  if (channel === 'messenger' && parts.footer !== undefined) return 'A Messenger utility template has no footer (WhatsApp templates do).'
  if (channel === 'messenger' && parts.buttons?.some((b) => b.type === 'quick-reply')) return 'A Messenger utility template takes link, phone and postback buttons (quick-reply buttons are WhatsApp\'s).'
  if (channel === 'whatsapp' && parts.buttons?.some((b) => b.type === 'postback')) return 'A WhatsApp template takes quick-reply, link and phone buttons (postback buttons are Messenger\'s).'
  for (const b of parts.buttons ?? []) {
    if (b.type === 'url' && !b.url) return `The link button "${b.text}" names its url.`
    if (b.type === 'phone' && !b.phone) return `The phone button "${b.text}" names its phone.`
    if (b.type === 'postback' && !b.payload) return `The postback button "${b.text}" names its payload.`
    if ((b.type !== 'url' && b.url) || (b.type !== 'phone' && b.phone) || (b.type !== 'postback' && b.payload)) return `The button "${b.text}" carries a field of another button type.`
  }
  if (format === 'NAMED' && parts.body.examples?.length) return 'A NAMED template gives its examples as namedExamples (name and example).'
  if (format === 'POSITIONAL' && parts.body.namedExamples?.length) return 'namedExamples are for parameterFormat NAMED.'
  const problem = templateComponentsProblem(componentsOf(parts, format, channel), channel, format)
  return problem ? `The template: ${problem}.` : null
}

/** Meta's components → Nexus's shape, or null when Meta's answer holds anything Nexus does not send (then: no undo). */
export function partsFromMeta(components: unknown, format: ParameterFormat, channel: TemplateChannel): TemplateParts | null {
  if (!Array.isArray(components)) return null
  const parts: Partial<TemplateParts> = {}
  for (const c of components) {
    if (!isObj(c)) return null
    const type = String(c.type).toUpperCase()
    const ex = isObj(c.example) ? c.example : null
    if (type === 'HEADER') {
      if (String(c.format ?? 'TEXT').toUpperCase() !== 'TEXT' || typeof c.text !== 'string') return null
      const example = format === 'NAMED' ? (Array.isArray(ex?.header_text_named_params) && isObj(ex.header_text_named_params[0]) ? ex.header_text_named_params[0].example : undefined) : (Array.isArray(ex?.header_text) ? ex.header_text[0] : undefined)
      parts.header = { text: c.text, ...(typeof example === 'string' ? { example } : {}) }
    } else if (type === 'BODY') {
      if (typeof c.text !== 'string') return null
      const named = Array.isArray(ex?.body_text_named_params) ? (ex.body_text_named_params as unknown[]).filter(isObj).map((e) => ({ name: String(e.param_name), example: String(e.example) })) : null
      const positional = Array.isArray(ex?.body_text) && Array.isArray(ex.body_text[0]) ? (ex.body_text[0] as unknown[]).map(String) : null
      parts.body = { text: c.text, ...(format === 'NAMED' && named?.length ? { namedExamples: named } : {}), ...(format === 'POSITIONAL' && positional?.length ? { examples: positional } : {}) }
    } else if (type === 'FOOTER' && channel === 'whatsapp') {
      if (typeof c.text !== 'string') return null
      parts.footer = c.text
    } else if (type === 'BUTTONS') {
      if (!Array.isArray(c.buttons)) return null
      const buttons: NonNullable<TemplateParts['buttons']> = []
      for (const b of c.buttons) {
        if (!isObj(b) || typeof b.text !== 'string') return null
        const t = String(b.type).toUpperCase()
        if (t === 'URL' && typeof b.url === 'string' && !hasHole(b.url)) buttons.push({ type: 'url', text: b.text, url: b.url })
        else if (t === 'PHONE_NUMBER' && typeof b.phone_number === 'string') buttons.push({ type: 'phone', text: b.text, phone: b.phone_number })
        else if (t === 'POSTBACK' && typeof b.payload === 'string') buttons.push({ type: 'postback', text: b.text, payload: b.payload })
        else if (t === 'QUICK_REPLY') buttons.push({ type: 'quick-reply', text: b.text })
        else return null
      }
      parts.buttons = buttons
    } else return null
  }
  if (!parts.body) return null
  const full = parts as TemplateParts
  return partsProblem(full, format, channel) ? null : full
}

/** The template as a person reads it in the preview. */
export function templateLine(parts: TemplateParts): string {
  return [
    parts.header ? `[header] ${parts.header.text}` : null,
    `[body] ${parts.body.text}`,
    parts.footer !== undefined ? `[footer] ${parts.footer}` : null,
    parts.buttons?.length ? `[buttons] ${parts.buttons.map((b) => `${b.text} (${b.type}${b.url ? ` ${b.url}` : b.phone ? ` ${b.phone}` : b.payload ? ` ${b.payload}` : ''})`).join(', ')}` : null,
  ].filter(Boolean).join(' · ')
}

export interface TemplateRecord {
  channel: TemplateChannel
  action: TemplateAction
  pageId?: string | null
  wabaId?: string | null
  templateId?: string | null
  name?: string | null
  language?: string | null
  status?: string | null
  parameterFormat?: ParameterFormat | null
  /** edit: the parts in Nexus's shape (before: the old ones, when Nexus can send them again; null: no undo). */
  parts?: TemplateParts | null
  groupId?: string | null
  groupName?: string | null
  description?: string | null
  templateIds?: string[] | null
  exists?: boolean
}

export const TEMPLATE_EXPLAIN: Readonly<Record<string, string>> = {
  100: 'Meta says a parameter is not valid: the name (lower-case letters, digits and _; unique per language — 2388024 "Content in This Language Already Exists"), the language code, the category or the components.',
  200: 'Meta refused it for permission: Messenger utility templates need page_utility_messaging on the Page\'s own token; WhatsApp templates need whatsapp_business_management (whatsapp_business_messaging alone answers 200) and the WhatsApp account assigned to the system user.',
  200002: 'Meta could not make the template ("Template creation failed").',
  131009: 'Meta says a parameter value is not valid.',
  368: 'Meta judged it abusive or not allowed for this Page.',
  80008: 'Meta allows only so many calls to this WhatsApp account in an hour: ask again later.',
}
const REVIEW = 'Meta reviews every template (PENDING → APPROVED or REJECTED, with its reasons; meta-message-templates shows them) and may change a WhatsApp template\'s category; "Templates will not be approved without examples".'

/** EN-923 / EN-931 — a new template (its own parts, or a copy of one of Meta's Messenger library templates). */
export function templateCreateDraft(input: {
  channel: TemplateChannel; ownerId: string; name: string; language: string; category: 'UTILITY' | 'MARKETING'; format: ParameterFormat; parts?: TemplateParts | null
  library?: { name: string; buttons: Array<{ type: 'url' | 'phone'; url?: string; phone?: string }> } | null; existing: Array<{ name: string; language: string | null }>
}): MetaChangeDraft | { refusal: string } {
  const { channel } = input
  if (!META_TEMPLATE_NAME.test(input.name)) return { refusal: 'A template name is lower-case letters, digits and _ (at most 512).' }
  if (!META_TEMPLATE_LANGUAGE.test(input.language)) return { refusal: 'language is a language code (it, it_IT, en_US, …).' }
  if (channel === 'messenger' && input.category !== 'UTILITY') return { refusal: 'Messenger templates are UTILITY templates only (marketing goes in Meta\'s own marketing-message tools).' }
  if (input.existing.some((t) => t.name === input.name && t.language === input.language)) return { refusal: `A template "${input.name}" in ${input.language} exists already (Meta refuses a second: 2388024). Edit it, or choose another name.` }
  if (!!input.parts === !!input.library) return { refusal: channel === 'whatsapp' ? 'Give the template\'s parts (body, and optionally header, footer and buttons).' : 'Give the template\'s parts (body, and optionally header and buttons) or a Meta library template to copy (libraryTemplateName), one of them.' }
  if (input.library && channel !== 'messenger') return { refusal: 'Nexus copies Meta library templates for Messenger only.' }
  let params: Record<string, string>
  let shown: string
  if (input.parts) {
    const problem = partsProblem(input.parts, input.format, channel)
    if (problem) return { refusal: problem }
    params = { name: input.name, language: input.language, category: input.category, components: json(componentsOf(input.parts, input.format, channel)), ...(input.format === 'NAMED' ? { parameter_format: 'NAMED' } : {}) }
    shown = templateLine(input.parts)
  } else {
    const lib = input.library!
    if (!META_TEMPLATE_NAME.test(lib.name)) return { refusal: 'libraryTemplateName is a Meta library template name (meta-message-templates does not list them: Meta\'s template library does).' }
    for (const b of lib.buttons) if ((b.type === 'url') === !b.url || (b.type === 'phone') === !b.phone) return { refusal: 'A library button input names its url (type url) or its phone (type phone).' }
    params = {
      name: input.name, language: input.language, category: 'UTILITY', library_template_name: lib.name,
      ...(lib.buttons.length ? { library_template_button_inputs: json(lib.buttons.map((b) => (b.type === 'url' ? { type: 'URL', url: { base_url: b.url } } : { type: 'PHONE_NUMBER', phone_number: b.phone }))) } : {}),
    }
    shown = `a copy of Meta's library template "${lib.name}"${lib.buttons.length ? ` with ${lib.buttons.map((b) => b.url ?? b.phone).join(', ')}` : ''}`
  }
  const where = channel === 'messenger' ? 'the chosen Facebook Page' : `the business's WhatsApp account ${input.ownerId}`
  const before: TemplateRecord = { channel, action: 'create', ...(channel === 'messenger' ? { pageId: input.ownerId } : { wabaId: input.ownerId }), templateId: null, name: input.name, language: input.language, parameterFormat: input.format, exists: false }
  return draftOf({
    summary: `Make the ${channel === 'messenger' ? 'Messenger utility' : `WhatsApp ${input.category.toLowerCase()}`} template "${input.name}" (${input.language}) on ${where}; Meta reviews it before it can be sent.`,
    lines: [[`Template "${input.name}" (${input.language})`, 'none', shown], ['Category', null, input.category], ...(input.parts ? [['Placeholders', null, input.format] as [string, unknown, unknown]] : [])],
    warnings: [
      SETUP_NO_CHECK, REVIEW,
      channel === 'whatsapp' ? 'Its undo deletes it; once a WhatsApp template was APPROVED, Meta lets no new template take its name for 30 days.' : 'Its undo deletes it (this template only: its name and id).',
      ...(channel === 'whatsapp' ? ['Nexus sends no WhatsApp message itself: sending a template message costs per message in WhatsApp, outside Nexus.'] : []),
    ],
    requests: [request({
      label: `Make template "${input.name}" (${input.language})`, objectId: input.ownerId, objectKind: channel === 'messenger' ? 'messagingpage' : 'waba', edge: 'message_templates',
      operation: channel === 'messenger' ? 'pagetemplate.create' : 'wabatemplate.create', params, undoable: true, explain: TEMPLATE_EXPLAIN, doneSentence: madeSentence(`Make template "${input.name}"`),
    }, channel === 'messenger')],
    stands: { channel, existing: input.existing.filter((t) => t.name === input.name).map((t) => t.language).sort() },
    before, after: { ...before, exists: true },
  })
}

/** EN-924 — new parts for a Messenger utility template of the chosen Page (Meta reviews it again). */
export function templateEditDraft(pageId: string, template: PageTemplate, parts: TemplateParts): MetaChangeDraft | { refusal: string } {
  const format: ParameterFormat = template.parameterFormat === 'NAMED' ? 'NAMED' : 'POSITIONAL'
  const problem = partsProblem(parts, format, 'messenger')
  if (problem) return { refusal: problem }
  const old = partsFromMeta(template.components, format, 'messenger')
  const components = componentsOf(parts, format, 'messenger')
  const before: TemplateRecord = { channel: 'messenger', action: 'edit', pageId, templateId: template.templateId, name: template.name, language: template.language, parameterFormat: format, parts: old, status: template.status }
  if (old && same(componentsOf(old, format, 'messenger'), components)) return nothing(`Template "${template.name}" already reads so.`, { templateId: template.templateId, components: template.components }, before)
  return draftOf({
    summary: `Change the Messenger utility template "${template.name}" (${template.templateId}) of the chosen Facebook Page; Meta reviews it again.`,
    lines: [[`Template "${template.name}"`, old ? templateLine(old) : '(parts Nexus does not send, e.g. an image header)', templateLine(parts)]],
    warnings: [SETUP_NO_CHECK, REVIEW, old ? 'Its undo writes the old parts back (Meta reviews them again).' : 'This edit has NO undo: the template\'s old parts hold something Nexus does not send (an image header, a button with a placeholder, …).'],
    requests: [request({ label: `Change template "${template.name}"`, objectId: template.templateId, objectKind: 'messengertemplate', operation: 'pagetemplate.edit', params: { components: json(components) }, undoable: !!old, explain: TEMPLATE_EXPLAIN, doneSentence: (r) => `Change template "${template.name}": Meta took it${typeof r.node?.status === 'string' ? `; Meta's review: ${r.node.status}` : ''}${typeof r.node?.rejection_reason === 'string' && r.node.rejection_reason !== 'NONE' ? ` (${r.node.rejection_reason})` : ''}.` })],
    stands: { templateId: template.templateId, components: template.components, status: template.status },
    before, after: { ...before, parts },
  })
}

/** EN-925 / EN-932 — delete ONE template: its name AND its id (the name alone would delete it in every language). */
export function templateDeleteDraft(channel: TemplateChannel, ownerId: string, template: { templateId: string; name: string; language: string | null; status: string | null }): MetaChangeDraft {
  const before: TemplateRecord = { channel, action: 'delete', ...(channel === 'messenger' ? { pageId: ownerId } : { wabaId: ownerId }), templateId: template.templateId, name: template.name, language: template.language, status: template.status, exists: true }
  return draftOf({
    summary: `Delete the ${channel === 'messenger' ? 'Messenger utility' : 'WhatsApp'} template "${template.name}" (${template.language ?? '?'}, ${template.templateId}) — this one only, for good.`,
    lines: [[`Template "${template.name}" (${template.language ?? '?'})`, template.status ?? 'exists', 'deleted']],
    warnings: [
      SETUP_NO_CHECK, 'Nexus names the template\'s id with its name, so only this language goes (the name alone would delete it in every language).',
      channel === 'whatsapp' ? 'A deleted WhatsApp template cannot come back: a new one is reviewed again, and an APPROVED one\'s name stays taken for 30 days (a message still being delivered keeps it PENDING_DELETION up to 30 days).' : 'A deleted template cannot come back: a new one is reviewed again.',
    ],
    requests: [request({
      label: `Delete template "${template.name}" ${template.templateId}`, objectId: ownerId, objectKind: channel === 'messenger' ? 'messagingpage' : 'waba', edge: 'message_templates', method: 'DELETE' as const,
      operation: channel === 'messenger' ? 'pagetemplate.delete' : 'wabatemplate.delete',
      params: channel === 'messenger' ? { name: template.name, template_id: template.templateId } : { hsm_id: template.templateId, name: template.name }, undoable: false, explain: TEMPLATE_EXPLAIN,
    }, channel === 'messenger')],
    stands: { templateId: template.templateId, name: template.name },
    before, after: { ...before, exists: false },
  })
}

/** EN-940 — a template group of the business's WhatsApp account (its templates must be the account's own). */
export function groupCreateDraft(wabaId: string, input: { name: string; description: string | null; templateIds: string[] }, templates: WhatsAppTemplate[]): MetaChangeDraft | { refusal: string } {
  const problem = groupTextProblem(input.name, input.description)
  if (problem) return { refusal: problem }
  const own = new Set(templates.map((t) => t.templateId))
  const foreign = input.templateIds.filter((id) => !own.has(id))
  if (foreign.length) return { refusal: `${foreign.join(', ')} ${foreign.length === 1 ? 'is not a template' : 'are not templates'} of this WhatsApp account (among the first 500 Meta lists).` }
  if (!input.templateIds.length) return { refusal: 'A template group names at least one template (templateIds).' }
  const before: TemplateRecord = { channel: 'whatsapp', action: 'group-create', wabaId, groupId: null, groupName: input.name, description: input.description, templateIds: input.templateIds, exists: false }
  return draftOf({
    summary: `Make the WhatsApp template group "${input.name}" with ${input.templateIds.length} template${input.templateIds.length === 1 ? '' : 's'} on the business's WhatsApp account ${wabaId}.`,
    lines: [[`Template group "${input.name}"`, 'none', `${input.templateIds.join(', ')}${input.description ? ` — "${input.description}"` : ''}`]],
    warnings: [SETUP_NO_CHECK, 'A template is in one group at a time (Meta refuses one that is in another group); group names are unique.', 'Its undo deletes the group (its templates stay).'],
    requests: [request({ label: `Make template group "${input.name}"`, objectId: wabaId, objectKind: 'waba', edge: 'template_groups', operation: 'templategroup.create', params: { name: input.name, whatsapp_business_templates: json(input.templateIds), ...(input.description ? { description: input.description } : {}) }, undoable: true, skipReadBack: true, explain: TEMPLATE_EXPLAIN, doneSentence: madeSentence(`Make template group "${input.name}"`) }, false)],
    stands: { wabaId, templates: input.templateIds.sort() },
    before, after: { ...before, exists: true },
  })
}

function groupTextProblem(name: string | null, description: string | null): string | null {
  if (name !== null && (!name.trim() || !META_NAME_TEXT.test(name) || [...name].length > META_MESSAGE_LIMITS.groupName)) return `A group name is 1–${META_MESSAGE_LIMITS.groupName} printable characters.`
  if (description !== null && (!description.trim() || !META_NAME_TEXT.test(description) || [...description].length > META_MESSAGE_LIMITS.groupDescription)) return `A group description is 1–${META_MESSAGE_LIMITS.groupDescription} printable characters.`
  return null
}

/** EN-940 — a group's name, description, templates added or taken off; its undo puts each back. */
export function groupUpdateDraft(wabaId: string, group: TemplateGroupState, input: { name: string | null; description: string | null; add: string[]; remove: string[] }, templates: WhatsAppTemplate[]): MetaChangeDraft | { refusal: string } {
  const problem = groupTextProblem(input.name, input.description)
  if (problem) return { refusal: problem }
  const own = new Set(templates.map((t) => t.templateId))
  const foreign = input.add.filter((id) => !own.has(id))
  if (foreign.length) return { refusal: `${foreign.join(', ')} ${foreign.length === 1 ? 'is not a template' : 'are not templates'} of this WhatsApp account.` }
  if (input.add.some((id) => input.remove.includes(id))) return { refusal: 'A template is added or taken off, not both.' }
  const inGroup = new Set(group.templateIds)
  const add = input.add.filter((id) => !inGroup.has(id))
  const remove = input.remove.filter((id) => inGroup.has(id))
  const notThere = input.remove.filter((id) => !inGroup.has(id))
  const rename = input.name !== null && input.name !== group.name ? input.name : null
  const describe = input.description !== null && input.description !== group.description ? input.description : null
  const record = (name: string | null, description: string | null, ids: string[]): TemplateRecord => ({ channel: 'whatsapp', action: 'group-update', wabaId, groupId: group.groupId, groupName: name, description, templateIds: [...ids].sort() })
  const before = record(group.name, group.description, group.templateIds)
  const skipped = [...input.add.filter((id) => inGroup.has(id)).map((id) => `Template ${id} is in the group already.`), ...notThere.map((id) => `Template ${id} is not in the group.`)]
  if (!add.length && !remove.length && rename === null && describe === null) return { ...nothing(`Template group "${group.name ?? group.groupId}" already reads so.`, { group }, before), skipped: skipped.length ? skipped : [`Template group "${group.name ?? group.groupId}" already reads so.`] }
  if (remove.length === group.templateIds.length && !add.length) return { refusal: 'That takes every template off the group: delete the group instead (group-delete, confirmDelete).' }
  const after = record(rename ?? group.name, describe ?? group.description, [...group.templateIds.filter((id) => !remove.includes(id)), ...add])
  return draftOf({
    summary: `Change the WhatsApp template group "${group.name ?? group.groupId}" (${group.groupId}).`,
    lines: [
      ...(rename !== null ? [['Name', group.name, rename] as [string, unknown, unknown]] : []),
      ...(describe !== null ? [['Description', group.description, describe] as [string, unknown, unknown]] : []),
      ...(add.length ? [['Templates added', null, add.join(', ')] as [string, unknown, unknown]] : []),
      ...(remove.length ? [['Templates taken off', remove.join(', '), null] as [string, unknown, unknown]] : []),
    ],
    warnings: [SETUP_NO_CHECK, 'A template is in one group at a time; taking one off keeps the numbers it already gave the group.', 'Its undo puts the name, description and templates back.'],
    requests: [request({
      label: `Change template group ${group.groupId}`, objectId: group.groupId, objectKind: 'templategroup', operation: 'templategroup.update', readBackFields: 'id,name,description',
      params: { ...(rename !== null ? { name: rename } : {}), ...(describe !== null ? { description: describe } : {}), ...(add.length ? { add_templates: json(add) } : {}), ...(remove.length ? { remove_templates: json(remove) } : {}) },
      undoable: true, explain: TEMPLATE_EXPLAIN, doneSentence: confirmedSentence(`Change template group ${group.groupId}`),
    }, false)],
    stands: { group: { ...group, templateIds: [...group.templateIds].sort() } },
    before, after, skipped,
  })
}

export function groupDeleteDraft(wabaId: string, group: TemplateGroupState): MetaChangeDraft {
  const before: TemplateRecord = { channel: 'whatsapp', action: 'group-delete', wabaId, groupId: group.groupId, groupName: group.name, description: group.description, templateIds: group.templateIds, exists: true }
  return draftOf({
    summary: `Delete the WhatsApp template group "${group.name ?? group.groupId}" (${group.groupId}) — its ${group.templateIds.length} template${group.templateIds.length === 1 ? '' : 's'} stay.`,
    lines: [[`Template group "${group.name ?? group.groupId}"`, 'exists', 'deleted']],
    warnings: [SETUP_NO_CHECK, 'A deleted group cannot come back: a new one gets a new id, and its numbers start again.'],
    requests: [request({ label: `Delete template group ${group.groupId}`, objectId: group.groupId, objectKind: 'templategroup', method: 'DELETE' as const, operation: 'templategroup.delete', params: {}, undoable: false, explain: TEMPLATE_EXPLAIN }, false)],
    stands: { groupId: group.groupId },
    before, after: { ...before, exists: false },
  })
}

// ── the messaging setup ────────────────────────────────────────────────────────────────────────────────────────────

export const SETUP_SECTIONS = ['profile', 'person-menu', 'persona', 'nlp', 'calling', 'welcome-flow', 'whatsapp-number', 'messenger-ad-defaults'] as const
export type SetupSection = typeof SETUP_SECTIONS[number]
export const PROFILE_KEYS = ['getStarted', 'greeting', 'iceBreakers', 'persistentMenu', 'allowlistedDomains', 'accountLinkingUrl', 'commands'] as const
export type ProfileKey = typeof PROFILE_KEYS[number]
const META_KEY: Readonly<Record<ProfileKey, typeof META_PROFILE_FIELDS[number]>> = {
  getStarted: 'get_started', greeting: 'greeting', iceBreakers: 'ice_breakers', persistentMenu: 'persistent_menu', allowlistedDomains: 'whitelisted_domains', accountLinkingUrl: 'account_linking_url', commands: 'commands',
}

export type MenuInput = Array<{ locale: string; composerInputDisabled?: boolean; items: Array<{ type: 'postback' | 'web_url'; title: string; payload?: string; url?: string; webviewHeight?: 'compact' | 'tall' | 'full' }> }>
export interface ProfileInput {
  getStarted?: { payload: string }
  greeting?: Array<{ locale: string; text: string }>
  iceBreakers?: Array<{ locale: string; questions: Array<{ question: string; payload: string }> }>
  persistentMenu?: MenuInput
  allowlistedDomains?: string[]
  accountLinkingUrl?: string
  commands?: Array<{ locale: string; commands: Array<{ name: string; description: string }> }>
}

/** Nexus's menu → Meta's persistent_menu. */
export function menuToMeta(menu: MenuInput, instagram: boolean): Row[] {
  return menu.map((m) => ({
    locale: m.locale,
    ...(!instagram && m.composerInputDisabled !== undefined ? { composer_input_disabled: m.composerInputDisabled } : {}),
    call_to_actions: m.items.map((i) => (i.type === 'web_url' ? { type: 'web_url', title: i.title, url: i.url, ...(i.webviewHeight ? { webview_height_ratio: i.webviewHeight } : {}) } : { type: 'postback', title: i.title, payload: i.payload })),
  }))
}
/** Meta's persistent_menu → Nexus's menu, or null when it holds anything Nexus does not send. */
export function menuFromMeta(v: unknown, instagram: boolean): MenuInput | null {
  if (!Array.isArray(v)) return null
  const out: MenuInput = []
  for (const m of v) {
    if (!isObj(m) || typeof m.locale !== 'string' || !Array.isArray(m.call_to_actions)) return null
    if (Object.keys(m).some((k) => !['locale', 'composer_input_disabled', 'call_to_actions'].includes(k))) return null
    const items: MenuInput[number]['items'] = []
    for (const i of m.call_to_actions) {
      if (!isObj(i) || typeof i.title !== 'string') return null
      if (i.type === 'web_url' && typeof i.url === 'string' && Object.keys(i).every((k) => ['type', 'title', 'url', 'webview_height_ratio'].includes(k))) items.push({ type: 'web_url', title: i.title, url: i.url, ...(typeof i.webview_height_ratio === 'string' ? { webviewHeight: i.webview_height_ratio as 'compact' | 'tall' | 'full' } : {}) })
      else if (i.type === 'postback' && typeof i.payload === 'string' && Object.keys(i).every((k) => ['type', 'title', 'payload'].includes(k))) items.push({ type: 'postback', title: i.title, payload: i.payload })
      else return null
    }
    out.push({ locale: m.locale, ...(!instagram && typeof m.composer_input_disabled === 'boolean' ? { composerInputDisabled: m.composer_input_disabled } : {}), items })
  }
  return out
}

/** One profile property in Meta's shape. */
function profileValueToMeta(key: ProfileKey, value: unknown, instagram: boolean): unknown {
  switch (key) {
    case 'getStarted': return { payload: (value as { payload: string }).payload }
    case 'greeting': return (value as NonNullable<ProfileInput['greeting']>).map((g) => ({ locale: g.locale, text: g.text }))
    case 'iceBreakers': return (value as NonNullable<ProfileInput['iceBreakers']>).map((i) => ({ call_to_actions: i.questions.map((q) => ({ question: q.question, payload: q.payload })), locale: i.locale }))
    case 'persistentMenu': return menuToMeta(value as MenuInput, instagram)
    case 'allowlistedDomains': return value
    case 'accountLinkingUrl': return value
    case 'commands': return (value as NonNullable<ProfileInput['commands']>).map((c) => ({ locale: c.locale, commands: c.commands.map((x) => ({ name: x.name, description: x.description })) }))
  }
}

/** Meta's profile property → Nexus's shape (the undo re-sends it), or undefined when it holds anything Nexus does not send. */
export function profileValueFromMeta(key: ProfileKey, v: unknown, instagram: boolean): unknown | undefined {
  if (v === undefined || v === null || (Array.isArray(v) && !v.length)) return null
  const strings = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === 'string')
  switch (key) {
    case 'getStarted': return isObj(v) && typeof v.payload === 'string' && Object.keys(v).length === 1 ? { payload: v.payload } : undefined
    case 'greeting': return Array.isArray(v) && v.every((g) => isObj(g) && typeof g.locale === 'string' && typeof g.text === 'string' && Object.keys(g).length === 2) ? v.map((g) => ({ locale: (g as Row).locale, text: (g as Row).text })) : undefined
    case 'iceBreakers': {
      if (!Array.isArray(v)) return undefined
      // The pre-2022 format (a bare list of questions) is the "default" locale's.
      if (v.every((q) => isObj(q) && typeof q.question === 'string' && typeof q.payload === 'string' && Object.keys(q).length === 2)) return [{ locale: 'default', questions: v.map((q) => ({ question: (q as Row).question, payload: (q as Row).payload })) }]
      const out = []
      for (const i of v) {
        if (!isObj(i) || typeof i.locale !== 'string' || !Array.isArray(i.call_to_actions) || Object.keys(i).length !== 2) return undefined
        if (!i.call_to_actions.every((q) => isObj(q) && typeof q.question === 'string' && typeof q.payload === 'string' && Object.keys(q).length === 2)) return undefined
        out.push({ locale: i.locale, questions: (i.call_to_actions as Row[]).map((q) => ({ question: q.question, payload: q.payload })) })
      }
      return out
    }
    case 'persistentMenu': return menuFromMeta(v, instagram) ?? undefined
    case 'allowlistedDomains': return strings(v) ? v : undefined
    case 'accountLinkingUrl': return typeof v === 'string' ? v : undefined
    case 'commands': {
      if (!Array.isArray(v)) return undefined
      const out = []
      for (const c of v) {
        if (!isObj(c) || typeof c.locale !== 'string' || !Array.isArray(c.commands) || Object.keys(c).length !== 2) return undefined
        if (!c.commands.every((x) => isObj(x) && typeof x.name === 'string' && typeof x.description === 'string' && Object.keys(x).length === 2)) return undefined
        out.push({ locale: c.locale, commands: (c.commands as Row[]).map((x) => ({ name: x.name, description: x.description })) })
      }
      return out
    }
  }
}

export interface SetupRecord {
  section: SetupSection
  pageId: string
  platform?: MessagingPlatform
  /** profile: each property it set or cleared — before: the old value in Nexus's shape (null: not set; 'unknown': Nexus cannot send it again). */
  properties?: Partial<Record<ProfileKey, unknown>>
  personId?: string | null
  menu?: MenuInput | null | 'unknown'
  action?: 'create' | 'update' | 'delete'
  personaId?: string | null
  personaName?: string | null
  nlpEnabled?: boolean | null
  model?: string | null
  /** nlp before: Meta cannot read it — the last value Nexus set (null: never set by Nexus; Meta's default is off). */
  knownToNexus?: boolean
  calling?: CallingInput | null
  flowId?: string | null
  flow?: FlowInput | null | 'unknown'
  whatsappNumber?: string | null
  verification?: string | null
  exists?: boolean
}

export const SETUP_EXPLAIN: Readonly<Record<string, string>> = {
  100: 'Meta says a parameter is not valid for this setting.',
  200: 'Meta refused it for permission: the system user needs the MESSAGING task on the chosen Page and its token pages_messaging (welcome flows for Instagram also instagram_basic and instagram_manage_messages; NLP pages_manage_metadata).',
  80006: 'Meta allows only so many Messenger calls to this Page in a while (the profile: 10 calls per 10 minutes; a person\'s menu: 10 per person per 10 minutes): ask again later.',
  104: 'Meta says the request\'s signature is not right (its error 104 for the WhatsApp number check).',
}
const PROFILE_LIMIT = 'Meta allows 10 Messenger Profile calls per 10 minutes per Page, and a Page-level menu can take up to 24 hours to show.'

/** EN-901 / EN-902 — set and / or clear Messenger (or Instagram) profile properties; the old values are read first. */
export function profileDraft(pageId: string, platform: MessagingPlatform, live: Row, set: ProfileInput, clear: ProfileKey[]): MetaChangeDraft | { refusal: string } {
  const instagram = platform === 'instagram'
  const setKeys = PROFILE_KEYS.filter((k) => set[k] !== undefined)
  if (!setKeys.length && !clear.length) return { refusal: 'Give profile properties to set (profile) or to clear (clear).' }
  const both = setKeys.filter((k) => clear.includes(k))
  if (both.length) return { refusal: `${both.join(', ')}: set or clear, not both.` }
  if (instagram) {
    const bad = [...setKeys, ...clear].filter((k) => !(META_INSTAGRAM_PROFILE_FIELDS as readonly string[]).includes(META_KEY[k]))
    if (bad.length) return { refusal: `On Instagram the profile takes iceBreakers and persistentMenu only (not ${bad.join(', ')}).` }
  }
  const lines: Array<[string, unknown, unknown]> = []
  const before: Partial<Record<ProfileKey, unknown>> = {}
  const after: Partial<Record<ProfileKey, unknown>> = {}
  const noUndo: string[] = []
  const setParams: Record<string, string> = {}
  const skipped: string[] = []
  for (const key of setKeys) {
    const metaValue = profileValueToMeta(key, set[key], instagram)
    const old = live[META_KEY[key]]
    if (same(old, metaValue)) { skipped.push(`${key} already reads so.`); continue }
    const oldInput = profileValueFromMeta(key, old, instagram)
    before[key] = oldInput === undefined ? 'unknown' : oldInput
    if (oldInput === undefined) noUndo.push(key)
    after[key] = set[key]
    setParams[META_KEY[key]] = key === 'accountLinkingUrl' ? String(metaValue) : json(metaValue)
    lines.push([key, old === undefined || old === null ? 'not set' : old, metaValue])
  }
  const cleared: string[] = []
  for (const key of clear) {
    const old = live[META_KEY[key]]
    if (old === undefined || old === null || (Array.isArray(old) && !old.length)) { skipped.push(`${key} is not set.`); continue }
    const oldInput = profileValueFromMeta(key, old, instagram)
    before[key] = oldInput === undefined ? 'unknown' : oldInput
    if (oldInput === undefined) noUndo.push(key)
    after[key] = null
    cleared.push(META_KEY[key])
    lines.push([key, old, 'cleared'])
  }
  const record = (properties: Partial<Record<ProfileKey, unknown>>): SetupRecord => ({ section: 'profile', pageId, platform, properties })
  const requests: MetaChangeRequest[] = []
  if (Object.keys(setParams).length) {
    requests.push(request({ label: `Set the ${instagram ? 'Instagram' : 'Messenger'} profile's ${Object.keys(setParams).join(', ')}`, objectId: pageId, objectKind: 'messagingpage', edge: 'messenger_profile', operation: 'messengerprofile.set', params: { ...setParams, ...(instagram ? { platform: 'instagram' } : {}) }, undoable: true, skipReadBack: true, explain: SETUP_EXPLAIN, doneSentence: confirmedSentence('The profile') }))
  }
  if (cleared.length) {
    requests.push(request({ label: `Clear the ${instagram ? 'Instagram' : 'Messenger'} profile's ${cleared.join(', ')}`, objectId: pageId, objectKind: 'messagingpage', edge: 'messenger_profile', method: 'DELETE' as const, operation: 'messengerprofile.delete', params: { fields: json(cleared), ...(instagram ? { platform: 'instagram' } : {}) }, undoable: true, explain: SETUP_EXPLAIN }))
  }
  if (!requests.length) return { ...nothing(`The ${instagram ? 'Instagram' : 'Messenger'} profile already reads so.`, { live }, record({})), skipped }
  return draftOf({
    summary: `Change the ${instagram ? 'Instagram' : 'Messenger'} profile of the chosen Facebook Page (${lines.map((l) => l[0]).join(', ')}) — what people see when they open a chat.`,
    lines,
    warnings: [
      SETUP_NO_CHECK, 'Meta overwrites only the properties named, and deletes only those named.', PROFILE_LIMIT,
      'While the business\'s Meta app is in Development mode Meta shows the profile only to people with a role on the app.',
      ...(setKeys.includes('persistentMenu') && !instagram ? ['A persistent menu shows only with a Get Started button set (getStarted).'] : []),
      ...(setKeys.includes('iceBreakers') ? ['Ice breakers set by API turn off editing the Page Inbox\'s own FAQ questions; people from a click-to-message ad see that ad\'s ice breakers instead.'] : []),
      noUndo.length ? `No undo for ${noUndo.join(', ')}: Meta's current value holds something Nexus does not send.` : 'Its undo writes the old values back (and clears what was not set before).',
    ],
    requests,
    stands: { platform, live: Object.fromEntries([...setKeys, ...clear].map((k) => [k, live[META_KEY[k]] ?? null])) },
    before: record(before), after: record(after), skipped,
  })
}

/** EN-904 / EN-905 — one person's own persistent menu (set, or taken off); the old one is read first. */
export function personMenuDraft(person: { personId: string; pageId: string; conversationId: string }, liveUserMenu: unknown, menu: MenuInput | null): MetaChangeDraft | { refusal: string } {
  const old = liveUserMenu === undefined || liveUserMenu === null || (Array.isArray(liveUserMenu) && !liveUserMenu.length) ? null : menuFromMeta(liveUserMenu, false)
  const oldRecord: MenuInput | null | 'unknown' = liveUserMenu === undefined || liveUserMenu === null || (Array.isArray(liveUserMenu) && !liveUserMenu.length) ? null : old ?? 'unknown'
  const base = (m: MenuInput | null | 'unknown'): SetupRecord => ({ section: 'person-menu', pageId: person.pageId, personId: person.personId, menu: m })
  if (menu === null) {
    if (oldRecord === null) return { refusal: 'That person has no menu of their own (they see the Page\'s menu): nothing to take off.' }
    return draftOf({
      summary: `Take the own persistent menu of the person in conversation ${person.conversationId} off (they see the Page's menu again).`,
      lines: [[`Menu of person ${person.personId}`, liveUserMenu, 'the Page\'s menu']],
      warnings: [SETUP_NO_CHECK, 'Meta allows 10 menu calls per person per 10 minutes.', oldRecord === 'unknown' ? 'No undo: their menu holds something Nexus does not send.' : 'Its undo sets their menu again. The person\'s id is kept in this change\'s record for that undo.'],
      requests: [request({ label: `Take the own menu of the person in conversation ${person.conversationId} off`, objectId: person.pageId, objectKind: 'messagingpage', edge: 'custom_user_settings', method: 'DELETE' as const, operation: 'usermenu.delete', params: { psid: person.personId, params: '["persistent_menu"]' }, undoable: oldRecord !== 'unknown', explain: SETUP_EXPLAIN })],
      stands: { conversationId: person.conversationId, menu: liveUserMenu ?? null },
      before: base(oldRecord), after: base(null),
    })
  }
  const metaMenu = menuToMeta(menu, false)
  if (same(liveUserMenu, metaMenu)) return nothing(`The person's (conversation ${person.conversationId}) menu already reads so.`, { menu: liveUserMenu }, base(oldRecord))
  return draftOf({
    summary: `Give the person in conversation ${person.conversationId} a persistent menu of their own (the Page's menu stays for everyone else).`,
    lines: [[`Menu of person ${person.personId}`, oldRecord === null ? 'the Page\'s menu' : liveUserMenu, metaMenu]],
    warnings: [SETUP_NO_CHECK, 'It shows at once; Meta allows 10 menu calls per person per 10 minutes.', oldRecord === 'unknown' ? 'No undo: their old menu holds something Nexus does not send.' : `Its undo ${oldRecord === null ? 'takes this menu off again' : 'sets their old menu again'}. The person's id is kept in this change's record for that undo.`],
    requests: [request({ label: `Set the own menu of the person in conversation ${person.conversationId}`, objectId: person.pageId, objectKind: 'messagingpage', edge: 'custom_user_settings', operation: 'usermenu.set', params: { psid: person.personId, persistent_menu: json(metaMenu) }, undoable: oldRecord !== 'unknown', skipReadBack: true, explain: SETUP_EXPLAIN, doneSentence: confirmedSentence(`The person's (conversation ${person.conversationId}) menu`) })],
    stands: { conversationId: person.conversationId, menu: liveUserMenu ?? null },
    before: base(oldRecord), after: base(menu),
  })
}

/** EN-907 / EN-908 — a persona of the chosen Page (made, or deleted on an explicit ask). */
export function personaCreateDraft(pageId: string, personas: Array<{ personaId: string; name: string | null }>, name: string, pictureUrl: string): MetaChangeDraft | { refusal: string } {
  const trimmed = name.trim()
  if (!trimmed || !META_NAME_TEXT.test(trimmed) || [...trimmed].length > META_MESSAGE_LIMITS.personaName) return { refusal: `A persona's name is 1–${META_MESSAGE_LIMITS.personaName} printable characters (a first name and an initial is Meta's advice).` }
  const before: SetupRecord = { section: 'persona', action: 'create', pageId, personaId: null, personaName: trimmed, exists: false }
  return draftOf({
    summary: `Make the persona "${trimmed}" on the chosen Facebook Page (a name and picture its Messenger replies can carry).`,
    lines: [[`Persona "${trimmed}"`, 'none', `picture from ${pictureUrl} (Meta fetches it; at most 8 MB)`]],
    warnings: [SETUP_NO_CHECK, 'Meta shows the persona\'s name and picture above each message it sends; it must not pretend to be someone it is not.', ...(personas.some((p) => p.name === trimmed) ? [`The Page has a persona named "${trimmed}" already.`] : []), 'Its undo deletes the persona Nexus made (messages it sent keep its name).'],
    requests: [request({ label: `Make persona "${trimmed}"`, objectId: pageId, objectKind: 'messagingpage', edge: 'personas', operation: 'persona.create', params: { name: trimmed, profile_picture_url: pictureUrl }, undoable: true, skipReadBack: true, explain: SETUP_EXPLAIN, doneSentence: madeSentence(`Make persona "${trimmed}"`) })],
    stands: { personas: personas.map((p) => p.personaId).sort() },
    before, after: { ...before, exists: true },
  })
}

export function personaDeleteDraft(pageId: string, persona: { personaId: string; name: string | null }): MetaChangeDraft {
  const before: SetupRecord = { section: 'persona', action: 'delete', pageId, personaId: persona.personaId, personaName: persona.name, exists: true }
  return draftOf({
    summary: `Delete the persona "${persona.name ?? persona.personaId}" (${persona.personaId}) of the chosen Facebook Page — for good.`,
    lines: [[`Persona "${persona.name ?? persona.personaId}"`, 'exists', 'deleted']],
    warnings: [SETUP_NO_CHECK, 'Meta deletes a persona softly: messages it sent keep its name, but it sends no new ones; a new persona gets a new id.'],
    requests: [request({ label: `Delete persona ${persona.personaId}`, objectId: persona.personaId, objectKind: 'persona', method: 'DELETE' as const, operation: 'persona.delete', params: {}, undoable: false, explain: SETUP_EXPLAIN })],
    stands: { personaId: persona.personaId },
    before, after: { ...before, exists: false },
  })
}

/** EN-917 — Built-In NLP on or off and its model. Meta has no read of it: Nexus keeps the last value it set. */
export function nlpDraft(pageId: string, last: { nlpEnabled: boolean; model: string | null } | null, input: { nlpEnabled: boolean; model: string | null; nBest: number | null }): MetaChangeDraft | { refusal: string } {
  if (input.model && !(META_NLP_MODELS as readonly string[]).includes(input.model)) return { refusal: `model is one of ${META_NLP_MODELS.join(', ')}.` }
  if (!input.nlpEnabled && (input.model || input.nBest)) return { refusal: 'model and nBest go with switching NLP on.' }
  const before: SetupRecord = { section: 'nlp', pageId, nlpEnabled: last?.nlpEnabled ?? null, model: last?.model ?? null, knownToNexus: !!last }
  const params: Record<string, string> = { nlp_enabled: String(input.nlpEnabled), ...(input.model ? { model: input.model } : {}), ...(input.nBest ? { n_best: String(input.nBest) } : {}) }
  return draftOf({
    summary: `Switch Messenger's Built-In NLP ${input.nlpEnabled ? `on${input.model ? ` (${input.model})` : ''}` : 'off'} for the chosen Facebook Page.`,
    lines: [['Built-In NLP', last ? `${last.nlpEnabled ? 'on' : 'off'}${last.model ? ` (${last.model})` : ''} (as Nexus last set it)` : 'unknown (Meta has no read of it; Nexus never set it)', `${input.nlpEnabled ? 'on' : 'off'}${input.model ? ` (${input.model})` : ''}${input.nBest ? `, n_best ${input.nBest}` : ''}`]],
    warnings: [
      SETUP_NO_CHECK, 'Meta has no read of this setting ("Reading: can\'t perform"): Nexus keeps the last value it set, and its undo sets that back — or switches NLP off when Nexus never set it (Meta\'s default is off).',
      'NLP adds what Meta understood (dates, amounts, sentiment) to the messages Meta sends the business\'s app; it changes nothing people see. A custom Wit.ai token is never taken: Nexus takes no token in chat.',
    ],
    requests: [request({ label: `Switch NLP ${input.nlpEnabled ? 'on' : 'off'}`, objectId: pageId, objectKind: 'messagingpage', edge: 'nlp_configs', operation: 'nlp.set', params, undoable: true, skipReadBack: true, explain: SETUP_EXPLAIN, doneSentence: confirmedSentence(`Switch NLP ${input.nlpEnabled ? 'on' : 'off'}`) })],
    stands: { last },
    before, after: { section: 'nlp', pageId, nlpEnabled: input.nlpEnabled, model: input.model, knownToNexus: true },
  })
}

export interface CallingInput {
  audio?: boolean
  video?: boolean
  icon?: boolean
  hours?: { timeZone: string; days: Array<{ day: typeof META_WEEK_DAYS[number]; open: string; close: string }> }
  routing?: 'META' | 'PARTNERS'
}
/** Meta's call settings → Nexus's shape (undefined where Meta answers nothing Nexus can send again). */
export function callingFromMeta(b: Row): CallingInput {
  const out: CallingInput = {}
  if (typeof b.audio_enabled === 'boolean') out.audio = b.audio_enabled
  if (typeof b.video_enabled === 'boolean') out.video = b.video_enabled
  if (typeof b.icon_enabled === 'boolean') out.icon = b.icon_enabled
  const hours = isObj(b.call_hours) ? b.call_hours : null
  if (hours && typeof hours.timezone_id === 'string' && Array.isArray(hours.weekly_operating_hours) && hours.weekly_operating_hours.every((d) => isObj(d) && typeof d.day_of_week === 'string' && typeof d.open_time === 'string' && typeof d.close_time === 'string')) {
    out.hours = { timeZone: hours.timezone_id, days: (hours.weekly_operating_hours as Row[]).map((d) => ({ day: d.day_of_week as typeof META_WEEK_DAYS[number], open: d.open_time as string, close: d.close_time as string })) }
  }
  const routing = isObj(b.call_routing) ? b.call_routing.ring_target : null
  if (routing === 'META' || routing === 'PARTNERS') out.routing = routing
  return out
}
const callingParam = (key: keyof CallingInput, v: unknown): [string, string] => {
  if (key === 'hours') { const h = v as NonNullable<CallingInput['hours']>; return ['call_hours', json({ timezone_id: h.timeZone, weekly_operating_hours: h.days.map((d) => ({ day_of_week: d.day, open_time: d.open, close_time: d.close })) })] }
  if (key === 'routing') return ['call_routing', json({ ring_target: v })]
  return [`${key}_enabled`, String(v)]
}

/** EN-921 — Messenger calling of the chosen Page; the old settings are read first and are its undo. */
export function callingDraft(pageId: string, live: Row, input: CallingInput): MetaChangeDraft | { refusal: string } {
  const keys = (['audio', 'video', 'icon', 'hours', 'routing'] as const).filter((k) => input[k] !== undefined)
  if (!keys.length) return { refusal: 'Give a calling setting to change (audio, video, icon, hours or routing).' }
  if (input.hours) {
    if (!/^[A-Za-z]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(input.hours.timeZone)) return { refusal: 'hours.timeZone is a time zone such as Europe/Rome.' }
    if (new Set(input.hours.days.map((d) => d.day)).size !== input.hours.days.length) return { refusal: 'Each day once (Meta refuses a duplicate day).' }
    if (input.hours.days.some((d) => !/^([01]\d|2[0-3])[0-5]\d$/.test(d.open) || !/^([01]\d|2[0-3])[0-5]\d$/.test(d.close) || d.close <= d.open)) return { refusal: 'Each day opens and closes as hhmm (0900), closing after it opens.' }
  }
  const now = callingFromMeta(live)
  const before: CallingInput = {}
  const after: CallingInput = {}
  const params: Record<string, string> = {}
  const lines: Array<[string, unknown, unknown]> = []
  const noUndo: string[] = []
  const skipped: string[] = []
  for (const k of keys) {
    if (same(now[k], input[k])) { skipped.push(`${k} already reads so.`); continue }
    if (now[k] === undefined) noUndo.push(k)
    else (before as Row)[k] = now[k]
    ;(after as Row)[k] = input[k]
    const [name, value] = callingParam(k, input[k])
    params[name] = value
    lines.push([k, now[k] ?? '(Meta answered none)', input[k]])
  }
  const record = (calling: CallingInput): SetupRecord => ({ section: 'calling', pageId, calling })
  if (!lines.length) return { ...nothing('Messenger calling already reads so.', { live }, record(now)), skipped }
  return draftOf({
    summary: `Change Messenger calling of the chosen Facebook Page (${lines.map((l) => l[0]).join(', ')}).`,
    lines,
    warnings: [
      SETUP_NO_CHECK, ...(input.hours ? ['Call hours replace the old ones whole: days not listed are closed.'] : []),
      ...(input.routing === 'PARTNERS' ? ['Ringing other apps (PARTNERS) needs an app subscribed to the calls webhook; Meta refuses it otherwise.'] : []),
      noUndo.length ? `No undo for ${noUndo.join(', ')}: Meta answered no old value for it.` : 'Its undo writes the old settings back.',
    ],
    requests: [request({ label: 'Change Messenger calling', objectId: pageId, objectKind: 'messagingpage', edge: 'messenger_call_settings', operation: 'calling.set', params, undoable: true, skipReadBack: true, explain: SETUP_EXPLAIN, doneSentence: confirmedSentence('Messenger calling') })],
    stands: { calling: now },
    before: record(before), after: record(after), skipped,
  })
}

export interface FlowInput { name: string; platforms: Array<'messenger' | 'instagram'>; messages: Array<{ text: string; quickReplies?: Array<{ title: string; payload: string }> }> }
const flowToMeta = (messages: FlowInput['messages']) => messages.map((m) => ({ message: { text: m.text, ...(m.quickReplies?.length ? { quick_replies: m.quickReplies.map((q) => ({ content_type: 'text', title: q.title, payload: q.payload })) } : {}) } }))
/** A flow Meta answers → Nexus's shape, or null when it holds anything Nexus does not send. */
export function flowFromMeta(row: Row): FlowInput | null {
  const raw = row.welcome_message_flow ?? row.welcome_message
  let list: unknown = raw
  if (typeof raw === 'string') { try { list = JSON.parse(raw) } catch { return null } }
  if (!Array.isArray(list) || typeof row.name !== 'string' || !Array.isArray(row.eligible_platforms)) return null
  const messages: FlowInput['messages'] = []
  for (const m of list) {
    const msg = isObj(m) && Object.keys(m).length === 1 && isObj(m.message) ? m.message : null
    if (!msg || typeof msg.text !== 'string' || Object.keys(msg).some((k) => k !== 'text' && k !== 'quick_replies')) return null
    const quick = msg.quick_replies
    if (quick !== undefined && (!Array.isArray(quick) || !quick.every((q) => isObj(q) && q.content_type === 'text' && typeof q.title === 'string' && typeof q.payload === 'string' && Object.keys(q).length === 3))) return null
    messages.push({ text: msg.text, ...(Array.isArray(quick) && quick.length ? { quickReplies: (quick as Row[]).map((q) => ({ title: q.title as string, payload: q.payload as string })) } : {}) })
  }
  const platforms = (row.eligible_platforms as unknown[]).map((p) => String(p).toLowerCase())
  if (!platforms.every((p) => p === 'messenger' || p === 'instagram')) return null
  return { name: row.name, platforms: platforms as FlowInput['platforms'], messages }
}

function flowProblem(flow: Partial<FlowInput>): string | null {
  if (flow.name !== undefined && (!flow.name.trim() || !META_NAME_TEXT.test(flow.name) || [...flow.name].length > META_MESSAGE_LIMITS.flowName)) return `A flow's name is 1–${META_MESSAGE_LIMITS.flowName} printable characters.`
  if (flow.platforms !== undefined && (!flow.platforms.length || new Set(flow.platforms).size !== flow.platforms.length)) return 'platforms names messenger and / or instagram, each once.'
  for (const m of flow.messages ?? []) {
    if (!m.text.trim() || !META_COMMENT_TEXT.test(m.text) || [...m.text].length > META_MESSAGE_LIMITS.messengerText) return `A flow message is 1–${META_MESSAGE_LIMITS.messengerText} printable characters.`
    for (const q of m.quickReplies ?? []) if (!q.title.trim() || !META_NAME_TEXT.test(q.title) || [...q.title].length > META_MESSAGE_LIMITS.quickReplyTitle || !q.payload.trim() || !META_NAME_TEXT.test(q.payload) || [...q.payload].length > META_MESSAGE_LIMITS.payload) return `A quick reply's title is 1–${META_MESSAGE_LIMITS.quickReplyTitle} and its payload 1–${META_MESSAGE_LIMITS.payload} printable characters.`
  }
  if (flow.platforms?.includes('instagram') && flow.messages?.some((m) => Buffer.byteLength(m.text, 'utf8') > META_MESSAGE_LIMITS.instagramTextBytes)) return `A flow for Instagram takes at most ${META_MESSAGE_LIMITS.instagramTextBytes} bytes of text per message.`
  return null
}

/** EN-045 — the chosen Page's welcome-message flows (Click-to-Messenger / Click-to-Instagram-Direct ads). */
export function flowDraft(pageId: string, action: 'create' | 'update' | 'delete', flows: Row[], input: { flowId?: string | null; flow?: Partial<FlowInput> }): MetaChangeDraft | { refusal: string } {
  const flow = input.flow ?? {}
  const problem = flowProblem(flow)
  if (problem) return { refusal: problem }
  if (action === 'create') {
    if (!flow.name || !flow.platforms?.length || !flow.messages?.length) return { refusal: 'A new flow names its name, platforms and messages (1–5).' }
    const before: SetupRecord = { section: 'welcome-flow', action: 'create', pageId, flowId: null, flow: null, exists: false }
    return draftOf({
      summary: `Make the welcome-message flow "${flow.name}" on the chosen Facebook Page (for ${flow.platforms.join(' and ')} ads).`,
      lines: [[`Flow "${flow.name}"`, 'none', flow.messages.map((m) => `"${m.text}"${m.quickReplies?.length ? ` [${m.quickReplies.map((q) => q.title).join(', ')}]` : ''}`).join(' → ')]],
      warnings: [SETUP_NO_CHECK, 'An ad names a flow as partner_app_welcome_message_flow_id; once an ad uses it, Meta lets no one change or delete it.', ...(flow.platforms.includes('instagram') ? ['A flow for Instagram needs instagram_basic and instagram_manage_messages.'] : []), 'Its undo deletes the flow Nexus made (while no ad uses it).'],
      requests: [request({ label: `Make welcome flow "${flow.name}"`, objectId: pageId, objectKind: 'messagingpage', edge: 'welcome_message_flows', operation: 'welcomeflow.create', params: { name: flow.name, welcome_message_flow: json(flowToMeta(flow.messages)), eligible_platforms: json(flow.platforms) }, undoable: true, skipReadBack: true, explain: SETUP_EXPLAIN, doneSentence: madeSentence(`Make welcome flow "${flow.name}"`, 'flow_id') })],
      stands: { flows: flows.map((f) => f.id).sort() },
      before, after: { ...before, flow: flow as FlowInput, exists: true },
    })
  }
  const row = flows.find((f) => String(f.id) === input.flowId)
  if (!row || !input.flowId) return { refusal: 'That welcome flow is not one of the chosen Page\'s (Meta lists only the flows the business\'s Meta app made).' }
  if (row.is_used_in_ad === true) return { refusal: `Welcome flow ${input.flowId} is used in an ad: Meta lets no one change or delete it then.` }
  const old = flowFromMeta(row)
  if (action === 'delete') {
    const before: SetupRecord = { section: 'welcome-flow', action: 'delete', pageId, flowId: input.flowId, flow: old ?? 'unknown', exists: true }
    return draftOf({
      summary: `Delete the welcome-message flow "${String(row.name ?? input.flowId)}" (${input.flowId}) of the chosen Facebook Page — for good.`,
      lines: [[`Flow "${String(row.name ?? input.flowId)}"`, 'exists', 'deleted']],
      warnings: [SETUP_NO_CHECK, 'A deleted flow cannot come back: a new one gets a new id.'],
      requests: [request({ label: `Delete welcome flow ${input.flowId}`, objectId: pageId, objectKind: 'messagingpage', edge: 'welcome_message_flows', method: 'DELETE' as const, operation: 'welcomeflow.delete', params: { flow_id: input.flowId }, undoable: false, explain: SETUP_EXPLAIN })],
      stands: { flowId: input.flowId, usedInAd: row.is_used_in_ad ?? null },
      before, after: { ...before, exists: false },
    })
  }
  const params: Record<string, string> = { flow_id: input.flowId }
  const lines: Array<[string, unknown, unknown]> = []
  if (flow.name !== undefined && flow.name !== row.name) { params.name = flow.name; lines.push(['Name', row.name ?? null, flow.name]) }
  if (flow.messages !== undefined && !same(old?.messages, flow.messages)) { params.welcome_message_flow = json(flowToMeta(flow.messages)); lines.push(['Messages', old?.messages ?? '(not readable)', flow.messages]) }
  if (flow.platforms !== undefined && !same(old?.platforms, flow.platforms)) { params.eligible_platforms = json(flow.platforms); lines.push(['Platforms', old?.platforms ?? row.eligible_platforms ?? null, flow.platforms]) }
  const before: SetupRecord = { section: 'welcome-flow', action: 'update', pageId, flowId: input.flowId, flow: old ?? 'unknown', exists: true }
  if (!lines.length) return nothing(`Welcome flow ${input.flowId} already reads so.`, { row }, before)
  return draftOf({
    summary: `Change the welcome-message flow "${String(row.name ?? input.flowId)}" (${input.flowId}) of the chosen Facebook Page.`,
    lines,
    warnings: [SETUP_NO_CHECK, old ? 'Its undo writes the old name, messages and platforms back (while no ad uses it).' : 'This change has NO undo: the flow holds something Nexus does not send.'],
    requests: [request({ label: `Change welcome flow ${input.flowId}`, objectId: pageId, objectKind: 'messagingpage', edge: 'welcome_message_flows', operation: 'welcomeflow.update', params, undoable: !!old, skipReadBack: true, explain: SETUP_EXPLAIN, doneSentence: confirmedSentence(`Welcome flow ${input.flowId}`) })],
    stands: { row },
    before, after: { ...before, flow: { ...(old ?? { name: String(row.name ?? ''), platforms: [], messages: [] }), ...flow } as FlowInput },
  })
}

/**
 * CR-216 — link a WhatsApp number to the chosen Page: step 1 sends the number (WhatsApp sends a code to it), step 2 the number
 * with the code the person read on that phone. The code is in this request only: never in the preview, the plan's hash, the
 * change record, Nexus's call log or an answer.
 */
export function whatsappNumberDraft(page: { pageId: string; number: string | null; hasNumber: boolean | null }, number: string, code: string | null): MetaChangeDraft | { refusal: string } {
  const digits = number.replace(/[\s()-]/g, '')
  if (!META_WHATSAPP_NUMBER.test(digits)) return { refusal: 'whatsappNumber is a phone number in international form (+39…, digits only).' }
  if (code !== null && !META_VERIFICATION_CODE.test(code)) return { refusal: 'verificationCode is the digits WhatsApp sent to that number.' }
  const before: SetupRecord = { section: 'whatsapp-number', pageId: page.pageId, whatsappNumber: page.number, verification: null }
  return draftOf({
    summary: code === null
      ? `Ask WhatsApp to send a code to ${digits}, to link that number to the chosen Facebook Page (step 1 of 2).`
      : `Link the WhatsApp number ${digits} to the chosen Facebook Page with the code read on that phone (step 2 of 2).`,
    lines: [['WhatsApp number of the Page', page.number ?? (page.hasNumber ? 'set (Meta shows no number)' : 'none'), code === null ? `${digits} (a code is sent to it)` : `${digits} (with the code you read on that phone)`]],
    warnings: [
      SETUP_NO_CHECK,
      code === null ? 'WhatsApp sends a code to that number now; then ask again with verificationCode (the person who holds that phone reads it).' : 'The code works once; it is kept only in this request until it runs (never in the preview, the change record, Nexus\'s call log or an answer).',
      'Meta has no API to unlink the number: a person does it in the Page\'s settings. Click-to-WhatsApp ads send people to this number.',
    ],
    requests: [request({
      label: code === null ? `Send a WhatsApp code to ${digits}` : `Verify ${digits} with the code`, objectId: page.pageId, objectKind: 'messagingpage', edge: 'page_whatsapp_number_verification', operation: 'whatsappnumber.verify',
      params: { whatsapp_number: digits, ...(code !== null ? { verification_code: code } : {}) }, planParams: { whatsapp_number: digits, ...(code !== null ? { verification_code: '(the code)' } : {}) },
      undoable: false, skipReadBack: true, explain: SETUP_EXPLAIN,
      doneSentence: (r) => `${code === null ? 'The code request' : 'The verification'} of ${digits}: Meta answered ${typeof r.node?.verification_status === 'string' ? r.node.verification_status : 'success'}${typeof r.node?.error_message === 'string' && r.node.error_message ? ` (${r.node.error_message})` : ''}.`,
    })],
    stands: { pageId: page.pageId, number: page.number },
    before, after: { ...before, whatsappNumber: digits, verification: code === null ? 'code-sent' : 'verified' },
  })
}

/** CR-272 — Meta takes no change of the Page's default ice breakers and quick replies for messaging ads (read-only fields). */
export const AD_DEFAULTS_CANNOT = 'Meta has no API to change the Page\'s default ice breakers and quick replies for messaging ads: messenger_ads_default_icebreakers, messenger_ads_default_quick_replies and messenger_ads_quick_replies_type are read-only fields of the Page (Graph Page reference v26.0: not among its update parameters; nor in Meta\'s Python SDK Page.api_update). Set them per ad (create-meta-creative: the ad\'s welcome message with its ice breakers and quick replies) or as a welcome flow (set-meta-messaging-setup section welcome-flow); meta-messaging-setup view destinations reads the Page\'s defaults.'

export const PROFILE_META_KEY = META_KEY
