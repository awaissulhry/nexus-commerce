/**
 * Meta step 31 — the ids an audience change names inside its body (audience-ids.ts): the chosen Page and Instagram
 * account only, the chosen Page's forms and Instant Experiences, its or the ad account's videos (the read side's own
 * ownership rules), and recipient ad accounts never the account itself nor one another business in Nexus uses; anything
 * not confirmed is refused. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ taken: new Set<string>(), fail: null as string | null }))
vi.mock('./live.js', async (importActual) => ({
  ...(await importActual<typeof import('./live.js')>()),
  metaChosenAccount: vi.fn(async () => ({ connectionId: 'm-1', adAccountId: '1234567890', pageId: '120000000000080', instagramId: '170000000000001', businessId: '120000000000090' })),
}))
vi.mock('./live-engagement.js', async () => {
  const { MetaLiveRefusal } = await import('./live.js')
  return { ownForm: vi.fn(async (_a: unknown, id: string) => { if (id !== '120000000000081') throw new MetaLiveRefusal('That form is not one of the lead forms of the Facebook Page this business chose, so it is not read.'); return id }) }
})
vi.mock('./live-media.js', async () => {
  const { MetaLiveRefusal } = await import('./live.js')
  const { MetaReadError } = await import('./errors.js')
  const { localFailure } = await import('./errors.js')
  return {
    ownedByPage: vi.fn(async (_a: unknown, id: string) => { if (id !== '120000000000082') throw new MetaLiveRefusal('That Instant Experience is not the chosen Facebook Page\'s, so it is not read.'); return id }),
    ownVideo: vi.fn(async (_a: unknown, id: string) => {
      if (h.fail) throw new MetaReadError(localFailure(h.fail, 'X'), 'media.videoOwnerCheck')
      if (id !== '120000000000083') throw new MetaLiveRefusal('That video is not in the chosen ad account\'s library or on the chosen Facebook Page, so it is not read.')
      return id
    }),
  }
})
vi.mock('./taken.js', () => ({ takenIds: vi.fn(async (_p: string, ids: string[]) => new Set(ids.filter((id) => h.taken.has(id)))) }))

import { metaAudienceIdProblem } from './audience-ids.js'

beforeEach(() => { h.taken.clear(); h.fail = null })

describe('metaAudienceIdProblem', () => {
  it('the chosen Page and Instagram account only', async () => {
    expect(await metaAudienceIdProblem('m-1', { id: '120000000000080', kind: 'page' })).toBeNull()
    expect(await metaAudienceIdProblem('m-1', { id: '120000000000089', kind: 'page' })).toMatch(/is not the Facebook Page this business chose/)
    expect(await metaAudienceIdProblem('m-1', { id: '170000000000001', kind: 'instagram' })).toBeNull()
    expect(await metaAudienceIdProblem('m-1', { id: '170000000000002', kind: 'instagram' })).toMatch(/is not the Instagram account this business chose/)
  })
  it('forms, Instant Experiences and videos by the read side\'s own rules; a read that fails refuses', async () => {
    expect(await metaAudienceIdProblem('m-1', { id: '120000000000081', kind: 'leadform' })).toBeNull()
    expect(await metaAudienceIdProblem('m-1', { id: '120000000000084', kind: 'leadform' })).toMatch(/not one of the lead forms/)
    expect(await metaAudienceIdProblem('m-1', { id: '120000000000082', kind: 'canvas' })).toBeNull()
    expect(await metaAudienceIdProblem('m-1', { id: '120000000000085', kind: 'canvas' })).toMatch(/not the chosen Facebook Page's/)
    expect(await metaAudienceIdProblem('m-1', { id: '120000000000083', kind: 'video' })).toBeNull()
    h.fail = 'Meta did not answer'
    expect(await metaAudienceIdProblem('m-1', { id: '120000000000083', kind: 'video' })).toMatch(/could not confirm video/)
  })
  it('a recipient ad account: never the account itself, never one another business in Nexus uses', async () => {
    expect(await metaAudienceIdProblem('m-1', { id: '1234567891', kind: 'adaccount' })).toBeNull()
    expect(await metaAudienceIdProblem('m-1', { id: '1234567890', kind: 'adaccount' })).toMatch(/its own ad account/)
    h.taken.add('1234567891')
    expect(await metaAudienceIdProblem('m-1', { id: '1234567891', kind: 'adaccount' })).toMatch(/another business in Nexus uses/)
    expect(await metaAudienceIdProblem('m-1', { id: 'act_1', kind: 'adaccount' })).toMatch(/not a Meta id/)
  })
})
