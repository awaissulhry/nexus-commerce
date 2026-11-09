import { describe, expect, it } from 'vitest'
import { ApiError } from '../../lib/api/errors'
import type { MeasurePage } from './api'
import { designScreen } from './fixtures'
import { draftDataOf, EMPTY_FORM, firstBlocked, formFromDraft, nextOf, refusalOf, sendHeldKey, stepProblems, walkOf, worthKeeping } from './model'
import { tapeOf } from './view/BodyFigure'

const page = (patch: Partial<MeasurePage> = {}): MeasurePage => ({ ...designScreen.cases.find((entry) => entry.id === 'review')!.model.page!, ...patch })
const filled = designScreen.cases.find((entry) => entry.id === 'review')!.model.form

describe('SCR-195 send measurements, the model', () => {
  it('walks the points zone by zone (Enter → next point)', () => {
    expect(walkOf(page(), 'en').map((point) => point.code)).toEqual(['chest', 'waist', 'shoulder_width', 'sleeve', 'wrist', 'hips', 'inside_leg', 'knee', 'riding_reach'])
    expect(nextOf('start')).toBe('basics')
    expect(nextOf('review')).toBeNull()
  })

  it('holds every field until the notice is ticked, and checks each step with the domain rules', () => {
    const unread = page({ noticeRead: null })
    expect(stepProblems('start', unread, EMPTY_FORM, 'en').map((problem) => problem.path)).toEqual(['notice'])
    expect(firstBlocked(unread, filled, 'en', 'review')).toBe('start')
    expect(stepProblems('basics', page(), EMPTY_FORM, 'en').map((problem) => problem.path)).toEqual(['body/basics/height', 'body/basics/weight', 'body/basics/age'])
    expect(stepProblems('photos', page(), { ...filled, photos: {} }, 'en').map((problem) => problem.code)).toEqual(['PHOTO_REQUIRED', 'PHOTO_REQUIRED', 'PHOTO_REQUIRED'])
    expect(stepProblems('photos', page({ photos: 'OPTIONAL' }), { ...filled, photos: {} }, 'en')).toEqual([])
    expect(stepProblems('review', page(), filled, 'en')).toEqual([])
    expect(firstBlocked(page(), { ...filled, values: { chest: '101' } }, 'en', 'review')).toBe('points')
  })

  it('keeps the draft with us and restores it to fit the page as it is now', () => {
    const data = draftDataOf('points', { ...filled, values: { ...filled.values, gone_point: '12' } })
    const restored = formFromDraft(JSON.parse(JSON.stringify(data)), page())
    expect(restored?.step).toBe('points')
    expect(restored?.form.values.gone_point).toBeUndefined()
    expect(restored?.form.photos).toEqual(filled.photos)
    expect(formFromDraft(data, page({ noticeRead: null }))?.step).toBe('start')
    expect(formFromDraft({ v: 2 }, page())).toBeNull()
    expect(worthKeeping(EMPTY_FORM)).toBe(false)
    expect(worthKeeping(filled)).toBe(true)
  })

  it('turns the API refusals into our words and the step to go back to, never its English', () => {
    expect(refusalOf(new ApiError('conflict', 409, 'conflict', '', null, [{ path: 'refusal/NOTICE_FIRST' }]))).toMatchObject({ problem: 'problem.notice', step: 'start' })
    expect(refusalOf(new ApiError('invalid', 400, 'validation_failed', '', null, [{ path: 'body/photos/BACK' }, { path: 'body/values/waist' }]))).toMatchObject({ problem: 'problem.fix', step: 'photos', issues: { 'body/photos/BACK': 'PHOTO_REQUIRED', 'body/values/waist': 'OUT_OF_LIMITS' } })
    expect(refusalOf(new ApiError('not_found', 404, 'not_found', ''))).toMatchObject({ gone: true })
    expect(refusalOf(new ApiError('unavailable', 503, 'not_ready', ''))).toMatchObject({ problem: 'problem.unavailable', keepKey: true })
  })

  it('holds Send with its reason: no notice, not read, busy, a photo on its way', () => {
    expect(sendHeldKey({ page: page({ notice: null }), send: 'idle', tiles: {} })).toBe('held.noNotice')
    expect(sendHeldKey({ page: page({ noticeRead: null }), send: 'idle', tiles: {} })).toBe('held.notice')
    expect(sendHeldKey({ page: page(), send: 'idle', tiles: { SIDE: { state: 'uploading', src: null } } })).toBe('held.photos')
    expect(sendHeldKey({ page: page(), send: 'idle', tiles: {} })).toBeNull()
  })

  it('draws the tape for known points and the zone for the others', () => {
    expect(tapeOf('Inside-Leg')).toMatchObject({ kind: 'line' })
    expect(tapeOf('riding_knee')).toMatchObject({ kind: 'loop' })
    expect(tapeOf('collar_x')).toBeNull()
  })

  it('has a design case for every state the plan names', () => {
    const ids = designScreen.cases.map((entry) => entry.id)
    for (const state of ['start', 'no-notice', 'points-hint', 'guide', 'photo-dialog', 'review', 'done', 'loading', 'error', 'gone', 'refused-fields', 'draft-restored']) expect(ids).toContain(state)
  })
})
