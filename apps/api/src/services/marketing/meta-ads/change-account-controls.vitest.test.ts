/**
 * Meta step 20 — set-meta-account-controls' draft (pure): the controls go WHOLE (Meta has no update or delete), with only
 * the named parts changed and location_types left out; employers only; looser controls while a campaign delivers are
 * SPENDS MONEY; per-objective placement controls (SDK only) are never dropped; undo posts the old whole controls. Made-up
 * ids only.
 */
import { describe, expect, it } from 'vitest'
import { accountControlsDraft, controlsJudge, controlsWider, type AccountControlsAsk } from './change-account-controls.js'
import type { AccountControlsState } from './live-targeting-change.js'

const ACCOUNT = '1234567890'
const CONTROLS: AccountControlsState = {
  exists: true, status: 'ACTIVE', perObjective: null,
  audience: { age_min: 21, geo_locations: { countries: ['US', 'CA'], location_types: ['home', 'recent'] }, exclusions: { work_employers: [{ id: '108000000000001', name: 'Employer A' }] } },
  placement: { placement_exclusions: ['FACEBOOK_MARKETPLACE'] },
}
const draft = (ask: AccountControlsAsk, controls: AccountControlsState = structuredClone(CONTROLS), delivering: boolean | null = true) => accountControlsDraft(ask, { adAccountId: ACCOUNT, controls, delivering })
const ok = (d: ReturnType<typeof draft>) => { if ('refusal' in d) throw new Error(d.refusal); return d }

describe('set-meta-account-controls', () => {
  it('review B1 — placement exclusions Meta reads back in lower case are the documented enum; undocumented ones kept as Meta holds them, said', () => {
    const lower: AccountControlsState = { ...structuredClone(CONTROLS), placement: { placement_exclusions: ['facebook_rhc', 'audience_network_classic', 'FACEBOOK_BIZ_DISCO_FEED'] }, audience: { ...structuredClone(CONTROLS.audience)!, is_gender_exclusion_enabled: false } }
    const d = ok(draft({ placementExclusions: ['FACEBOOK_RIGHT_HAND_COLUMN'] }, lower))
    expect(JSON.parse(d.requests[0].params.placement_controls)).toEqual({ placement_exclusions: ['FACEBOOK_RIGHT_HAND_COLUMN', 'FACEBOOK_BIZ_DISCO_FEED'] })
    expect(JSON.parse(d.requests[0].params.audience_controls)).toMatchObject({ is_gender_exclusion_enabled: false })
    expect(d.spendsMoney[0]).toMatch(/placements no longer excluded \(Audience Network \(native, banner, interstitial\)\)/)
    expect(d.warnings.join(' ')).toMatch(/FACEBOOK_BIZ_DISCO_FEED, is_gender_exclusion_enabled false, which Meta documents nowhere: Nexus posts them back exactly/)
    // The judge reads Meta's lower-case spelling as the enum sent.
    const judge = d.requests[0].judge!
    expect(judge({ data: [{ audience_controls: JSON.parse(d.requests[0].params.audience_controls), placement_controls: { placement_exclusions: ['facebook_rhc', 'FACEBOOK_BIZ_DISCO_FEED'] } }] }).moved).toEqual([])
    // A value Meta documents nowhere and Nexus does not know: refused in honest words.
    expect(draft({ ageMin: 25 }, { ...structuredClone(CONTROLS), placement: { placement_exclusions: ['threads_feed'] } })).toEqual({ refusal: expect.stringMatching(/exclude threads_feed, a placement Meta documents nowhere/) })
    expect(draft({ restore: { audienceControls: {}, placementControls: null } })).toEqual({ refusal: expect.stringMatching(/Meta requires audience_controls/) })
  })
  it('posts the whole controls with only the named part changed (location_types left out: 1870199), on the chosen ad account', () => {
    const d = ok(draft({ ageMin: 25 }))
    expect(d.requests[0]).toMatchObject({ objectKind: 'adaccount', objectId: `act_${ACCOUNT}`, edge: 'account_controls', operation: 'adaccount.accountControls', check: 'none', raisesSpend: false, readBackOf: `act_${ACCOUNT}/account_controls` })
    expect(JSON.parse(d.requests[0].params.audience_controls)).toEqual({ age_min: 25, geo_locations: { countries: ['US', 'CA'] }, exclusions: { work_employers: [{ id: '108000000000001', name: 'Employer A' }] } })
    expect(JSON.parse(d.requests[0].params.placement_controls)).toEqual({ placement_exclusions: ['FACEBOOK_MARKETPLACE'] })
    expect(d.spendsMoney).toEqual([])
  })
  it('looser controls while a campaign delivers: SPENDS MONEY; nothing delivering: said, no SPENDS MONEY', () => {
    const looser = ok(draft({ ageMin: 18, placementExclusions: [], excludedEmployers: { remove: ['108000000000001'] } }))
    expect(looser.requests[0].raisesSpend).toBe(true)
    expect(looser.spendsMoney[0]).toMatch(/a lower minimum age \(21 → 18\); employers no longer excluded \(108000000000001\); placements no longer excluded \(Facebook Marketplace\)/)
    // Review A5 (d) — no campaign delivering: still SPENDS MONEY (they hold for every campaign switched on later), said so.
    const quiet = ok(draft({ ageMin: 18 }, structuredClone(CONTROLS), false))
    expect(quiet.spendsMoney[0]).toMatch(/nothing spends yet: no campaign of the account delivers now; it spends once one is switched on/)
    expect(controlsWider({ audience: {}, placement: null }, { audience: { geo_locations: { countries: ['US'] } }, placement: null })).toEqual([])
    expect(controlsWider({ audience: { geo_locations: { countries: ['US'] } }, placement: null }, { audience: { geo_locations: { countries: ['US', 'MX'] } }, placement: null })).toEqual(['adds countries MX'])
    // Re-review 4 — location_types other than Meta's only option, dropped: wider (people recently there come in too).
    expect(controlsWider({ audience: { geo_locations: { countries: ['US'], location_types: ['home'] } }, placement: null }, { audience: { geo_locations: { countries: ['US'] } }, placement: null }))
      .toEqual(['allowed locations\' types ["home"] → Meta\'s only option, people living in OR recently in them (1870199)'])
    expect(controlsWider({ audience: { geo_locations: { countries: ['US'], location_types: ['home', 'recent'] } }, placement: null }, { audience: { geo_locations: { countries: ['US'] } }, placement: null })).toEqual([])
    expect(controlsWider({ audience: { geo_locations: { countries: ['US'], location_types: ['home'] } }, placement: null }, { audience: { geo_locations: { countries: ['US'], location_types: ['home'] } }, placement: null })).toEqual([])
  })
  it('refused in words: nothing asked, an employer not there to remove, an under-18 minimum reaching the EU, per-objective controls held', () => {
    expect(draft({})).toEqual({ refusal: expect.stringMatching(/Say what to change/) })
    expect(draft({ excludedEmployers: { remove: ['108000000000009'] } })).toEqual({ refusal: expect.stringMatching(/exclude no employer 108000000000009/) })
    expect(draft({ ageMin: 16, locations: { add: { countries: ['DE'] } } })).toEqual({ refusal: expect.stringMatching(/under 18 in the EU, the EEA or Switzerland/) })
    expect(draft({ ageMin: 25 }, { ...structuredClone(CONTROLS), perObjective: { OUTCOME_SALES: { placement_exclusions: ['FACEBOOK_MARKETPLACE'] } } })).toEqual({ refusal: expect.stringMatching(/per-objective placement controls/) })
    expect(draft({ ageMin: 21 })).toEqual({ refusal: expect.stringMatching(/already read so/) })
  })
  it('no controls yet: undo cannot remove them (said); campaigns for Advantage+ placements are named as undocumented', () => {
    const none: AccountControlsState = { exists: false, status: null, perObjective: null, audience: null, placement: null }
    const d = ok(draft({ ageMin: 18, campaignIdsForAdvantagePlacements: ['120000000000001'] }, none))
    expect(d.requests[0].undoable).toBe(false)
    expect(JSON.parse(d.requests[0].params.placement_controls)).toEqual({ campaign_ids_to_set_ap: ['120000000000001'] })
    expect(d.warnings.join(' ')).toMatch(/no controls yet: undo cannot remove them again.*|campaign_ids_to_set_ap only by its name/)
  })
  it('a restore posts the old whole controls; the read-back judge reads Meta\'s data row past names and location_types', () => {
    const d = ok(draft({ restore: { audienceControls: { age_min: 18, geo_locations: { countries: ['US'], location_types: ['home'] } }, placementControls: null } }))
    // Review A3 — ["home"] alone is a real setting: put back as it was (Meta's only option, home AND recent, is left out).
    expect(JSON.parse(d.requests[0].params.audience_controls)).toEqual({ age_min: 18, geo_locations: { countries: ['US'], location_types: ['home'] } })
    // No placement controls before, some now: an empty exclusion list is sent (a POST without them may keep today's).
    expect(d.requests[0].params.placement_controls).toBe('{"placement_exclusions":[]}')
    const judge = controlsJudge({ age_min: 18, geo_locations: { countries: ['US'] } }, { placement_exclusions: [] })
    expect(judge({ data: [{ audience_controls: { age_min: 18, geo_locations: { countries: ['US'], location_types: ['home', 'recent'] } } }] }).moved).toEqual([])
    expect(judge({ data: [{ audience_controls: { age_min: 21 } }] }).moved).toEqual(['audience_controls'])
    expect(judge({ data: [] }).moved).toEqual(['audience_controls'])
  })
})
