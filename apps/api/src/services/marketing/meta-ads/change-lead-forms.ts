/**
 * Meta step 36 (2026-10-21) — lead forms and test leads as drafts (pure: built from a request and the live state, no
 * call). What Meta allows, checked on its v26 reference and guides and the Python SDK (gateway/meta-lead-form-rules.ts
 * names each page; master rows LD-001…LD-022, LD-026, LD-027, LD-037, LD-039):
 *   - a form is made ON THE CHOSEN Facebook Page (`POST /{page_id}/leadgen_forms`, every option in ONE call) and can then
 *     never be edited, listed (the v26 edge says so) or deleted by API — only archived and re-activated
 *     (`POST /{form_id}` status=ARCHIVED | ACTIVE). So its undo is an archive, and the create keeps the new form's id in
 *     its change record (where meta-lead-forms and the gateway find it);
 *   - Meta has no check (validate_only) for any of these: every preview says so;
 *   - one test lead per form (`POST /{form_id}/test_leads`, made-up answers), deleted (`DELETE /{lead_id}`) only when
 *     Nexus made it — a real lead is never read or deleted here (D4 B: real leads stay in Meta's Leads Center until App
 *     Review, Business Verification and a Live app);
 *   - silent features are sent explicitly: the lead-capture AI agent ALWAYS off (Meta documents nothing of it, LD-020);
 *     who sees the form (block_display_for_non_targeted_viewer) always named.
 * Every change here goes as the Page (the gateway reads the Page's own token for each call: gateway/meta-page-token.ts).
 */
import type { MetaChangeDraft, MetaChangeRequest } from './change-draft.js'
import { changeLines } from './change-draft.js'
import {
  META_LEAD_FORM_MAX_BODY, META_LEAD_ID_TYPES, META_LEAD_LIMITS, META_LEAD_MESSENGER_TYPES, META_LEAD_TYPES_SENT, metaLeadFormCreateProblem, metaTestLeadProblem,
} from '../../gateway/meta-lead-form-rules.js'
import { LEADS_ACCESS } from './live-engagement.js'
import type { LeadFormPage, LeadFormState } from './live-lead-forms.js'

// ── what Meta's codes mean here ───────────────────────────────────────────────────────────────────────────────────

/** Meta's codes a lead-form or test-lead request may meet (reference "Error Codes"), in plain words. */
export const LEAD_FORM_EXPLAIN: Readonly<Record<string, string>> = {
  80005: 'Meta allows only so many lead-form calls per Page in a while: wait a few minutes and ask again.',
  105: 'Meta took too many parameters in one call: ask again with fewer questions, options or consent boxes.',
  192: 'Meta found a phone number not valid (the ending screen\'s business phone number, or a test answer): give it with its country code, digits only.',
  368: 'Meta judged this request abusive or not allowed for this Page (its own policy check, not Nexus\'s): a person looks at the Page in Meta\'s Business Support Home before asking again.',
  200: 'Lead forms and test leads need the Page\'s Advertise task ("Create ads") for the system user in Meta Business settings, and pages_manage_ads on its token.',
  10: 'Lead forms and test leads need the Page\'s Advertise task ("Create ads") for the system user in Meta Business settings, and pages_manage_ads on its token.',
  // Review B3 — on a change made with the Page's own token, 190 is that token: the business's system-user token still works.
  190: 'Meta did not accept the Page\'s own token, which Nexus reads for each change: the system user may have lost its role or task on the chosen Page (Meta Business settings › Users › System users › Assign assets); the business\'s system-user token itself is not the problem.',
}

/** What Meta has no check for (the preview's sentence; the kit's metaCheck says the same). */
export const LEAD_NO_CHECK = 'Meta has no check (validate_only) for lead forms or test leads: the preview is built from the live state, and Meta judges the request when it runs.'
/** LD-020. */
export const LEAD_AI_AGENT_OFF = 'Meta\'s lead-capture AI agent stays OFF (is_lead_capture_ai_agent_enabled=false is always sent): Meta documents nothing of what it does, so Nexus never switches it on.'
/** LD-003. */
export const LEAD_NO_SLIDER = 'Meta documents no shape for a slider question (no minimum, maximum or step on its reference, its guide or its SDK): Nexus leaves sliders out until a live probe on a test form shows what Meta accepts (LIVE-PROBES LD-003). Use a CUSTOM question with options instead.'
/** LD-007. */
export const LEAD_NO_NATIONAL_ID = 'National-id questions (ID_CPF, ID_AR_DNI, ID_CL_RUT, ID_CO_CC, ID_EC_CI, ID_PE_DNI, ID_MX_RFC) are for Latin America only: one per form, and the ad must target only that country (Meta\'s create guide). Nexus sells in the EU, so it does not add them.'
/** LD-010, LD-013 — the two file uploads Nexus does not make. */
export const LEAD_NO_FILES = 'Nexus does not upload a file you give: a new cover photo (cover_photo) or a file download on the ending screen (upload_gated_file) is added in Meta\'s Forms library. For the intro, a photo already on the chosen Page works (intro.coverPhotoId).'

// ── create a form ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface LeadQuestionInput {
  type: string
  /** The name each answer carries in a lead (`field_data[].name`): keep it the same in every language. Default for a pre-defined type: the type in lower case. */
  key?: string
  label?: string
  /** Text under the question (inline_context; an appointment question's confirmation line). */
  helpText?: string
  options?: Array<{ value: string; key: string }>
  /** LD-004 — Meta's READ shape of dependent questions ({field_key, input_type, name}); Meta's answer says whether it takes it. */
  dependsOn?: Array<{ fieldKey: string; inputType: string; name: string }>
}

export interface LeadFormCreateInput {
  name: string
  locale?: string
  questions: LeadQuestionInput[]
  privacyPolicy: { url: string; linkText?: string }
  intro?: { title?: string; style?: string; content?: string[]; buttonText?: string; coverPhotoId?: string }
  thankYouPage?: {
    title: string; body?: string; shortMessage?: string; buttonText?: string; buttonDescription?: string; buttonType: string
    websiteUrl?: string; businessPhoneNumber?: string; countryCode?: string; enableMessenger?: boolean
  }
  consent?: { title?: string; text: string; links?: Array<{ offset: number; length: number; url: string }>; checkboxes?: Array<{ key: string; text: string; required?: boolean; checkedByDefault?: boolean }> }
  followUpUrl?: string
  questionPageHeadline?: string
  higherIntent?: boolean
  smsVerification?: boolean
  workEmailOnly?: boolean
  forInstantExperience?: boolean
  /** Shown only to people the ad targets (true, Meta's "filter organic leads") or to anyone (false, "Open Sharing"). Default true; a Messenger form needs false. */
  onlyTargetedPeople?: boolean
  forMessenger?: boolean
  trackingParameters?: Record<string, string>
}

/** What a form create stands on, and what it records (undo archives the form it made). */
export interface LeadFormCreateRecord { pageId: string; formId: string | null; name: string; archived: boolean | null }

const typeKey = (type: string) => type.toLowerCase()
const cut = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The Graph question object of one question (Nexus's spelling: what the gateway judges is what it sends). */
function questionOf(q: LeadQuestionInput): Record<string, unknown> {
  return {
    type: q.type,
    key: q.key ?? typeKey(q.type),
    ...(q.label !== undefined ? { label: q.label } : {}),
    ...(q.helpText !== undefined ? { inline_context: q.helpText } : {}),
    ...(q.options?.length ? { options: q.options.map((o) => ({ value: o.value, key: o.key })) } : {}),
    ...(q.dependsOn?.length ? { dependent_conditional_questions: q.dependsOn.map((d) => ({ field_key: d.fieldKey, input_type: d.inputType, name: d.name })) } : {}),
    // The create guide: a store locator names its context provider.
    ...(q.type === 'STORE_LOOKUP' ? { context_provider_type: 'LOCATION_MANAGER' } : {}),
  }
}

/** The form fields of a create, in Nexus's one spelling (JSON.stringify of plain objects). */
export function leadFormParams(input: LeadFormCreateInput): Record<string, string> {
  const onlyTargeted = input.forMessenger ? false : input.onlyTargetedPeople ?? true
  const t = input.thankYouPage
  const c = input.consent
  const card = input.intro
  return {
    name: input.name,
    questions: JSON.stringify(input.questions.map(questionOf)),
    is_lead_capture_ai_agent_enabled: 'false',
    block_display_for_non_targeted_viewer: String(onlyTargeted),
    ...(input.locale ? { locale: input.locale } : {}),
    privacy_policy: JSON.stringify({ url: input.privacyPolicy.url, ...(input.privacyPolicy.linkText ? { link_text: input.privacyPolicy.linkText } : {}) }),
    ...(card ? {
      context_card: JSON.stringify({
        ...(card.title ? { title: card.title } : {}), ...(card.style ? { style: card.style } : {}), ...(card.content?.length ? { content: card.content } : {}),
        ...(card.buttonText ? { button_text: card.buttonText } : {}), ...(card.coverPhotoId ? { cover_photo_id: card.coverPhotoId } : {}),
      }),
    } : {}),
    ...(t ? {
      thank_you_page: JSON.stringify({
        title: t.title, ...(t.body ? { body: t.body } : {}), ...(t.shortMessage ? { short_message: t.shortMessage } : {}),
        ...(t.buttonText ? { button_text: t.buttonText } : {}), ...(t.buttonDescription ? { button_description: t.buttonDescription } : {}),
        button_type: t.buttonType, ...(t.websiteUrl ? { website_url: t.websiteUrl } : {}),
        ...(t.businessPhoneNumber ? { business_phone_number: t.businessPhoneNumber } : {}), ...(t.countryCode ? { country_code: t.countryCode } : {}),
        ...(t.enableMessenger !== undefined ? { enable_messenger: t.enableMessenger } : {}),
      }),
    } : {}),
    ...(c ? {
      custom_disclaimer: JSON.stringify({
        ...(c.title ? { title: c.title } : {}),
        body: { text: c.text, ...(c.links?.length ? { url_entities: c.links.map((l) => ({ offset: l.offset, length: l.length, url: l.url })) } : {}) },
        ...(c.checkboxes?.length ? {
          checkboxes: c.checkboxes.map((b) => ({ text: b.text, key: b.key, is_required: b.required ?? true, is_checked_by_default: b.checkedByDefault ?? false })),
        } : {}),
      }),
    } : {}),
    ...(input.followUpUrl ? { follow_up_action_url: input.followUpUrl } : {}),
    ...(input.questionPageHeadline ? { question_page_custom_headline: input.questionPageHeadline } : {}),
    ...(input.higherIntent !== undefined ? { is_optimized_for_quality: String(input.higherIntent) } : {}),
    ...(input.smsVerification !== undefined ? { is_phone_sms_verify_enabled: String(input.smsVerification) } : {}),
    ...(input.workEmailOnly !== undefined ? { should_enforce_work_email: String(input.workEmailOnly) } : {}),
    ...(input.forInstantExperience !== undefined ? { is_for_canvas: String(input.forInstantExperience) } : {}),
    ...(input.trackingParameters && Object.keys(input.trackingParameters).length ? { tracking_parameters: JSON.stringify(input.trackingParameters) } : {}),
  }
}

/** Why the request is refused before any call, in words (Meta's own rules first), or null. */
export function leadFormRefusal(input: LeadFormCreateInput): string | null {
  if (input.questions.some((q) => q.type === 'SLIDER')) return LEAD_NO_SLIDER
  if (input.questions.some((q) => META_LEAD_ID_TYPES.has(q.type))) return LEAD_NO_NATIONAL_ID
  const unknown = input.questions.find((q) => !META_LEAD_TYPES_SENT.includes(q.type))
  if (unknown) return `"${unknown.type}" is not one of Meta's question types.`
  const missingKey = input.questions.find((q) => q.type === 'CUSTOM' && !q.key)
  if (missingKey) return 'A CUSTOM question names its key (the name its answer carries in every lead, the same in every language).'
  const keys = input.questions.map((q) => q.key ?? typeKey(q.type))
  const twice = keys.find((k, i) => keys.indexOf(k) !== i)
  if (twice) return `Two questions have the key "${twice}": each answer needs its own name (give the second one a key).`
  if (input.questions.some((q) => q.type === 'CUSTOM' && !q.label)) return 'A CUSTOM question has a label (the question the person reads).'
  if (input.questions.some((q) => q.options?.length && q.type !== 'CUSTOM')) return 'Only a CUSTOM question has options (multiple choice).'
  if (input.forMessenger) {
    const other = input.questions.find((q) => !META_LEAD_MESSENGER_TYPES.includes(q.type))
    if (other) return `A form for Messenger conversations asks only ${META_LEAD_MESSENGER_TYPES.join(', ')} (Meta's create guide: any other makes the form ineligible); ${other.type} is not one.`
    if (input.onlyTargetedPeople === true) return 'A form for Messenger conversations is shown to anyone it is shared with (block_display_for_non_targeted_viewer=false, Meta\'s "Open Sharing"): onlyTargetedPeople must be false or left out.'
  }
  if (input.workEmailOnly && !input.questions.some((q) => q.type === 'WORK_EMAIL')) return 'workEmailOnly checks a work e-mail question: add a WORK_EMAIL question.'
  if (input.smsVerification && !input.questions.some((q) => q.type === 'PHONE' || q.type === 'PHONE_OTP')) return 'smsVerification checks a phone number: add a PHONE (or PHONE_OTP) question.'
  if (input.thankYouPage && (input.thankYouPage.buttonType === 'CALL_BUSINESS' || input.thankYouPage.buttonType === 'WHATSAPP') && !input.thankYouPage.businessPhoneNumber) {
    return `The ending screen's ${input.thankYouPage.buttonType} button calls or writes to the business: give businessPhoneNumber (with countryCode).`
  }
  if (input.consent?.links?.some((l) => l.offset + l.length > input.consent!.text.length)) return 'Each consent link marks a part of the consent text (offset + length within it).'
  return null
}

const yesNo = (v: boolean | undefined, yes: string, no: string, unset: string) => (v === undefined ? unset : v ? yes : no)

/** create-meta-lead-form as a draft: one request, on the chosen Page, with every option in it. */
export function leadFormCreateDraft(input: LeadFormCreateInput, page: LeadFormPage): MetaChangeDraft | { refusal: string } {
  const refusal = leadFormRefusal(input)
  if (refusal) return { refusal }
  const params = leadFormParams(input)
  // The gateway's own judge, run here too: a form the gateway would refuse is never queued.
  const judged = metaLeadFormCreateProblem(new Map(Object.entries(params)))
  if (judged) return { refusal: `Nexus would not send this form: ${judged}.` }
  const body = new URLSearchParams(params).toString()
  if (body.length > META_LEAD_FORM_MAX_BODY) return { refusal: `This form is too long for one request (Nexus sends at most ${META_LEAD_FORM_MAX_BODY} characters): fewer or shorter questions.` }
  const onlyTargeted = params.block_display_for_non_targeted_viewer === 'true'
  const questions = input.questions.map((q) => `${q.type}${q.label ? ` "${cut(q.label, 60)}"` : ''} (${q.key ?? typeKey(q.type)})`).join(', ')
  const { changes, more } = changeLines([
    [`Lead form "${input.name}"`, 'none', `new, on the chosen Facebook Page ${page.pageId}`],
    ['Questions', null, `${input.questions.length}: ${cut(questions)}`],
    ['Language of the pre-filled questions', null, input.locale ?? 'not set (Meta\'s default)'],
    ['Shown to', null, onlyTargeted ? 'only people the ad targets (organic leads filtered out)' : 'anyone the form is shared with ("Open Sharing")'],
    ['Privacy policy', null, `${input.privacyPolicy.url}${input.privacyPolicy.linkText ? ` ("${input.privacyPolicy.linkText}")` : ''}`],
    ...(input.intro ? [['Intro screen', null, `${input.intro.title ?? 'no title'}${input.intro.style ? `, ${input.intro.style}` : ''}${input.intro.coverPhotoId ? `, cover photo ${input.intro.coverPhotoId}` : ''}`] as [string, unknown, unknown]] : []),
    ...(input.questionPageHeadline ? [['Question page headline', null, input.questionPageHeadline] as [string, unknown, unknown]] : []),
    ...(input.thankYouPage ? [['Ending screen', null, `${input.thankYouPage.title} — button ${input.thankYouPage.buttonType}${input.thankYouPage.websiteUrl ? ` → ${input.thankYouPage.websiteUrl}` : ''}`] as [string, unknown, unknown]] : []),
    ...(input.consent ? [['Consent boxes', null, `${input.consent.checkboxes?.length ?? 0} (${(input.consent.checkboxes ?? []).map((b) => b.key).join(', ') || 'text only'})`] as [string, unknown, unknown]] : []),
    ...(input.followUpUrl ? [['Website after the form', null, input.followUpUrl] as [string, unknown, unknown]] : []),
    ['Higher intent (review step)', null, yesNo(input.higherIntent, 'on', 'off', 'not set (Meta: off)')],
    ['SMS check of the phone number', null, yesNo(input.smsVerification, 'on', 'off', 'not set')],
    ['Work e-mail only', null, yesNo(input.workEmailOnly, 'on', 'off', 'not set')],
    ['For an Instant Experience', null, yesNo(input.forInstantExperience, 'yes', 'no', 'not set (Meta: no)')],
    ...(input.forMessenger ? [['For Messenger conversations', null, 'yes (only the six question types Meta allows there; Open Sharing)'] as [string, unknown, unknown]] : []),
    ...(input.trackingParameters && Object.keys(input.trackingParameters).length ? [['Hidden tracking parameters', null, Object.keys(input.trackingParameters).join(', ')] as [string, unknown, unknown]] : []),
    ['Lead-capture AI agent', null, 'off (always)'],
  ])
  const warnings = [
    LEAD_NO_CHECK,
    LEAD_AI_AGENT_OFF,
    'A lead form can never be edited or deleted afterwards (Meta has no update or delete for forms): its undo ARCHIVES it — it leaves the Forms library and cannot be used in new ads. A change means a new form.',
    ...(page.termsAccepted === false ? ['Meta says nobody accepted the Lead Ads Terms for this Page yet: Meta refuses the form until a person accepts them for the Page in Meta\'s screens (facebook.com/ads/leadgen/tos).'] : []),
    ...(page.termsAccepted === null ? [`${page.termsNote ?? 'Nexus could not read whether the Page\'s Lead Ads Terms are accepted.'} Meta refuses a form on a Page whose Lead Ads Terms nobody accepted.`] : []),
    ...(input.locale ? [] : ['No language set: Meta shows the pre-filled questions in its own default language. One form per language (IT_IT, DE_DE, FR_FR, ES_ES …) keeps each market in its own words; keep the question keys the same in each so the leads read alike.']),
    ...(input.questions.some((q) => q.dependsOn?.length) ? ['Conditional questions: Meta documents only their names, not how to write them; Nexus sends Meta\'s read shape ({field_key, input_type, name}) and Meta\'s answer says whether it takes it (LIVE-PROBES LD-004).'] : []),
    ...(input.smsVerification || input.questions.some((q) => q.type === 'PHONE_OTP') ? ['SMS verification: Meta decides in which countries it works; its guide on it could not be read today, so Meta\'s answer (or the form preview in Meta) says.'] : []),
    ...(input.questions.some((q) => q.type === 'STORE_LOOKUP' || q.type === 'STORE_LOOKUP_WITH_TYPEAHEAD') ? ['A store locator needs the Page\'s store locations (Store Pages, set up in Meta\'s screens); the lead\'s answer is the store\'s number.'] : []),
    ...(input.thankYouPage?.buttonType === 'PROMO_CODE' ? ['A promo-code button: Meta documents no field for the code itself in this call; a person adds the code to the form in Meta\'s Forms library.'] : []),
    ...(input.thankYouPage?.buttonType === 'VIEW_ON_FACEBOOK' ? [LEAD_NO_FILES] : []),
    ...(input.consent ? ['Consent: the answers to the consent boxes come back only in each lead\'s custom_disclaimer_responses, never among its answers — EU marketing consent is read there.'] : []),
    'Ask only for what the business needs (GDPR): every answer is a person\'s data.',
    LEADS_ACCESS,
  ]
  const request: MetaChangeRequest = {
    step: 1,
    label: `Create lead form "${input.name}" on the Facebook Page ${page.pageId}`,
    objectId: page.pageId,
    objectKind: 'page',
    edge: 'leadgen_forms',
    operation: 'leadform.create',
    params,
    check: 'none',
    raisesSpend: false,
    readBackInPost: false,
    readBackFields: 'id,name,status',
    budget: false,
    // Its undo (an archive) changes the new form, not the Page.
    undoable: false,
    explain: LEAD_FORM_EXPLAIN,
  }
  const before: LeadFormCreateRecord = { pageId: page.pageId, formId: null, name: input.name, archived: null }
  return {
    summary: `Create the lead form "${input.name}" with ${input.questions.length} question${input.questions.length === 1 ? '' : 's'} on the chosen Facebook Page — nothing spends: a form is used only by an ad that names it.`,
    changes,
    totals: { questions: input.questions.length, ...(more ? { moreLines: more } : {}) },
    warnings,
    spendsMoney: [],
    skipped: [],
    requests: [request],
    stands: { pageId: page.pageId, termsAccepted: page.termsAccepted },
    before,
    after: { ...before },
  }
}

// ── archive / re-activate ─────────────────────────────────────────────────────────────────────────────────────────

export type LeadFormAction = 'archive' | 'activate' | 'test-lead' | 'remove-test-lead'

/** set-meta-lead-form's record: what a change replaced and wrote, for undo (the Page and form always named). */
export interface LeadFormSetRecord {
  action: LeadFormAction
  pageId: string
  formId: string
  name?: string | null
  status?: string | null
  /** test-lead: the test lead the change made (after) — the ONLY leads the gateway lets Nexus delete. */
  testLeadId?: string | null
  /** test-lead with replaceTestLead: the old test leads it deleted first (gone for good). */
  replaced?: string[]
  /** remove-test-lead: the test lead it deleted. */
  removedTestLeadId?: string | null
}

/** archive / activate as a draft: one POST /{form} status=…, read back. */
export function leadFormStatusDraft(action: 'archive' | 'activate', form: LeadFormState): MetaChangeDraft | { refusal: string } {
  const wanted = action === 'archive' ? 'ARCHIVED' : 'ACTIVE'
  const named = `lead form "${form.name ?? 'no name'}" (${form.formId})`
  if (form.status === 'DELETED') return { refusal: `The ${named} is deleted: Meta lets nothing change it.` }
  if (form.status === 'DRAFT') return { refusal: `The ${named} is a draft (not published): Nexus archives and re-activates published forms only — its own choice, not a rule Meta states; publish or delete a draft in Meta's Forms library.` }
  const record = (status: string | null): LeadFormSetRecord => ({ action, pageId: form.pageId, formId: form.formId, name: form.name, status })
  // Review A4 — Nexus cannot list the ads that use a form (Meta has no such read), so a re-activation may let one deliver again.
  const spends = action === 'activate' && form.status !== wanted ? ['an ad that uses this form may deliver again once it is re-activated (Nexus cannot list the ads that use a form; check them in Ads Manager)'] : []
  const base = { totals: { forms: 1 }, spendsMoney: spends, stands: { formId: form.formId, pageId: form.pageId, status: form.status }, before: record(form.status), after: record(wanted) }
  if (form.status === wanted) {
    return { ...base, summary: `The ${named} is already ${wanted}.`, changes: {}, warnings: [], skipped: [`The ${named} is already ${wanted}: nothing to send.`], requests: [] }
  }
  const { changes } = changeLines([[`Lead form "${form.name ?? form.formId}" (${form.formId})`, form.status ?? 'unknown', wanted]])
  return {
    ...base,
    summary: action === 'archive'
      ? `Archive the ${named}: it leaves the Forms library and cannot be used in new ads (Meta has no delete for forms).`
      : `Re-activate the ${named}: it is back in the Forms library and can be used in ads again.`,
    changes,
    warnings: [
      LEAD_NO_CHECK,
      ...(action === 'archive' ? ['Meta says an archived form cannot be used in new ads; what it does to ads that already use it is not described — check them in Ads Manager before archiving a form a live ad uses. Its undo re-activates the form.'] : ['Its undo archives the form again.']),
    ],
    skipped: [],
    requests: [{
      step: 1,
      label: `${action === 'archive' ? 'Archive' : 'Re-activate'} lead form "${form.name ?? 'no name'}" (${form.formId})`,
      objectId: form.formId,
      objectKind: 'leadform',
      operation: 'leadform.status',
      params: { status: wanted },
      check: 'none',
      raisesSpend: action === 'activate',
      readBackInPost: false,
      readBackFields: 'id,status',
      expect: { status: wanted },
      budget: false,
      undoable: true,
      explain: LEAD_FORM_EXPLAIN,
    }],
  }
}

// ── test leads ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A made-up answer per question type (a test lead's answers are Nexus's own: no person's data). */
const TEST_ANSWER: Readonly<Record<string, string>> = {
  EMAIL: 'test@example.com', WORK_EMAIL: 'test@example.com', EMAIL_ALIAS: 'test@example.com', FULL_NAME: 'Test Lead', FIRST_NAME: 'Test',
  LAST_NAME: 'Lead', PHONE: '+390000000000', PHONE_OTP: '+390000000000', WORK_PHONE_NUMBER: '+390000000000', WHATSAPP_NUMBER: '+390000000000',
  USER_PROVIDED_PHONE_NUMBER: '+390000000000', CITY: 'Test City', STATE: 'Test', PROVINCE: 'Test', COUNTRY: 'IT', ZIP: '00000', POST_CODE: '00000',
  STREET_ADDRESS: 'Test Street 1', ADDRESS_LINE_TWO: 'Test', COMPANY_NAME: 'Shop A', JOB_TITLE: 'Test', WEBSITE: 'https://example.com',
}

export interface TestLeadInput {
  answers?: Array<{ question: string; values: string[] }>
  consent?: Array<{ key: string; checked: boolean }>
  replaceTestLead?: boolean
}

/** A form's test leads as the draft needs them: Meta's ids (null: not readable), and the ones Nexus made (its records). */
export interface TestLeadState { metaIds: string[] | null; metaNote?: string; nexusMade: string[] }

/** test-lead as a draft: (delete the old test lead Nexus made, when asked,) then make one with Nexus's made-up answers. */
export function testLeadDraft(input: TestLeadInput, form: LeadFormState, leads: TestLeadState): MetaChangeDraft | { refusal: string } {
  const named = `lead form "${form.name ?? 'no name'}" (${form.formId})`
  if (form.status === 'DELETED') return { refusal: `The ${named} is deleted: Meta takes no test lead on it.` }
  const keys = form.questions.map((q) => q.key).filter((k): k is string => !!k)
  if (!keys.length) return { refusal: `Meta names no question keys on the ${named}, so Nexus cannot say which answer goes where.` }
  const given = new Map((input.answers ?? []).map((a) => [a.question, a.values]))
  const stray = [...given.keys()].find((k) => !keys.includes(k))
  if (stray) return { refusal: `The ${named} has no question with the key "${stray}" (its keys: ${keys.join(', ')}).` }
  const fieldData = form.questions.filter((q) => q.key).map((q) => ({
    name: q.key!,
    values: given.get(q.key!) ?? [q.options[0] ?? (q.type ? TEST_ANSWER[q.type] : undefined) ?? 'test'],
  }))
  const consentGiven = new Map((input.consent ?? []).map((c) => [c.key, c.checked]))
  const strayBox = [...consentGiven.keys()].find((k) => !form.checkboxKeys.includes(k))
  if (strayBox) return { refusal: `The ${named} has no consent box with the key "${strayBox}"${form.checkboxKeys.length ? ` (its boxes: ${form.checkboxKeys.join(', ')})` : ' (it has none)'}.` }
  const consent = form.checkboxKeys.map((k) => ({ checkbox_key: k, is_checked: consentGiven.get(k) ?? true }))
  const params: Record<string, string> = { field_data: JSON.stringify(fieldData), ...(consent.length ? { custom_disclaimer_responses: JSON.stringify(consent) } : {}) }
  const judged = metaTestLeadProblem(new Map(Object.entries(params)))
  if (judged) return { refusal: `Nexus would not send this test lead: ${judged}.` }

  const existing = leads.metaIds ?? []
  const notOurs = existing.filter((id) => !leads.nexusMade.includes(id))
  const warnings = [LEAD_NO_CHECK, 'A test lead is Nexus\'s own made-up answers, tied to no ad (Meta\'s testing guide); it is never kept by Nexus. Its undo deletes it.']
  const requests: MetaChangeRequest[] = []
  if (existing.length) {
    if (!input.replaceTestLead) {
      return { refusal: `The ${named} already has a test lead (Meta allows one per form). Ask again with replaceTestLead: true — Nexus then deletes the test lead it made first${notOurs.length ? ', but this one Nexus did not make, so a person deletes it in Meta\'s lead ads testing tool (developers.facebook.com/tools/lead-ads-testing)' : ''}.` }
    }
    if (notOurs.length) return { refusal: `The ${named} has a test lead Nexus did not make, and Nexus deletes only its own: a person deletes it in Meta's lead ads testing tool (developers.facebook.com/tools/lead-ads-testing), then ask again.` }
    for (const id of existing) {
      requests.push({
        step: requests.length + 1, label: `Delete the old test lead ${id} Nexus made on ${named}`, objectId: id, objectKind: 'testlead', method: 'DELETE', operation: 'testlead.delete',
        params: {}, check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false, explain: LEAD_FORM_EXPLAIN,
      })
    }
    warnings.push(`The old test lead${existing.length === 1 ? '' : 's'} (${existing.join(', ')}) ${existing.length === 1 ? 'is' : 'are'} deleted for good first (a deleted lead cannot come back).`)
  } else if (leads.metaIds === null) {
    if (input.replaceTestLead) return { refusal: `Nexus could not read the test leads of the ${named} (${leads.metaNote ?? 'Meta did not list them'}), so it cannot tell which one to delete first. Ask without replaceTestLead: Meta refuses a second test lead in words.` }
    warnings.push(`Nexus could not read the form's test leads (${leads.metaNote ?? 'Meta did not list them'}): Meta allows one per form and refuses a second in words.`)
  }
  requests.push({
    step: requests.length + 1, label: `Make a test lead on ${named}`, objectId: form.formId, objectKind: 'leadform', edge: 'test_leads', operation: 'testlead.create',
    params, check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false, skipReadBack: true, explain: LEAD_FORM_EXPLAIN,
  })
  const { changes } = changeLines([
    [`Test lead on ${named}`, existing.length ? `test lead ${existing.join(', ')} (Nexus's)` : 'none', 'a new test lead'],
    ['Answers', null, cut(fieldData.map((f) => `${f.name}: ${f.values.join(' / ')}`).join(', '))],
    ...(consent.length ? [['Consent boxes', null, consent.map((c) => `${c.checkbox_key} ${c.is_checked ? 'ticked' : 'not ticked'}`).join(', ')] as [string, unknown, unknown]] : []),
  ])
  const record = (testLeadId: string | null): LeadFormSetRecord => ({ action: 'test-lead', pageId: form.pageId, formId: form.formId, name: form.name, testLeadId, ...(existing.length ? { replaced: existing } : {}) })
  return {
    summary: `${existing.length ? 'Replace the test lead of' : 'Make a test lead on'} the ${named} with Nexus's made-up answers (one per form; nothing spends).`,
    changes,
    totals: { answers: fieldData.length, deletedFirst: existing.length },
    warnings,
    spendsMoney: [],
    skipped: [],
    requests,
    stands: { formId: form.formId, pageId: form.pageId, status: form.status, questions: keys, checkboxKeys: form.checkboxKeys, testLeads: leads.metaIds, nexusMade: leads.nexusMade.filter((id) => existing.includes(id)) },
    before: record(null),
    after: record(null),
  }
}

/** remove-test-lead as a draft: DELETE /{lead} of a test lead Nexus made on this form (explicit ask; gone for good). */
export function removeTestLeadDraft(testLeadId: string, form: LeadFormState, leads: TestLeadState): MetaChangeDraft | { refusal: string } {
  const named = `lead form "${form.name ?? 'no name'}" (${form.formId})`
  if (!leads.nexusMade.includes(testLeadId)) {
    return { refusal: `${testLeadId} is not a test lead Nexus made on the ${named}. Nexus deletes only its own test leads, never a real lead (Meta documents deleting for test leads only; a person's request to erase their data is handled in Nexus's own copy and in Meta's Leads Center).` }
  }
  const record = (id: string | null): LeadFormSetRecord => ({ action: 'remove-test-lead', pageId: form.pageId, formId: form.formId, name: form.name, testLeadId: null, removedTestLeadId: id })
  const base = { totals: { testLeads: 1 }, spendsMoney: [] as string[], stands: { formId: form.formId, pageId: form.pageId, testLeads: leads.metaIds, testLeadId }, before: record(null), after: record(testLeadId) }
  if (leads.metaIds && !leads.metaIds.includes(testLeadId)) {
    return { ...base, summary: `Test lead ${testLeadId} is no longer on the ${named}.`, changes: {}, warnings: [], skipped: [`Test lead ${testLeadId} is no longer on the ${named}: nothing to delete.`], requests: [] }
  }
  return {
    ...base,
    summary: `Delete the test lead ${testLeadId} Nexus made on the ${named} — for good (a deleted lead cannot come back; a new test lead can be made).`,
    changes: changeLines([[`Test lead ${testLeadId} on ${named}`, 'there', 'deleted']]).changes,
    warnings: [LEAD_NO_CHECK, ...(leads.metaIds === null ? [`Nexus could not read the form's test leads (${leads.metaNote ?? 'Meta did not list them'}): Meta's answer says whether it was still there.`] : [])],
    skipped: [],
    requests: [{
      step: 1, label: `Delete the test lead ${testLeadId} Nexus made on ${named}`, objectId: testLeadId, objectKind: 'testlead', method: 'DELETE', operation: 'testlead.delete',
      params: {}, check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false, explain: LEAD_FORM_EXPLAIN,
    }],
  }
}

/** The caps a tool input shares with the gateway (one place). */
export { META_LEAD_LIMITS }
