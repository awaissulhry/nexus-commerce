/**
 * Meta step 36 (2026-10-21) — the write allow-list entries of create-meta-lead-form and set-meta-lead-form: EXACT keys,
 * every value judged — enums by list, booleans as `true` / `false`, JSON values in ONE spelling (the string judged is
 * the string sent: `JSON.stringify(JSON.parse(v)) === v`) with every key at every depth on a list, text only where a
 * person types it, links https only. Every rule here is `auth: 'page'`: it goes with the business's CHOSEN Facebook
 * Page's own token, which the gateway reads for that one call (meta-page-token.ts), and only for an object the gateway
 * confirmed is that Page or a child of it (meta-page-owner.ts).
 *
 * Checked 2026-10-21 (curl ≥3 s apart):
 *   - developers.facebook.com/docs/graph-api/reference/page/leadgen_forms/ (v26.0): Creating only — Reading, Updating
 *     and Deleting "you can't perform this operation on this endpoint"; params allow_organic_lead_retrieval (ignored,
 *     being deprecated: not sent), block_display_for_non_targeted_viewer, context_card {title, style LIST_STYLE |
 *     PARAGRAPH_STYLE, content array<string>, button_text, cover_photo_id, cover_photo (file)}, custom_disclaimer {title,
 *     body {text (required), url_entities array<JSON object>}, checkboxes [{is_required (default true),
 *     is_checked_by_default (default false), text (required), key}]}, follow_up_action_url, is_for_canvas,
 *     is_lead_capture_ai_agent_enabled (default false, described only by its own name), is_optimized_for_quality,
 *     is_phone_sms_verify_enabled, locale (32 values), name (required), privacy_policy {url, link_text — "limited to a
 *     maximum of 70 characters"}, question_page_custom_headline, questions (required) [{key, label, type (required, enum
 *     below), inline_context, options array<JSON object>, dependent_conditional_questions array<JSON object>,
 *     conditional_questions_group_id}], should_enforce_work_email, thank_you_page {title (required), body, short_message,
 *     button_text, button_description, business_phone_number, enable_messenger, website_url, button_type (required, enum
 *     below), country_code, gated_file {id}}, tracking_parameters {string: string}, upload_gated_file (file); answers
 *     {id} (read-after-write); errors 100, 192 (invalid phone), 368 (abusive), 80005 (leadgen calls per Page), 200, 105
 *     (too many parameters), 190.
 *   - documentation/ads-commerce/marketing-api/guides/lead-ads/create.md: a Page access token "from a person who can
 *     perform the ADVERTISE task"; STORE_LOOKUP with `context_provider_type: LOCATION_MANAGER`; DATE_TIME with
 *     inline_context; national ids one per form and only for an ad that targets that country; Messenger forms only CUSTOM,
 *     EMAIL, FIRST_NAME, FULL_NAME, LAST_NAME, PHONE and block_display_for_non_targeted_viewer=false; archive: `POST`
 *     … `status=ARCHIVED` (its own sample is a GET with a query string: Nexus sends a POST with a form body) answering
 *     {success: true}; "An archived form can be reactivated by sending a request with status set to ACTIVE";
 *     "You can only archive a lead form since deleting is not supported".
 *   - documentation/ads-commerce/marketing-api/guides/lead-ads/testing-troubleshooting.md: `POST /{FORM_ID}/test_leads`
 *     (Page access token, Page role Advertiser or above, no existing test lead) with optional field_data [{name, values}]
 *     and custom_disclaimer_responses [{checkbox_key, is_checked}]; one test lead per form; `DELETE /{LEAD_ID}` —
 *     "Only the owner of the lead can delete the lead".
 *   - Meta's Python Business SDK (main) facebook_business/adobjects: page.py create_lead_gen_form (the same params),
 *     leadgenform.py api_update (`status`: ACTIVE, ARCHIVED, DELETED, DRAFT; POST /{form}) and create_test_lead
 *     (custom_disclaimer_responses, field_data: list<Object>), lead.py api_delete (DELETE /{lead}), leadgenquestion.py,
 *     leadgenquestionoption.py ({key, value, photo}), leadgencustomdisclaimerbody.py + leadgenurlentityatranges.py
 *     (url_entities [{offset, length, url}]), leadgenconditionalquestionsgroupquestions.py (the READ shape of a dependent
 *     question: {field_key, input_type, name} — the only shape Meta gives; LIVE-PROBES LD-004).
 * Left out on purpose (each answers in words in the tool): SLIDER (no shape anywhere — LIVE-PROBES LD-003), the national
 * ids ID_* (Latin America only), conditional_questions_group_id (no page says where one comes from), gated_file and the two
 * file uploads cover_photo / upload_gated_file (a file Nexus does not hold), allow_organic_lead_retrieval (ignored by Meta),
 * and is_lead_capture_ai_agent_enabled=true (always sent false until Meta explains it).
 */
import type { MetaWriteBodyId, MetaWriteRule } from './meta-calls.js'
import { META_NAME_TEXT } from './meta-write-text.js'

type Params = ReadonlyMap<string, string>
type Row = Record<string, unknown>

/** Meta's v26 question types (leadgen_forms reference, `questions[].type`), spelled as Meta does (MARITIAL_STATUS). */
export const META_LEAD_QUESTION_TYPES = [
  'CUSTOM', 'CITY', 'COMPANY_NAME', 'COUNTRY', 'DOB', 'EMAIL', 'GENDER', 'FIRST_NAME', 'FULL_NAME', 'JOB_TITLE', 'LAST_NAME',
  'MARITIAL_STATUS', 'WHATSAPP_NUMBER', 'EDUCATION_LEVEL', 'WEBSITE', 'PHONE', 'PHONE_OTP', 'POST_CODE', 'PROVINCE',
  'RELATIONSHIP_STATUS', 'STATE', 'STREET_ADDRESS', 'ZIP', 'WORK_EMAIL', 'MILITARY_STATUS', 'WORK_PHONE_NUMBER', 'LOCAL_DEALER',
  'SLIDER', 'STORE_LOOKUP', 'STORE_LOOKUP_WITH_TYPEAHEAD', 'DATE_TIME', 'ID_CPF', 'ID_AR_DNI', 'ID_CL_RUT', 'ID_CO_CC',
  'ID_EC_CI', 'ID_PE_DNI', 'ID_MX_RFC', 'JOIN_CODE', 'USER_PROVIDED_PHONE_NUMBER', 'FACEBOOK_LEAD_ID', 'EMAIL_ALIAS',
  'MESSENGER', 'VIN', 'LICENSE_PLATE', 'THREAD_LINK', 'ADDRESS_LINE_TWO',
] as const
/** The national-id types: Latin America only, one per form, the ad must target only that country (create guide). */
export const META_LEAD_ID_TYPES: ReadonlySet<string> = new Set(['ID_CPF', 'ID_AR_DNI', 'ID_CL_RUT', 'ID_CO_CC', 'ID_EC_CI', 'ID_PE_DNI', 'ID_MX_RFC'])
/** The types Nexus sends: Meta's enum without SLIDER (no documented shape) and the national ids. */
export const META_LEAD_TYPES_SENT: readonly string[] = META_LEAD_QUESTION_TYPES.filter((t) => t !== 'SLIDER' && !META_LEAD_ID_TYPES.has(t))
/** A form usable inside a Messenger conversation may ask only these (create guide, "Forms for Messenger Conversations"). */
export const META_LEAD_MESSENGER_TYPES: readonly string[] = ['CUSTOM', 'EMAIL', 'FIRST_NAME', 'FULL_NAME', 'LAST_NAME', 'PHONE']
/** The 32 form locales (reference `locale`, SDK leadgenform.py Locale): pre-defined questions render in it. */
export const META_LEAD_LOCALES = [
  'AR_AR', 'CS_CZ', 'DA_DK', 'DE_DE', 'EL_GR', 'EN_GB', 'EN_US', 'ES_ES', 'ES_LA', 'FI_FI', 'FR_FR', 'HE_IL', 'HI_IN', 'HU_HU',
  'ID_ID', 'IT_IT', 'JA_JP', 'KO_KR', 'NB_NO', 'NL_NL', 'PL_PL', 'PT_BR', 'PT_PT', 'RO_RO', 'RU_RU', 'SV_SE', 'TH_TH', 'TR_TR',
  'VI_VN', 'ZH_CN', 'ZH_HK', 'ZH_TW',
] as const
/** The ending screen's button (reference `thank_you_page.button_type`). */
export const META_LEAD_BUTTON_TYPES = [
  'VIEW_WEBSITE', 'CALL_BUSINESS', 'MESSAGE_BUSINESS', 'DOWNLOAD', 'SCHEDULE_APPOINTMENT', 'VIEW_ON_FACEBOOK', 'PROMO_CODE', 'NONE',
  'WHATSAPP', 'P2B_MESSENGER', 'BOOK_ON_WEBSITE',
] as const
export const META_LEAD_CARD_STYLES = ['LIST_STYLE', 'PARAGRAPH_STYLE'] as const
/** The statuses a Nexus change writes on a form: archive and re-activate (DELETED: Meta does not support deleting a form). */
export const META_LEAD_FORM_STATUSES = ['ARCHIVED', 'ACTIVE'] as const

/** Nexus's own caps (Meta documents only link_text ≤ 70): far above any real form, they keep a body bounded. */
export const META_LEAD_LIMITS = {
  name: 200, questions: 30, options: 50, label: 400, optionValue: 200, dependents: 20, headline: 200, cardContent: 10,
  cardText: 500, title: 200, body: 2000, buttonText: 100, checkboxes: 10, checkboxText: 1000, urlEntities: 20, linkText: 70,
  tracking: 20, trackingValue: 200, url: 2000, testAnswers: 5, testAnswer: 500,
} as const
/** A key Nexus writes (a question's, an option's, a consent box's, a tracking parameter's): a stable machine name. */
export const META_LEAD_KEY = /^[A-Za-z0-9_]{1,100}$/
/** The longest lead-form body (a form of 30 questions with long labels stays far below it). */
export const META_LEAD_FORM_MAX_BODY = 64_000

/**
 * Text a person types: step 18's ONE shared pattern (meta-write-text.ts META_NAME_TEXT — no control or format
 * character, so no bidi override, zero-width mark or tag character; the zero-width joiner only between two emoji).
 */
const PRINTABLE = META_NAME_TEXT
const isObj = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)

/** Why a value is not one Nexus sends, or null. */
type Judge = (value: unknown, where: string) => string | null

const text = (max: number): Judge => (v, where) => (typeof v !== 'string' || !v.trim() ? `${where} is text`
  : v.length > max ? `${where} is at most ${max} characters` : !PRINTABLE.test(v) ? `${where} is printable text (no control or format characters)` : null)
const oneOf = (values: readonly string[]): Judge => (v, where) => (typeof v === 'string' && values.includes(v) ? null : `${where} is one of ${values.join(', ')}`)
const boolean: Judge = (v, where) => (typeof v === 'boolean' ? null : `${where} is true or false`)
const key: Judge = (v, where) => (typeof v === 'string' && META_LEAD_KEY.test(v) ? null : `${where} is letters, digits and _ (at most 100)`)

/** An https link Nexus sends: a real URL, no user or password, a host with a dot, plain ASCII, no space. */
export function metaLeadUrlProblem(v: unknown, where: string): string | null {
  if (typeof v !== 'string' || v.length > META_LEAD_LIMITS.url || !/^[\x21-\x7e]+$/.test(v)) return `${where} is an https link of at most ${META_LEAD_LIMITS.url} plain characters`
  let u: URL
  try { u = new URL(v) } catch { return `${where} is an https link` }
  if (u.protocol !== 'https:' || u.username || u.password || !/\./.test(u.hostname)) return `${where} is an https link (https://…, with a host, no user or password)`
  return null
}
const url: Judge = metaLeadUrlProblem

/** The object has only these keys, and the required ones; each judged. */
function shape(o: unknown, where: string, judges: Readonly<Record<string, Judge>>, required: readonly string[] = []): string | null {
  if (!isObj(o)) return `${where} is an object`
  for (const k of Object.keys(o)) if (!Object.prototype.hasOwnProperty.call(judges, k)) return `${where} has no key "${k.slice(0, 40)}" Nexus sends`
  for (const k of required) if (!(k in o)) return `${where} names ${k}`
  for (const [k, v] of Object.entries(o)) {
    const problem = judges[k](v, `${where}.${k}`)
    if (problem) return problem
  }
  return null
}
/** A list of 1..max items, each judged. */
const list = (max: number, item: Judge): Judge => (v, where) => {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) return `${where} is a list of 1 to ${max}`
  for (const [i, x] of v.entries()) {
    const problem = item(x, `${where}[${i}]`)
    if (problem) return problem
  }
  return null
}
const uniqueBy = (rows: unknown[], field: string): boolean => {
  const seen = rows.map((r) => (isObj(r) ? r[field] : undefined)).filter((x) => x !== undefined)
  return new Set(seen).size === seen.length
}

/** A form value as JSON in exactly Nexus's spelling (the string judged is the string sent), or why not. */
function json(value: string, where: string): { value: unknown } | { problem: string } {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return { problem: `${where} is JSON` } }
  if (JSON.stringify(parsed) !== value) return { problem: `${where} is JSON in one spelling only (no spaces, no escapes Nexus does not write)` }
  return { value: parsed }
}

// ── the parts of a form ──────────────────────────────────────────────────────────────────────────────────────────

const OPTION: Judge = (v, where) => shape(v, where, { value: text(META_LEAD_LIMITS.optionValue), key }, ['value', 'key'])
const DEPENDENT: Judge = (v, where) => shape(v, where, { field_key: key, input_type: oneOf(META_LEAD_TYPES_SENT), name: text(META_LEAD_LIMITS.label) }, ['field_key', 'input_type', 'name'])

const QUESTION: Judge = (v, where) => {
  if (isObj(v) && typeof v.type === 'string') {
    if (v.type === 'SLIDER') return `${where}: Meta documents no shape for a slider question (no min, max or step on the reference, the guide or the SDK), so Nexus sends none until a live probe shows what Meta accepts`
    if (META_LEAD_ID_TYPES.has(v.type)) return `${where}: a national-id question (${v.type}) is for Latin America only (one per form, the ad must target only that country), so Nexus sends none`
  }
  const problem = shape(v, where, {
    type: oneOf(META_LEAD_TYPES_SENT), key, label: text(META_LEAD_LIMITS.label), inline_context: text(META_LEAD_LIMITS.label),
    options: list(META_LEAD_LIMITS.options, OPTION), dependent_conditional_questions: list(META_LEAD_LIMITS.dependents, DEPENDENT),
    context_provider_type: oneOf(['LOCATION_MANAGER']),
  }, ['type', 'key'])
  if (problem) return problem
  const q = v as Row
  if (q.type === 'CUSTOM' && q.label === undefined) return `${where}: a CUSTOM question has a label`
  if (q.options !== undefined && q.type !== 'CUSTOM') return `${where}: only a CUSTOM question has options`
  if (Array.isArray(q.options) && !uniqueBy(q.options, 'key')) return `${where}.options: each option's key once`
  if (q.context_provider_type !== undefined && q.type !== 'STORE_LOOKUP' && q.type !== 'STORE_LOOKUP_WITH_TYPEAHEAD') return `${where}: only a store-locator question has context_provider_type`
  return null
}
const QUESTIONS: Judge = (v, where) => {
  const problem = list(META_LEAD_LIMITS.questions, QUESTION)(v, where)
  if (problem) return problem
  if (!uniqueBy(v as unknown[], 'key')) return `${where}: each question's key once`
  return null
}

const PRIVACY: Judge = (v, where) => shape(v, where, { url, link_text: text(META_LEAD_LIMITS.linkText) }, ['url'])

const CARD: Judge = (v, where) => {
  const problem = shape(v, where, {
    title: text(META_LEAD_LIMITS.title), style: oneOf(META_LEAD_CARD_STYLES), content: list(META_LEAD_LIMITS.cardContent, text(META_LEAD_LIMITS.cardText)),
    button_text: text(META_LEAD_LIMITS.buttonText), cover_photo_id: (x, w) => (typeof x === 'string' && /^\d{1,25}$/.test(x) ? null : `${w} is a photo id (digits)`),
  })
  if (problem) return problem
  return Object.keys(v as Row).length ? null : `${where} names at least one part`
}

const THANK_YOU: Judge = (v, where) => {
  if (isObj(v) && 'gated_file' in v) return `${where}: Nexus sends no gated file (a file download needs a file Nexus does not upload)`
  return shape(v, where, {
    title: text(META_LEAD_LIMITS.title), body: text(META_LEAD_LIMITS.body), short_message: text(META_LEAD_LIMITS.title),
    button_text: text(META_LEAD_LIMITS.buttonText), button_description: text(META_LEAD_LIMITS.title), button_type: oneOf(META_LEAD_BUTTON_TYPES),
    website_url: url, enable_messenger: boolean,
    business_phone_number: (x, w) => (typeof x === 'string' && /^\+?\d{6,20}$/.test(x) ? null : `${w} is a phone number (digits, an optional + first)`),
    // Review B7 — two capital letters is Nexus's choice (an ISO country code, like the phone's country); Meta's reference
    // says only "string" (LIVE-PROBES LD-012a).
    country_code: (x, w) => (typeof x === 'string' && /^[A-Z]{2}$/.test(x) ? null : `${w} is a two-letter country code`),
  }, ['title', 'button_type'])
}

const URL_ENTITY: Judge = (v, where) => shape(v, where, {
  offset: (x, w) => (Number.isInteger(x) && (x as number) >= 0 && (x as number) <= META_LEAD_LIMITS.body ? null : `${w} is a whole number`),
  length: (x, w) => (Number.isInteger(x) && (x as number) >= 1 && (x as number) <= META_LEAD_LIMITS.body ? null : `${w} is a whole number`),
  url,
}, ['offset', 'length', 'url'])
const CHECKBOX: Judge = (v, where) => shape(v, where, { text: text(META_LEAD_LIMITS.checkboxText), key, is_required: boolean, is_checked_by_default: boolean }, ['text', 'key'])
const DISCLAIMER: Judge = (v, where) => {
  const problem = shape(v, where, {
    title: text(META_LEAD_LIMITS.title),
    body: (b, w) => {
      const p = shape(b, w, { text: text(META_LEAD_LIMITS.body), url_entities: list(META_LEAD_LIMITS.urlEntities, URL_ENTITY) }, ['text'])
      if (p) return p
      const body = b as Row
      // Each link marks a part of the text Meta shows (offset + length inside it).
      return Array.isArray(body.url_entities) && body.url_entities.some((e) => (e as Row).offset as number + ((e as Row).length as number) > (body.text as string).length)
        ? `${w}.url_entities: each link marks a part of the text (offset + length within it)` : null
    },
    checkboxes: list(META_LEAD_LIMITS.checkboxes, CHECKBOX),
  }, ['body'])
  if (problem) return problem
  const boxes = (v as Row).checkboxes
  return Array.isArray(boxes) && !uniqueBy(boxes, 'key') ? `${where}.checkboxes: each box's key once` : null
}

const TRACKING: Judge = (v, where) => {
  if (!isObj(v)) return `${where} is an object of names and values`
  const entries = Object.entries(v)
  if (!entries.length || entries.length > META_LEAD_LIMITS.tracking) return `${where} names 1 to ${META_LEAD_LIMITS.tracking} parameters`
  for (const [k, x] of entries) {
    const problem = key(k, `${where} name`) ?? text(META_LEAD_LIMITS.trackingValue)(x, `${where}.${k}`)
    if (problem) return problem
  }
  return null
}

/**
 * Review A5 — a test answer's name is the FORM's question key, and a form made in Meta's screens may use any key (Meta's
 * own sample: `favorite_color?`): printable text up to 200, never Nexus's stricter key shape. The tool sends only the keys
 * it read live from the form (change-lead-forms.ts testLeadDraft). The same for a consent box's key.
 */
const FORM_KEY = text(200)
const TEST_ANSWER: Judge = (v, where) => shape(v, where, { name: FORM_KEY, values: list(META_LEAD_LIMITS.testAnswers, text(META_LEAD_LIMITS.testAnswer)) }, ['name', 'values'])
const TEST_CONSENT: Judge = (v, where) => shape(v, where, { checkbox_key: FORM_KEY, is_checked: boolean }, ['checkbox_key', 'is_checked'])

/** Review A6 — what the ledger keeps of a failed test lead: the questions' and boxes' names, never an answer. */
function testLeadLedger(params: Params): Record<string, string> {
  const names = (raw: string | undefined, field: string): string => {
    try {
      const rows = JSON.parse(raw ?? '[]') as unknown
      return JSON.stringify(Array.isArray(rows) ? rows.map((r) => (isObj(r) && typeof r[field] === 'string' ? r[field] : '?')) : [])
    } catch {
      return '[]'
    }
  }
  return { field_data: names(params.get('field_data'), 'name'), ...(params.has('custom_disclaimer_responses') ? { custom_disclaimer_responses: names(params.get('custom_disclaimer_responses'), 'checkbox_key') } : {}) }
}

/** The JSON keys of a form create, each with its judge. */
const FORM_JSON: Readonly<Record<string, Judge>> = {
  questions: QUESTIONS, privacy_policy: PRIVACY, context_card: CARD, thank_you_page: THANK_YOU, custom_disclaimer: DISCLAIMER, tracking_parameters: TRACKING,
}
const FORM_BOOLEANS = ['block_display_for_non_targeted_viewer', 'is_optimized_for_quality', 'is_phone_sms_verify_enabled', 'should_enforce_work_email', 'is_for_canvas'] as const

/** The values of a form create (POST /{page_id}/leadgen_forms), or why one is refused. */
export function metaLeadFormCreateProblem(params: Params): string | null {
  const name = params.get('name') ?? ''
  if (!name.trim() || name.length > META_LEAD_LIMITS.name) return `name is the form's name, 1 to ${META_LEAD_LIMITS.name} characters`
  if (params.get('is_lead_capture_ai_agent_enabled') !== 'false') return 'is_lead_capture_ai_agent_enabled is always false: Meta documents nothing of what its lead-capture AI agent does, so Nexus never switches it on'
  for (const k of FORM_BOOLEANS) if (params.has(k) && !['true', 'false'].includes(params.get(k)!)) return `${k} is true or false`
  if (params.has('locale') && !(META_LEAD_LOCALES as readonly string[]).includes(params.get('locale')!)) return `locale is one of ${META_LEAD_LOCALES.join(', ')}`
  if (params.has('question_page_custom_headline')) {
    const problem = text(META_LEAD_LIMITS.headline)(params.get('question_page_custom_headline'), 'question_page_custom_headline')
    if (problem) return problem
  }
  if (params.has('follow_up_action_url')) {
    const problem = url(params.get('follow_up_action_url'), 'follow_up_action_url')
    if (problem) return problem
  }
  for (const [k, judge] of Object.entries(FORM_JSON)) {
    if (!params.has(k)) continue
    const parsed = json(params.get(k)!, k)
    if ('problem' in parsed) return parsed.problem
    const problem = judge(parsed.value, k)
    if (problem) return problem
  }
  return null
}

/** The photo id inside a form create (its intro's cover photo): the gateway checks it is a photo of the chosen Page. */
function formIds(params: Params): MetaWriteBodyId[] {
  const raw = params.get('context_card')
  if (!raw) return []
  try {
    const card = JSON.parse(raw) as Row
    return typeof card.cover_photo_id === 'string' ? [{ id: card.cover_photo_id, kind: 'pagephoto' }] : []
  } catch {
    return []
  }
}

/** The values of a test lead (POST /{form_id}/test_leads), or why one is refused. */
export function metaTestLeadProblem(params: Params): string | null {
  const answers = json(params.get('field_data') ?? '', 'field_data')
  if ('problem' in answers) return answers.problem
  const problem = list(META_LEAD_LIMITS.questions, TEST_ANSWER)(answers.value, 'field_data')
  if (problem) return problem
  if (!uniqueBy(answers.value as unknown[], 'name')) return 'field_data: each question\'s answer once'
  if (params.has('custom_disclaimer_responses')) {
    const consent = json(params.get('custom_disclaimer_responses')!, 'custom_disclaimer_responses')
    if ('problem' in consent) return consent.problem
    const p = list(META_LEAD_LIMITS.checkboxes, TEST_CONSENT)(consent.value, 'custom_disclaimer_responses')
    if (p) return p
    if (!uniqueBy(consent.value as unknown[], 'checkbox_key')) return 'custom_disclaimer_responses: each box once'
  }
  return null
}

/** The keys whose value is (or holds) text a person types, each with step 18's text pattern; every other value stays ASCII. */
const FORM_TEXT_KEYS: Readonly<Record<string, RegExp>> = Object.fromEntries(
  ['name', 'question_page_custom_headline', 'questions', 'privacy_policy', 'context_card', 'thank_you_page', 'custom_disclaimer', 'tracking_parameters'].map((k) => [k, META_NAME_TEXT]),
)

/** Step 36 — the lead-form rules (gateway meta-calls.ts writeRules). Every one goes with the chosen Page's token. */
export const META_LEAD_FORM_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    // create-meta-lead-form: POST /{page_id}/leadgen_forms, every option in ONE call (LD-001…LD-022).
    name: 'leadform.create',
    method: 'POST',
    path: /^\d{1,25}\/leadgen_forms$/,
    kinds: ['page'],
    auth: 'page',
    required: ['name', 'questions', 'is_lead_capture_ai_agent_enabled', 'block_display_for_non_targeted_viewer'],
    optional: ['locale', 'privacy_policy', 'context_card', 'thank_you_page', 'custom_disclaimer', 'follow_up_action_url', 'question_page_custom_headline',
      'is_optimized_for_quality', 'is_phone_sms_verify_enabled', 'should_enforce_work_email', 'is_for_canvas', 'tracking_parameters'],
    text: FORM_TEXT_KEYS,
    maxBody: META_LEAD_FORM_MAX_BODY,
    values: metaLeadFormCreateProblem,
    ids: formIds,
    budget: false,
  },
  {
    // set-meta-lead-form archive / re-activate: POST /{form_id} status=ARCHIVED | ACTIVE (LD-026, LD-027).
    name: 'leadform.status',
    method: 'POST',
    path: /^\d{1,25}$/,
    kinds: ['leadform'],
    auth: 'page',
    required: ['status'],
    optional: [],
    values: (params) => {
      const status = params.get('status') ?? ''
      if (status === 'DELETED') return 'Meta does not support deleting a lead form (create guide): archive it instead'
      return (META_LEAD_FORM_STATUSES as readonly string[]).includes(status) ? null : `a form's status is ${META_LEAD_FORM_STATUSES.join(' or ')}`
    },
    budget: false,
  },
  {
    // set-meta-lead-form test lead: POST /{form_id}/test_leads with Nexus's made-up answers (LD-037).
    name: 'testlead.create',
    method: 'POST',
    path: /^\d{1,25}\/test_leads$/,
    kinds: ['leadform'],
    auth: 'page',
    required: ['field_data'],
    optional: ['custom_disclaimer_responses'],
    text: { field_data: META_NAME_TEXT, custom_disclaimer_responses: META_NAME_TEXT },
    maxBody: 20_000,
    values: metaTestLeadProblem,
    ledger: testLeadLedger,
    budget: false,
  },
  {
    // set-meta-lead-form remove a test lead Nexus made (and the undo of making one): DELETE /{lead_id}, no body (LD-039).
    name: 'testlead.delete',
    method: 'DELETE',
    path: /^\d{1,25}$/,
    kinds: ['testlead'],
    auth: 'page',
    required: [],
    optional: [],
    values: () => null,
    budget: false,
  },
]
