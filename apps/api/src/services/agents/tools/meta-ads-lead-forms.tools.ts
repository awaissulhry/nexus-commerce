/**
 * Meta ads changes, step 36 (2026-10-21) — lead forms and test leads (master rows LD-001…LD-022, LD-026, LD-027, LD-037,
 * LD-039; Owner decision D4 = B: forms and TEST leads now, real leads stay in Meta's Leads Center until App Review):
 *   create-meta-lead-form  an instant form on the business's CHOSEN Facebook Page, every option in ONE call; undo archives it
 *   set-meta-lead-form     archive / re-activate a form of that Page; make its one test lead (replacing the one Nexus made,
 *                          when asked); delete a test lead Nexus made (explicit ask) — never a real lead
 * A Nexus change like every other Meta change (meta-ads-kit.ts): a preview from the live state (Meta has no check for any
 * of these: said), an approvalId, a person approves it, it runs as that person, undo puts back what it can.
 *
 * Every request goes AS the Page: the gateway reads the chosen Page's own token for that one call (gateway/meta-page-token.ts,
 * the Page token mode, Q1) and sends it only for the chosen Page or a child it confirmed (gateway/meta-page-owner.ts). The
 * tools never see a token.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, recordAccount, runMetaChange, type MetaDraftBuilder } from './meta-ads-kit.js'
import { META_LEAD_FORM_CREATE_TOOL, META_LEAD_FORM_SET_TOOL } from '../../gateway/account.js'
import {
  META_LEAD_BUTTON_TYPES, META_LEAD_CARD_STYLES, META_LEAD_KEY, META_LEAD_LIMITS, META_LEAD_LOCALES, META_LEAD_QUESTION_TYPES, metaLeadUrlProblem,
} from '../../gateway/meta-lead-form-rules.js'
import {
  leadFormCreateDraft, leadFormStatusDraft, removeTestLeadDraft, testLeadDraft,
  type LeadFormCreateInput, type LeadFormCreateRecord, type LeadFormSetRecord, type TestLeadInput,
} from '../../marketing/meta-ads/change-lead-forms.js'
import { liveLeadFormPage, liveLeadFormState, liveTestLeadIds, nexusTestLeadsOf } from '../../marketing/meta-ads/live-lead-forms.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { LEADS_ACCESS } from '../../marketing/meta-ads/live-engagement.js'

const L = META_LEAD_LIMITS
const words = (max: number, what: string) => z.string().trim().min(1).max(max).describe(what)
const keyArg = (what: string) => z.string().regex(META_LEAD_KEY, 'letters, digits and _ (at most 100)').describe(what)
const httpsUrl = (what: string) => z.string().trim().max(L.url).refine((v) => metaLeadUrlProblem(v, 'it') === null, 'an https link (https://…, a host, no user or password)').describe(what)
const flag = (what: string) => z.boolean().optional().describe(what)

/** A builder's refusal in words (MetaLiveRefusal: the chosen Page, the form's owner check, Meta's words). */
const refused = (build: MetaDraftBuilder): MetaDraftBuilder => async (account) => {
  try {
    return await build(account)
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}

/** The Page a record was made on must still be the business's chosen Page: else undo says so and sends nothing. */
async function recordPage(record: { pageId?: unknown }, connectionId: string): Promise<boolean> {
  try {
    return (await liveLeadFormPage(connectionId)).pageId === record.pageId
  } catch {
    return false
  }
}

// ── create-meta-lead-form ─────────────────────────────────────────────────────────────────────────────────────────

const questionArg = z.object({
  type: z.enum(META_LEAD_QUESTION_TYPES).describe('Meta\'s question type: pre-filled ones (FULL_NAME, EMAIL, PHONE, CITY, ZIP, COMPANY_NAME, JOB_TITLE, WORK_EMAIL, DOB, … — Meta spells MARITIAL_STATUS so), CUSTOM (short answer, or multiple choice with options), DATE_TIME (appointment request), STORE_LOOKUP / STORE_LOOKUP_WITH_TYPEAHEAD (store locator; needs the Page\'s store locations), PHONE_OTP (phone checked by SMS code). SLIDER and the national ids ID_* are refused in words'),
  key: keyArg('the name each answer carries in a lead (field_data name) — keep it the SAME in every language so the leads of all markets read alike; default for a pre-filled type: the type in lower case; a CUSTOM question names its own').optional(),
  label: words(L.label, 'the question the person reads (a CUSTOM question needs one)').optional(),
  helpText: words(L.label, 'text under the question (Meta inline_context; an appointment question\'s confirmation line)').optional(),
  options: z.array(z.object({ value: words(L.optionValue, 'what the person picks'), key: keyArg('its own key (each once)') })).min(1).max(L.options).optional()
    .describe(`multiple choice for a CUSTOM question (at most ${L.options})`),
  dependsOn: z.array(z.object({
    fieldKey: keyArg('Meta\'s field_key of the linked question (which way the link goes is not documented yet: LIVE-PROBES LD-004)'),
    inputType: z.enum(META_LEAD_QUESTION_TYPES).describe('Meta\'s input_type of the linked question'),
    name: words(L.label, 'Meta\'s name of the linked question'),
  })).min(1).max(L.dependents).optional()
    .describe('conditional questions (Meta dependent_conditional_questions): Meta documents only the parameter\'s name, not its shape or its direction, so Nexus sends the SDK\'s read shape {field_key, input_type, name} as given and Meta\'s answer says whether and how it takes it (LIVE-PROBES LD-004)'),
})

const createInput = z.object({
  connectionId: metaConnectionArg,
  name: words(L.name, 'the form\'s name in Meta\'s Forms library (people do not see it)'),
  locale: z.enum(META_LEAD_LOCALES).optional().describe('the language Meta shows the pre-filled questions in (IT_IT, DE_DE, FR_FR, ES_ES, EN_GB, …): one form per language and market'),
  questions: z.array(questionArg).min(1).max(L.questions).describe(`the questions, in order (at most ${L.questions}; ask only what the business needs — GDPR)`),
  privacyPolicy: z.object({
    url: httpsUrl('the business\'s privacy policy page (https)'),
    linkText: words(L.linkText, `the link\'s text (at most ${L.linkText}, Meta\'s limit)`).optional(),
  }).describe('the privacy policy link the form shows (Meta needs one)'),
  intro: z.object({
    title: words(L.title, 'its headline').optional(),
    style: z.enum(META_LEAD_CARD_STYLES).optional().describe('LIST_STYLE (bullet points) or PARAGRAPH_STYLE'),
    content: z.array(words(L.cardText, 'one line or paragraph')).min(1).max(L.cardContent).optional().describe(`its lines (at most ${L.cardContent})`),
    buttonText: words(L.buttonText, 'its button').optional(),
    coverPhotoId: metaIdArg('a photo already on the chosen Facebook Page, as the intro\'s cover (the gateway checks it is the Page\'s photo; Nexus uploads no new file)').optional(),
  }).optional().describe('the intro (greeting) screen before the questions (Meta context_card)'),
  thankYouPage: z.object({
    title: words(L.title, 'its headline'),
    body: words(L.body, 'its text').optional(),
    shortMessage: words(L.title, 'a short line').optional(),
    buttonText: words(L.buttonText, 'the button\'s text').optional(),
    buttonDescription: words(L.title, 'a line by the button').optional(),
    buttonType: z.enum(META_LEAD_BUTTON_TYPES).describe('VIEW_WEBSITE, CALL_BUSINESS, MESSAGE_BUSINESS, DOWNLOAD, SCHEDULE_APPOINTMENT, VIEW_ON_FACEBOOK, PROMO_CODE (how a "10 % off" offer is given: the code itself is added in Meta\'s Forms library), NONE, WHATSAPP, P2B_MESSENGER, BOOK_ON_WEBSITE'),
    websiteUrl: httpsUrl('where VIEW_WEBSITE / BOOK_ON_WEBSITE goes').optional(),
    businessPhoneNumber: z.string().regex(/^\+?\d{6,20}$/, 'digits, an optional + first').optional().describe('the business\'s own number for CALL_BUSINESS / WHATSAPP'),
    countryCode: z.string().regex(/^[A-Z]{2}$/, 'two capital letters').optional().describe('the number\'s country (IT, DE, FR, ES, …)'),
    enableMessenger: z.boolean().optional().describe('offer a Messenger chat on the ending screen'),
  }).optional().describe('the ending (thank-you) screen'),
  consent: z.object({
    title: words(L.title, 'its headline').optional(),
    text: words(L.body, 'the consent text the person reads'),
    links: z.array(z.object({
      offset: z.number().int().min(0).max(L.body).describe('where the linked words start in the text (0 = the first character)'),
      length: z.number().int().min(1).max(L.body).describe('how many characters are linked'),
      url: httpsUrl('the link (https)'),
    })).max(L.urlEntities).optional().describe(`links inside the text (at most ${L.urlEntities})`),
    checkboxes: z.array(z.object({
      key: keyArg('the box\'s key (its answer comes back under it in custom_disclaimer_responses)'),
      text: words(L.checkboxText, 'what the person agrees to'),
      required: z.boolean().optional().describe('the person must tick it to send the form (Meta\'s default: yes)'),
      checkedByDefault: z.boolean().optional().describe('ticked at first (Meta\'s default: no; EU consent: leave it unticked)'),
    })).max(L.checkboxes).optional().describe(`consent boxes (at most ${L.checkboxes}): their answers come back only in custom_disclaimer_responses, never among the answers`),
  }).optional().describe('a custom disclaimer with consent boxes (Meta custom_disclaimer)'),
  followUpUrl: httpsUrl('the website the "view website" button opens after the form (Meta follow_up_action_url)').optional(),
  questionPageHeadline: words(L.headline, 'the headline of the question page').optional(),
  higherIntent: flag('add a review-and-confirm step before the form is sent (Meta is_optimized_for_quality; default off = more, lighter leads)'),
  smsVerification: flag('check the phone number by an SMS code (Meta is_phone_sms_verify_enabled; needs a PHONE question; Meta decides where it works)'),
  workEmailOnly: flag('accept only work e-mail addresses (Meta should_enforce_work_email; needs a WORK_EMAIL question)'),
  forInstantExperience: flag('a form used inside an Instant Experience (Meta is_for_canvas)'),
  onlyTargetedPeople: flag('show the form only to people the ad targets (true, default: organic leads filtered out) or to anyone it is shared with (false, Meta\'s "Open Sharing")'),
  forMessenger: flag('a form for Messenger conversations: only CUSTOM, EMAIL, FIRST_NAME, FULL_NAME, LAST_NAME and PHONE questions, and Open Sharing'),
  trackingParameters: z.record(z.string().regex(META_LEAD_KEY), words(L.trackingValue, 'its value')).refine((r) => Object.keys(r).length >= 1 && Object.keys(r).length <= L.tracking, `1 to ${L.tracking} parameters`).optional()
    .describe('hidden tracking parameters, name → value: not shown to the person, returned with every lead\'s answers'),
  why: metaWhyArg,
})

const buildCreate = (args: Record<string, unknown>): MetaDraftBuilder => refused(async (account) => {
  const input = args as unknown as LeadFormCreateInput
  return leadFormCreateDraft(input, await liveLeadFormPage(account.accountId))
})

/** Undo of a form create: archive the form it made (Meta deletes no form); the record holds its id and Page. */
const createUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as LeadFormCreateRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account || !after.formId || !(await recordPage(after, account.accountId))) return null
    const form = await liveLeadFormState(account.accountId, after.formId).catch(() => null)
    if (!form) return null
    return { pageId: after.pageId, formId: after.formId, name: after.name, archived: form.status === 'ARCHIVED', accountId: account.accountId, adAccountId: account.adAccountId }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as LeadFormCreateRecord & { accountId?: string }
    if (!after.formId) return { refusal: 'This change kept no id of the form it made, so there is nothing to archive.' }
    return {
      tool: META_LEAD_FORM_SET_TOOL,
      args: { ...(after.accountId ? { connectionId: after.accountId } : {}), action: 'archive', formId: after.formId, why: 'undo of an earlier lead form create (Meta deletes no form: it is archived)' },
    }
  },
}

const createMetaLeadForm: AgentTool = {
  name: META_LEAD_FORM_CREATE_TOOL,
  title: 'Create a Meta lead form',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // Its undo archives the form (it leaves the Forms library); Meta deletes no form.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: createInput,
  description:
    'Create an instant (lead) form on the business\'s chosen Facebook Page, with every option in ONE request: questions '
    + '(pre-filled, custom short answer and multiple choice, appointment, store locator, phone checked by SMS, work e-mail '
    + 'only; conditional questions sent in Meta\'s read shape), the language of the pre-filled questions (one form per '
    + 'language: keep the question keys the same), the privacy policy link (link text at most 70), an intro screen (a '
    + 'photo already on the Page as cover), the question page headline, the ending screen and its button (website, call, '
    + 'WhatsApp, Messenger, promo code …), a consent text with consent boxes (their answers come back only in '
    + 'custom_disclaimer_responses), a higher-intent review step, who sees it (only the people the ad targets, or Open '
    + 'Sharing), a Messenger or Instant Experience form, hidden tracking parameters and the website after the form. '
    + 'Meta\'s lead-capture AI agent is always sent OFF (Meta documents nothing of it); sliders and national ids are refused '
    + 'in words; Nexus does not upload a file you give (a new cover photo or a gated download is added in Meta\'s Forms library). Meta has no check for it, and a form can '
    + 'never be edited or deleted afterwards: its undo ARCHIVES it. Nothing spends: a form is used only by an ad that names '
    + 'it. It goes AS the Page: Nexus\'s gateway reads the chosen Page\'s own token for this one request (the system user '
    + 'needs the Page\'s Advertise task) — a token is never shown. Real leads stay in Meta\'s Leads Center until the '
    + 'business\'s app passes App Review (leads_retrieval), Business Verification and goes Live (D4); test leads are '
    + 'set-meta-lead-form. meta-lead-forms reads the forms.'
    + META_CHANGE_RULES,
  undo: createUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildCreate(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildCreate(args), (draft, done) => {
    const before = draft.before as LeadFormCreateRecord
    const node = done[0]?.result.node ?? null
    const formId = node && (typeof node.id === 'string' || typeof node.id === 'number') ? String(node.id) : null
    const status = node && typeof node.status === 'string' ? node.status : null
    return {
      data: { pageId: before.pageId, formId, name: before.name, status, note: formId ? 'meta-lead-forms view form reads it; set-meta-lead-form makes its test lead or archives it. Its id is kept with this change (Meta lists no forms by API).' : 'Meta made the form but Nexus could not read its id from Meta\'s answer: meta-lead-forms view list shows it.' },
      before: { ...before },
      after: { pageId: before.pageId, formId, name: before.name, archived: status === null ? false : status === 'ARCHIVED' },
    }
  }),
}

// ── set-meta-lead-form ────────────────────────────────────────────────────────────────────────────────────────────

const ACTIONS = ['archive', 'activate', 'test-lead', 'remove-test-lead'] as const

const setInput = z.object({
  connectionId: metaConnectionArg,
  action: z.enum(ACTIONS).describe('archive (the form leaves the Forms library and cannot be used in new ads) · activate (re-activate an archived form) · test-lead (make the form\'s one test lead with made-up answers) · remove-test-lead (delete a test lead Nexus made — explicit ask, confirmDelete)'),
  formId: metaIdArg('the lead form, of the business\'s chosen Facebook Page (meta-lead-forms view list)'),
  answers: z.array(z.object({
    question: words(200, 'the question\'s key as the form has it (meta-lead-forms view form; a form made in Meta\'s screens may use any key)'),
    values: z.array(words(L.testAnswer, 'an answer')).min(1).max(L.testAnswers).describe('its answer(s)'),
  })).max(L.questions).optional().describe('test-lead: answers of your own by question key (default: Nexus\'s made-up answers — test@example.com, Test Lead, the first option …)'),
  consent: z.array(z.object({ key: words(200, 'the consent box\'s key as the form has it'), checked: z.boolean().describe('ticked or not') })).max(L.checkboxes).optional()
    .describe('test-lead: how each consent box is answered (default: every box ticked)'),
  replaceTestLead: z.boolean().optional().describe('test-lead: the form already has a test lead Nexus made (Meta allows one per form): delete it first, for good'),
  testLeadId: metaIdArg('remove-test-lead: the test lead Nexus made (its change record or meta-leads view test shows it)').optional(),
  confirmDelete: z.literal(true).optional().describe('remove-test-lead: true — the person asked to delete it (a deleted lead cannot come back)'),
  why: metaWhyArg,
})

type SetArgs = z.infer<typeof setInput>

const buildSet = (args: Record<string, unknown>): MetaDraftBuilder => refused(async (account) => {
  const a = args as unknown as SetArgs
  if (a.action === 'remove-test-lead' && (!a.testLeadId || a.confirmDelete !== true)) {
    return { refusal: 'Deleting a test lead is only on an explicit ask: name testLeadId and confirmDelete: true (a deleted lead cannot come back).' }
  }
  if (a.action !== 'test-lead' && (a.answers || a.consent || a.replaceTestLead !== undefined)) return { refusal: 'answers, consent and replaceTestLead are for action test-lead only.' }
  if (a.action !== 'remove-test-lead' && (a.testLeadId || a.confirmDelete)) return { refusal: 'testLeadId and confirmDelete are for action remove-test-lead only.' }
  const form = await liveLeadFormState(account.accountId, a.formId)
  if (a.action === 'archive' || a.action === 'activate') return leadFormStatusDraft(a.action, form)
  const listed = await liveTestLeadIds(account.accountId, form.formId)
  const leads = { metaIds: listed.ids, ...(listed.note ? { metaNote: listed.note } : {}), nexusMade: await nexusTestLeadsOf(form.pageId, form.formId) }
  if (a.action === 'remove-test-lead') return removeTestLeadDraft(a.testLeadId!, form, leads)
  const input: TestLeadInput = { ...(a.answers ? { answers: a.answers } : {}), ...(a.consent ? { consent: a.consent } : {}), ...(a.replaceTestLead !== undefined ? { replaceTestLead: a.replaceTestLead } : {}) }
  return testLeadDraft(input, form, leads)
})

/** What a recorded change of set-meta-lead-form reads now (the shape of its `after`). */
const setUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as LeadFormSetRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account || !after.formId || !(await recordPage(after, account.accountId))) return null
    const stamp = { accountId: account.accountId, adAccountId: account.adAccountId }
    if (after.action === 'archive' || after.action === 'activate') {
      const form = await liveLeadFormState(account.accountId, after.formId).catch(() => null)
      return form ? { ...after, status: form.status, ...stamp } : null
    }
    if (after.action === 'test-lead') {
      const listed = await liveTestLeadIds(account.accountId, after.formId)
      // Meta not listing the test leads: as recorded (the undo's DELETE answers for itself; the gateway allows only Nexus's own).
      const present = listed.ids === null ? true : !!after.testLeadId && listed.ids.includes(after.testLeadId)
      return { ...after, testLeadId: present ? after.testLeadId : null, ...stamp }
    }
    return { ...after, ...stamp }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as LeadFormSetRecord & { accountId?: string }
    const connection = after.accountId ? { connectionId: after.accountId } : {}
    if (after.action === 'archive') return { tool: META_LEAD_FORM_SET_TOOL, args: { ...connection, action: 'activate', formId: after.formId, why: 'undo of an earlier lead form archive' } }
    if (after.action === 'activate') return { tool: META_LEAD_FORM_SET_TOOL, args: { ...connection, action: 'archive', formId: after.formId, why: 'undo of an earlier lead form re-activation' } }
    if (after.action === 'test-lead') {
      if (!after.testLeadId) return { refusal: 'This change kept no id of the test lead it made, so there is nothing to delete.' }
      return {
        tool: META_LEAD_FORM_SET_TOOL,
        args: { ...connection, action: 'remove-test-lead', formId: after.formId, testLeadId: after.testLeadId, confirmDelete: true, why: `undo of an earlier test lead${after.replaced?.length ? ' (the old test lead it replaced stays deleted)' : ''}` },
      }
    }
    return { refusal: 'A deleted test lead cannot come back (Meta has no restore); make a new one with set-meta-lead-form action test-lead.' }
  },
}

const setMetaLeadForm: AgentTool = {
  name: META_LEAD_FORM_SET_TOOL,
  title: 'Archive or test a Meta lead form',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // Archive ⇄ re-activate are undone in full, a test lead by deleting it; a deleted test lead cannot come back.
  reversibility: 'partial',
  consequencesFor: (args) => {
    if (args.action === 'archive' || args.action === 'activate') return { reversibility: 'full' }
    if (args.action === 'remove-test-lead') return { reversibility: 'none' }
    if (args.action === 'test-lead') return args.replaceTestLead ? null : { reversibility: 'full' }
    return null
  },
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: setInput,
  description:
    'Change a lead form of the business\'s chosen Facebook Page: ARCHIVE it (it leaves the Forms library and cannot be used '
    + 'in new ads; Meta deletes no form) or RE-ACTIVATE an archived one (POST /<form> status — never the guide\'s GET); make '
    + 'its TEST LEAD (Meta allows one per form: Nexus\'s made-up answers by question key, or answers of your own, and the '
    + 'consent boxes; replaceTestLead deletes the test lead Nexus made first, for good); or DELETE a test lead Nexus made '
    + '(confirmDelete: true; a deleted lead cannot come back). Nexus deletes only its own test leads, never a real lead '
    + '(Meta documents deleting for test leads only; a person\'s erasure request is handled in Nexus\'s own copy and Meta\'s '
    + 'Leads Center), and never reads a lead here. The form must be one of the chosen Page\'s (checked before anything is '
    + 'sent). Meta has no check for these. Nothing spends. It goes AS the Page: Nexus\'s gateway reads the chosen Page\'s '
    + 'own token for each request (the system user needs the Page\'s Advertise task) — a token is never shown. Undo: '
    + 'archive ⇄ re-activate, a test lead is deleted. Real leads: ' + LEADS_ACCESS
    + META_CHANGE_RULES,
  undo: setUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildSet(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildSet(args), (draft, done) => {
    const before = draft.before as LeadFormSetRecord
    const after = draft.after as LeadFormSetRecord
    const made = done.find(({ request }) => request.operation === 'testlead.create')
    const madeId = made?.result.node && (typeof made.result.node.id === 'string' || typeof made.result.node.id === 'number') ? String(made.result.node.id) : null
    const deleted = done.filter(({ request }) => request.operation === 'testlead.delete').map(({ request }) => request.objectId)
    const statusDone = done.find(({ request }) => request.operation === 'leadform.status')
    const readStatus = statusDone?.result.node && typeof statusDone.result.node.status === 'string' ? statusDone.result.node.status : null
    const record: LeadFormSetRecord = after.action === 'test-lead'
      ? { ...after, testLeadId: madeId, ...(deleted.length ? { replaced: deleted } : {}) }
      : after.action === 'remove-test-lead'
        ? { ...after, removedTestLeadId: deleted[0] ?? null }
        : { ...after, status: readStatus ?? after.status ?? null }
    return {
      data: {
        action: after.action, pageId: after.pageId, formId: after.formId,
        ...(after.action === 'test-lead' ? { testLeadId: madeId, deletedFirst: deleted } : {}),
        ...(after.action === 'remove-test-lead' ? { deleted } : {}),
        ...(after.action === 'archive' || after.action === 'activate' ? { from: before.status ?? null, to: record.status ?? null } : {}),
        ...(after.action === 'test-lead' ? { note: madeId ? 'meta-leads view test reads it (Nexus keeps none of its answers). Its undo deletes it.' : 'Meta made the test lead but named no id in its answer; meta-leads view test shows it.' } : {}),
      },
      before: { ...before },
      after: record,
    }
  }),
}

export const META_ADS_LEAD_FORMS_TOOLS: AgentTool[] = [createMetaLeadForm, setMetaLeadForm]
