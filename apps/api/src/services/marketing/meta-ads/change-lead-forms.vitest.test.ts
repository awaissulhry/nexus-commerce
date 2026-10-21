/**
 * Meta step 36 — lead forms and test leads as pure drafts: one create with every option on the chosen Page (the AI agent
 * always off, who sees it always named, sliders / national ids / Messenger misfits refused in words), archive ⇄
 * re-activate, one test lead per form (the old one deleted first only when asked and only when Nexus made it), and a
 * test lead deleted only when Nexus made it. Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import { leadFormCreateDraft, leadFormParams, leadFormStatusDraft, LEAD_FORM_EXPLAIN, removeTestLeadDraft, testLeadDraft, type LeadFormCreateInput } from './change-lead-forms.js'
import { metaLeadFormCreateProblem, metaTestLeadProblem } from '../../gateway/meta-lead-form-rules.js'
import type { LeadFormState } from './live-lead-forms.js'

const PAGE = { pageId: '120000000000010', termsAccepted: true as boolean | null }
const FORM: LeadFormState = {
  pageId: '120000000000010', formId: '600000000000001', name: 'Form A', status: 'ACTIVE',
  questions: [{ key: 'full_name', type: 'FULL_NAME', options: [] }, { key: 'email', type: 'EMAIL', options: [] }, { key: 'size', type: 'CUSTOM', options: ['M', 'L'] }],
  checkboxKeys: ['consent_marketing'],
}
const base: LeadFormCreateInput = { name: 'Form A — Italia', locale: 'IT_IT', questions: [{ type: 'FULL_NAME' }, { type: 'EMAIL' }], privacyPolicy: { url: 'https://example.com/privacy' } }
const draft = (input: Partial<LeadFormCreateInput>, page = PAGE) => leadFormCreateDraft({ ...base, ...input }, page)
const refusal = (input: Partial<LeadFormCreateInput>) => { const d = draft(input); return 'refusal' in d ? d.refusal : null }

describe('create a form', () => {
  it('one request on the chosen Page, every option in it, the AI agent off and who sees it always sent; nothing spends', () => {
    const d = draft({ thankYouPage: { title: 'Grazie', buttonType: 'VIEW_WEBSITE', websiteUrl: 'https://example.com' } })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.requests).toHaveLength(1)
    expect(d.requests[0]).toMatchObject({ objectId: PAGE.pageId, objectKind: 'page', edge: 'leadgen_forms', operation: 'leadform.create', check: 'none', raisesSpend: false, undoable: false, explain: LEAD_FORM_EXPLAIN })
    const p = d.requests[0].params
    expect(p).toMatchObject({ name: 'Form A — Italia', locale: 'IT_IT', is_lead_capture_ai_agent_enabled: 'false', block_display_for_non_targeted_viewer: 'true' })
    expect(JSON.parse(p.questions)).toEqual([{ type: 'FULL_NAME', key: 'full_name' }, { type: 'EMAIL', key: 'email' }])
    expect(JSON.parse(p.thank_you_page)).toEqual({ title: 'Grazie', button_type: 'VIEW_WEBSITE', website_url: 'https://example.com' })
    // What the draft sends is exactly what the gateway's own judge accepts.
    expect(metaLeadFormCreateProblem(new Map(Object.entries(p)))).toBeNull()
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings.join(' ')).toMatch(/Meta has no check \(validate_only\)/)
    expect(d.warnings.join(' ')).toMatch(/AI agent stays OFF/)
    expect(d.warnings.join(' ')).toMatch(/never be edited or deleted afterwards \(Meta has no update or delete for forms\): its undo ARCHIVES it/)
    expect(d.warnings.join(' ')).toMatch(/App Review of the business's Meta app for leads_retrieval/)
    expect(d.changes['Lead-capture AI agent']).toEqual({ from: null, to: 'off (always)' })
    expect(d.before).toEqual({ pageId: PAGE.pageId, formId: null, name: 'Form A — Italia', archived: null })
  })
  it('every option maps to Meta\'s names (LD-002…LD-022), in Nexus\'s one spelling', () => {
    const p = leadFormParams({
      ...base,
      questions: [
        { type: 'CUSTOM', key: 'size', label: 'Taglia?', helpText: 'Scegli', options: [{ value: 'M', key: 'm' }] },
        { type: 'DATE_TIME', key: 'when', label: 'Quando?' }, { type: 'STORE_LOOKUP', key: 'store', label: 'Negozio?' },
        { type: 'CUSTOM', key: 'b', label: 'B?', dependsOn: [{ fieldKey: 'size', inputType: 'CUSTOM', name: 'Taglia' }] },
      ],
      privacyPolicy: { url: 'https://example.com/privacy', linkText: 'Privacy' },
      intro: { title: 'Ciao', style: 'PARAGRAPH_STYLE', content: ['Uno'], buttonText: 'Avanti', coverPhotoId: '800000000000001' },
      consent: { title: 'Consenso', text: 'Leggi i termini', links: [{ offset: 8, length: 7, url: 'https://example.com/t' }], checkboxes: [{ key: 'consent_marketing', text: 'Sì' }] },
      followUpUrl: 'https://example.com/after', questionPageHeadline: 'Due domande', higherIntent: true, smsVerification: false, workEmailOnly: false,
      forInstantExperience: true, onlyTargetedPeople: false, trackingParameters: { ref: 'spring' },
    })
    expect(JSON.parse(p.questions)).toEqual([
      { type: 'CUSTOM', key: 'size', label: 'Taglia?', inline_context: 'Scegli', options: [{ value: 'M', key: 'm' }] },
      { type: 'DATE_TIME', key: 'when', label: 'Quando?' },
      { type: 'STORE_LOOKUP', key: 'store', label: 'Negozio?', context_provider_type: 'LOCATION_MANAGER' },
      { type: 'CUSTOM', key: 'b', label: 'B?', dependent_conditional_questions: [{ field_key: 'size', input_type: 'CUSTOM', name: 'Taglia' }] },
    ])
    expect(JSON.parse(p.context_card)).toEqual({ title: 'Ciao', style: 'PARAGRAPH_STYLE', content: ['Uno'], button_text: 'Avanti', cover_photo_id: '800000000000001' })
    expect(JSON.parse(p.custom_disclaimer)).toEqual({ title: 'Consenso', body: { text: 'Leggi i termini', url_entities: [{ offset: 8, length: 7, url: 'https://example.com/t' }] }, checkboxes: [{ text: 'Sì', key: 'consent_marketing', is_required: true, is_checked_by_default: false }] })
    expect(p).toMatchObject({ follow_up_action_url: 'https://example.com/after', question_page_custom_headline: 'Due domande', is_optimized_for_quality: 'true', is_phone_sms_verify_enabled: 'false', should_enforce_work_email: 'false', is_for_canvas: 'true', block_display_for_non_targeted_viewer: 'false', tracking_parameters: '{"ref":"spring"}' })
    expect(metaLeadFormCreateProblem(new Map(Object.entries(p)))).toBeNull()
    for (const v of Object.values(p)) if (v.startsWith('{') || v.startsWith('[')) expect(JSON.stringify(JSON.parse(v))).toBe(v)
  })
  it('refuses in words what Meta does not take or Nexus does not send', () => {
    expect(refusal({ questions: [{ type: 'SLIDER', key: 's' }] })).toMatch(/no shape for a slider/)
    expect(refusal({ questions: [{ type: 'ID_PE_DNI' }] })).toMatch(/Latin America only/)
    expect(refusal({ questions: [{ type: 'CUSTOM', label: 'A?' }] })).toMatch(/CUSTOM question names its key/)
    expect(refusal({ questions: [{ type: 'EMAIL' }, { type: 'EMAIL' }] })).toMatch(/Two questions have the key "email"/)
    expect(refusal({ questions: [{ type: 'CUSTOM', key: 'a' }] })).toMatch(/has a label/)
    expect(refusal({ questions: [{ type: 'EMAIL', options: [{ value: 'x', key: 'x' }] }] })).toMatch(/Only a CUSTOM question has options/)
    expect(refusal({ forMessenger: true, questions: [{ type: 'CITY' }] })).toMatch(/Messenger conversations asks only CUSTOM, EMAIL, FIRST_NAME, FULL_NAME, LAST_NAME, PHONE/)
    expect(refusal({ forMessenger: true, onlyTargetedPeople: true })).toMatch(/Open Sharing/)
    expect(refusal({ workEmailOnly: true })).toMatch(/add a WORK_EMAIL question/)
    expect(refusal({ smsVerification: true })).toMatch(/add a PHONE/)
    expect(refusal({ thankYouPage: { title: 'T', buttonType: 'WHATSAPP' } })).toMatch(/businessPhoneNumber/)
    expect(refusal({ consent: { text: 'Short', links: [{ offset: 2, length: 10, url: 'https://example.com' }] } })).toMatch(/within it/)
    expect(refusal({ privacyPolicy: { url: 'http://example.com' } })).toMatch(/Nexus would not send this form: privacy_policy.url is an https link/)
  })
  it('a Messenger form is Open Sharing; the Page\'s Lead Ads Terms and an unset language are said', () => {
    const m = draft({ forMessenger: true, questions: [{ type: 'FULL_NAME' }, { type: 'PHONE' }] })
    if ('refusal' in m) throw new Error(m.refusal)
    expect(m.requests[0].params.block_display_for_non_targeted_viewer).toBe('false')
    const terms = draft({}, { pageId: PAGE.pageId, termsAccepted: false })
    expect('warnings' in terms && terms.warnings.join(' ')).toMatch(/nobody accepted the Lead Ads Terms/)
    const noLocale = draft({ locale: undefined })
    expect('warnings' in noLocale && noLocale.warnings.join(' ')).toMatch(/No language set/)
  })
})

describe('archive and re-activate', () => {
  it('one POST of the form\'s status, read back; already so = skipped; a draft or deleted form refused', () => {
    const d = leadFormStatusDraft('archive', FORM)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.requests).toEqual([expect.objectContaining({ objectId: FORM.formId, objectKind: 'leadform', operation: 'leadform.status', params: { status: 'ARCHIVED' }, expect: { status: 'ARCHIVED' }, readBackFields: 'id,status', undoable: true })])
    expect(d.before).toMatchObject({ action: 'archive', status: 'ACTIVE', pageId: FORM.pageId })
    expect(d.after).toMatchObject({ action: 'archive', status: 'ARCHIVED' })
    const again = leadFormStatusDraft('archive', { ...FORM, status: 'ARCHIVED' })
    expect('requests' in again && again.requests).toEqual([])
    expect(leadFormStatusDraft('activate', { ...FORM, status: 'DRAFT' })).toEqual({ refusal: expect.stringMatching(/is a draft/) })
    expect(leadFormStatusDraft('activate', { ...FORM, status: 'DELETED' })).toEqual({ refusal: expect.stringMatching(/is deleted/) })
  })
})

describe('test leads', () => {
  const none = { metaIds: [] as string[] | null, nexusMade: [] as string[] }
  it('Nexus\'s made-up answers by question key (or the person\'s own), every consent box ticked by default; the gateway takes them', () => {
    const d = testLeadDraft({ answers: [{ question: 'email', values: ['person@example.com'] }] }, FORM, none)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.requests).toHaveLength(1)
    expect(d.requests[0]).toMatchObject({ objectId: FORM.formId, objectKind: 'leadform', edge: 'test_leads', operation: 'testlead.create', skipReadBack: true })
    expect(JSON.parse(d.requests[0].params.field_data)).toEqual([{ name: 'full_name', values: ['Test Lead'] }, { name: 'email', values: ['person@example.com'] }, { name: 'size', values: ['M'] }])
    expect(JSON.parse(d.requests[0].params.custom_disclaimer_responses)).toEqual([{ checkbox_key: 'consent_marketing', is_checked: true }])
    expect(metaTestLeadProblem(new Map(Object.entries(d.requests[0].params)))).toBeNull()
    expect(testLeadDraft({ answers: [{ question: 'nope', values: ['x'] }] }, FORM, none)).toEqual({ refusal: expect.stringMatching(/no question with the key "nope"/) })
    expect(testLeadDraft({ consent: [{ key: 'other', checked: false }] }, FORM, none)).toEqual({ refusal: expect.stringMatching(/no consent box with the key "other"/) })
  })
  it('one per form: an existing test lead refuses unless asked to replace it — and only one Nexus made is deleted first', () => {
    const ours = { metaIds: ['700000000000001'], nexusMade: ['700000000000001'] }
    expect(testLeadDraft({}, FORM, ours)).toEqual({ refusal: expect.stringMatching(/already has a test lead.*replaceTestLead: true/) })
    const replaced = testLeadDraft({ replaceTestLead: true }, FORM, ours)
    if ('refusal' in replaced) throw new Error(replaced.refusal)
    expect(replaced.requests.map((r) => [r.operation, r.objectId, r.method ?? 'POST'])).toEqual([['testlead.delete', '700000000000001', 'DELETE'], ['testlead.create', FORM.formId, 'POST']])
    expect(replaced.warnings.join(' ')).toMatch(/deleted for good first/)
    const theirs = { metaIds: ['700000000000009'], nexusMade: [] }
    expect(testLeadDraft({ replaceTestLead: true }, FORM, theirs)).toEqual({ refusal: expect.stringMatching(/Nexus did not make.*lead ads testing tool/) })
    const unreadable = { metaIds: null, metaNote: 'Meta asks for a Page token', nexusMade: ['700000000000001'] }
    expect(testLeadDraft({ replaceTestLead: true }, FORM, unreadable)).toEqual({ refusal: expect.stringMatching(/could not read the test leads/) })
    const plain = testLeadDraft({}, FORM, unreadable)
    expect('warnings' in plain && plain.warnings.join(' ')).toMatch(/could not read the form's test leads \(Meta asks for a Page token\)/)
  })
  it('deleting a test lead: only one Nexus made (never a real lead), explicit, for good; already gone = skipped', () => {
    expect(removeTestLeadDraft('700000000000099', FORM, { metaIds: ['700000000000099'], nexusMade: [] })).toEqual({ refusal: expect.stringMatching(/never a real lead/) })
    const d = removeTestLeadDraft('700000000000001', FORM, { metaIds: ['700000000000001'], nexusMade: ['700000000000001'] })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.requests).toEqual([expect.objectContaining({ objectId: '700000000000001', objectKind: 'testlead', method: 'DELETE', params: {} })])
    expect(d.after).toMatchObject({ action: 'remove-test-lead', testLeadId: null, removedTestLeadId: '700000000000001' })
    const gone = removeTestLeadDraft('700000000000001', FORM, { metaIds: [], nexusMade: ['700000000000001'] })
    expect('requests' in gone && gone.requests).toEqual([])
  })
})

describe('review round 1', () => {
  it('A4 — re-activating a form SPENDS MONEY: an ad that uses it may deliver again (Nexus cannot list those ads)', () => {
    const d = leadFormStatusDraft('activate', { ...FORM, status: 'ARCHIVED' })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.spendsMoney).toEqual([expect.stringMatching(/an ad that uses this form may deliver again/)])
    expect(d.requests[0].raisesSpend).toBe(true)
    const archive = leadFormStatusDraft('archive', FORM)
    expect('spendsMoney' in archive && archive.spendsMoney).toEqual([])
    expect('requests' in archive && archive.requests[0].raisesSpend).toBe(false)
  })
  it('A5 — a form made in Meta\'s screens may use any question key: the test lead names exactly the form\'s own keys', () => {
    const ui: LeadFormState = { ...FORM, questions: [{ key: 'favorite_color?', type: 'CUSTOM', options: [] }, { key: 'e-mail', type: 'EMAIL', options: [] }], checkboxKeys: ['Consenso marketing'] }
    const d = testLeadDraft({ answers: [{ question: 'favorite_color?', values: ['yellow'] }] }, ui, { metaIds: [], nexusMade: [] })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(JSON.parse(d.requests[0].params.field_data)).toEqual([{ name: 'favorite_color?', values: ['yellow'] }, { name: 'e-mail', values: ['test@example.com'] }])
    expect(metaTestLeadProblem(new Map(Object.entries(d.requests[0].params)))).toBeNull()
    expect(testLeadDraft({ answers: [{ question: 'favorite_colour', values: ['x'] }] }, ui, { metaIds: [], nexusMade: [] })).toEqual({ refusal: expect.stringMatching(/no question with the key "favorite_colour"/) })
  })
  it('B5 — the draft refusal says it is Nexus\'s own choice', () => {
    expect(leadFormStatusDraft('archive', { ...FORM, status: 'DRAFT' })).toEqual({ refusal: expect.stringMatching(/its own choice, not a rule Meta states/) })
  })
})
