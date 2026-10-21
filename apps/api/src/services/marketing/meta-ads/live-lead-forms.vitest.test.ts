/**
 * Meta step 36 review B1 — an ARCHIVED form may be left out of the chosen Page's `leadgen_forms` list: a lead-form CHANGE
 * (archive, re-activate, test leads) then confirms the form by its own `page_id` (step 14's formOnPage), still fail closed;
 * step 14's view form keeps the list check alone. Meta is a stand-in (metaReadOne). Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const PAGE = '120000000000010'
const FORM = '600000000000001'
const h = vi.hoisted(() => ({ reads: [] as Array<{ path: string; fields: string }>, answer: (() => ({})) as (path: string, fields: string) => unknown }))
vi.mock('./read-client.js', () => ({
  metaReadOne: vi.fn(async (_t: unknown, input: { path: string; query?: Record<string, unknown> }) => {
    const fields = String(input.query?.fields ?? '')
    h.reads.push({ path: input.path, fields })
    const body = h.answer(input.path, fields)
    if (body instanceof Error) throw body
    return { body, calls: 1 }
  }),
  metaReadAll: vi.fn(),
}))
vi.mock('./live.js', async (importActual) => ({
  ...(await importActual<typeof import('./live.js')>()),
  metaChosenAccount: vi.fn(async () => ({ connection: {}, connectionId: 'm-1', adAccountId: '1234567890', name: null, currency: 'EUR', timeZone: null, businessId: null, pageId: '120000000000010', instagramId: null })),
}))

import { liveLeadFormState } from './live-lead-forms.js'
import { liveLeadForms } from './live-engagement.js'
import { MetaReadError, localFailure } from './errors.js'

/** The Page's list answers WITHOUT the form; the form itself answers its page_id and its fields. */
const answers = (pageIdOfForm: string | Error) => (path: string, fields: string) => {
  if (path === `${PAGE}/leadgen_forms`) return { data: [{ id: '600000000000002' }] }
  if (path === FORM && fields === 'id,page_id') return pageIdOfForm instanceof Error ? pageIdOfForm : { id: FORM, page_id: pageIdOfForm }
  if (path === FORM) return { id: FORM, name: 'Form A', status: 'ARCHIVED', questions: [{ key: 'email', type: 'EMAIL' }] }
  return {}
}

beforeEach(() => { h.reads = [] })

describe('the form check of a lead-form change', () => {
  it('an archived form the list leaves out is confirmed by its own page_id, then read', async () => {
    h.answer = answers(PAGE)
    const form = await liveLeadFormState('m-1', FORM)
    expect(form).toMatchObject({ formId: FORM, pageId: PAGE, status: 'ARCHIVED', questions: [{ key: 'email', type: 'EMAIL' }] })
    expect(h.reads.map((r) => [r.path, r.fields.split(',')[0]])).toEqual([[`${PAGE}/leadgen_forms`, 'id'], [FORM, 'id'], [FORM, 'id']])
    expect(h.reads[1].fields).toBe('id,page_id')
  })
  it('still fail closed: another Page\'s form, or a form Meta will not place, is refused and never read', async () => {
    h.answer = answers('120000000000099')
    await expect(liveLeadFormState('m-1', FORM)).rejects.toThrow(/not one of the lead forms of the Facebook Page this business chose \(Meta names another Page/)
    expect(h.reads).toHaveLength(2)
    h.reads = []
    h.answer = answers(new MetaReadError({ ...localFailure('Meta refused the read: Unsupported get request.', '100'), origin: 'meta' }, 'x'))
    await expect(liveLeadFormState('m-1', FORM)).rejects.toThrow(/Meta listed neither/)
    expect(h.reads).toHaveLength(2)
  })
  it('step 14\'s view form keeps the list check alone (no fallback read)', async () => {
    h.answer = answers(PAGE)
    await expect(liveLeadForms({ connectionId: 'm-1', view: 'form', formId: FORM })).rejects.toThrow(/not one of the lead forms/)
    expect(h.reads).toHaveLength(1)
  })
})
