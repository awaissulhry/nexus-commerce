/**
 * Meta on the gateway (step 1): READ ONLY by construction — a GET to the pinned Graph version only, never a method
 * override, a batch, a token revoke or a sign-in call but the token renewal; every call signed with a fresh
 * appsecret_proof the token service makes (the secret never reaches the caller); the token on the URL that is sent,
 * never on the URL the ledger, the trace or the answer carry; Meta's usage headers hold the bucket; Graph error codes
 * classified. Every refusal has its ledger row and sends nothing.
 */
import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response>, proofs: [] as string[], forgotten: [] as string[] }))
vi.mock('./account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../cx/token.service.js', () => ({
  getAccessToken: vi.fn(async () => 'meta-system-user-token'),
  metaAppAccessToken: vi.fn(async () => '1234567|app-secret-for-tests'),
  metaAppIdOf: vi.fn(async () => '1234567'),
  metaRenewalToken: vi.fn(async () => 'stored-meta-token'),
  metaRequestProof: vi.fn(async (_connectionId: string, token: string) => {
    h.proofs.push(token)
    return { appsecret_proof: `proof-of-${token.length}`, appsecret_time: '1760000000' }
  }),
}))
vi.mock('../cx/deprecation-watch.service.js', () => ({ watchForDeprecation: vi.fn(async () => undefined) }))
vi.mock('../cx/connectors/meta/token-check.js', () => ({ forgetMetaTokenCheck: vi.fn(async (id: string) => { h.forgotten.push(id) }) }))

import { gatewayLedger } from '../../test-support/gateway-stubs.js'
import { __rateTest, bucketKey, defaultsFor, META_BUCKETS, META_FULL_BUCKETS, observeRate, takeToken } from './rate.js'
import { gatewayCall, GatewayRefusal } from './gateway.js'
import { metaCall, metaRestCall, metaRestUrl, metaUrl } from './meta.js'
import { metaAppSecretProof, metaCallGroup, metaCallVerdict, metaReadOnlyProblem, metaRenewalOf, metaSendUrl, metaWriteVerdict, scrubMetaAnswer } from './meta-calls.js'
import { authHeadersOf, bucketGroupOf, publishModeOf, apiVersionOf } from './channels.js'
import { classifyChannelAnswer } from './vocabulary.js'
import { ledgerSafeBody } from './redact.js'
import { metaRateReading, metaUsageOf } from '../cx/rate-readings.js'
import { META_DEFAULT_GRAPH_API_VERSION, metaGraphApiVersion, metaGraphBase } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const sentUrl = (i = 0) => new URL(h.calls[i].url)

beforeEach(() => {
  __rateTest.useMemory()
  h.calls = []; h.answers = []; h.proofs = []; h.forgotten = []; gatewayLedger.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ data: [] }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

describe('the pinned version', () => {
  it('is v26.0 by default, META_GRAPH_API_VERSION when written vNN.N, and the default for anything else', () => {
    expect(metaGraphApiVersion()).toBe('v26.0')
    vi.stubEnv('META_GRAPH_API_VERSION', 'v27.0')
    expect(metaGraphBase()).toBe('https://graph.facebook.com/v27.0')
    vi.stubEnv('META_GRAPH_API_VERSION', 'latest')
    expect(metaGraphApiVersion()).toBe('v26.0')
  })
  it('the ledger reads the version from the path', () => {
    expect(apiVersionOf('META', `${BASE}/me`)).toBe('v26.0')
  })
})

describe('read only by construction', () => {
  const ok = (url: string, extra: Partial<Parameters<typeof metaReadOnlyProblem>[0]> = {}) => metaReadOnlyProblem({ method: 'GET', url, kind: 'read', ...extra })
  it('lets a plain GET of the pinned version through', () => {
    expect(ok(`${BASE}/act_1234567890/campaigns?fields=id,name&limit=200`)).toBeNull()
    expect(ok(`${BASE}/debug_token?input_token=x`)).toBeNull()
  })
  it('refuses every other method, kind, body, host and version', () => {
    expect(metaReadOnlyProblem({ method: 'POST', url: `${BASE}/act_1234567890/campaigns`, kind: 'read' })).toMatch(/POST/)
    expect(metaReadOnlyProblem({ method: 'DELETE', url: `${BASE}/120000000000001`, kind: 'read' })).toMatch(/DELETE/)
    expect(ok(`${BASE}/me`, { kind: 'write' })).toMatch(/not declared a read/)
    expect(ok(`${BASE}/me`, { body: '{"name":"x"}' })).toMatch(/no body/)
    expect(ok('https://graph-video.facebook.com/v26.0/act_1234567890/advideos')).toMatch(/graph\.facebook\.com/)
    expect(ok('http://graph.facebook.com/v26.0/me')).toMatch(/graph\.facebook\.com/)
    expect(ok('https://graph.facebook.com/v25.0/me')).toMatch(/v26\.0/)
    expect(ok('https://graph.facebook.com/me')).toMatch(/no version/)
  })
  it('refuses a GET that is not a read: method override, batch, the Graph root, a token revoke', () => {
    expect(ok(`${BASE}/120000000000001?method=delete`)).toMatch(/"method"/)
    expect(ok(`${BASE}/120000000000001?_method=post`)).toMatch(/"_method"/)
    expect(ok(`${BASE}/?ids=1,2`)).toMatch(/Graph root|empty segment/)
    expect(ok(`${BASE}?ids=1,2`)).toMatch(/Graph root/)
    expect(ok(`${BASE}/me?batch=[]`)).toMatch(/"batch"/)
    expect(ok(`${BASE}/oauth/revoke?revoke_token=x`, { auth: 'none' })).toMatch(/revoke/)
  })
  it('refuses a token the caller put on the URL: access_token and the proof are the gateway\'s', () => {
    expect(ok(`${BASE}/me?access_token=x`)).toMatch(/only the gateway sets/)
    expect(ok(`${BASE}/me?appsecret_proof=x`)).toMatch(/only the gateway sets/)
  })
  it('the only sign-in call is the system-user token renewal, exactly Meta\'s five keys once each, with no account token', () => {
    const renew = `${BASE}/oauth/access_token?grant_type=fb_exchange_token&client_id=1&client_secret=s&set_token_expires_in_60_days=true`
    expect(ok(renew, { auth: 'none' })).toBeNull()
    // Review 3: the token exchanged is the gateway's to fill, never the caller's.
    expect(ok(`${renew}&fb_exchange_token=t`, { auth: 'none' })).toMatch(/names no fb_exchange_token/)
    expect(ok(renew, { auth: 'account' })).toMatch(/token renewal/)
    expect(ok(`${BASE}/oauth/access_token?grant_type=client_credentials`, { auth: 'none' })).toMatch(/token renewal/)
    expect(ok(`${renew}&client_id=2`, { auth: 'none' })).toMatch(/"client_id" more than once/)
    expect(ok(`${renew}&redirect_uri=x`, { auth: 'none' })).toMatch(/token renewal/)
    expect(ok(renew.replace('&set_token_expires_in_60_days=true', ''), { auth: 'none' })).toMatch(/token renewal/)
    expect(ok(renew.replace('grant_type=fb_exchange_token', 'grant_type=client_credentials'), { auth: 'none' })).toMatch(/token renewal/)
  })
  it('a read never brings a token back: access_token in fields (also nested), Pages without fields, a bare node without fields', () => {
    expect(ok(`${BASE}/me/accounts?fields=id,access_token`)).toMatch(/never asks Meta for a token/)
    expect(ok(`${BASE}/me?fields=accounts{id,access_token}`)).toMatch(/never asks Meta for a token/)
    expect(ok(`${BASE}/me?fields=accounts{id, access_token }`)).toMatch(/never asks Meta for a token/)
    expect(ok(`${BASE}/me/accounts`)).toMatch(/Pages \(accounts\) names its fields/)
    expect(ok(`${BASE}/120000000000010`)).toMatch(/names its fields/)
    expect(ok(`${BASE}/120000000000010?fields=id,name`)).toBeNull()
    expect(ok(`${BASE}/me/accounts?fields=id,name`)).toBeNull()
    expect(ok(`${BASE}/me?fields=accounts{id,name}`)).toBeNull()
    expect(ok(`${BASE}/me?fields=accounts.limit(100){id,name}`)).toBeNull()
    // Review 2: any field name that holds "token" is refused (page_access_token, access_token_…).
    expect(ok(`${BASE}/me?fields=id,access_token_expires`)).toMatch(/never asks Meta for a token/)
    expect(ok(`${BASE}/120000000000010?fields=id,page_access_token`)).toMatch(/never asks Meta for a token/)
  })
  // Review 2 (2026-10-20) — the reviewer's probe (scratchpad probe.mts): every case was ALLOWED by the first parse.
  it.each([
    ['me?fields=accounts', /accounts field names its own fields/],
    ['me?fields=accounts.limit(100)', /accounts field names its own fields/],
    ['me/accounts?fields=accounts.fields(access_token)', /never asks Meta for a token/],
    ['me?fields=' + encodeURIComponent('["id","access_token"]'), /never asks Meta for a token/],
    ['me/accounts?fields=%20', /fields names no field/],
    ['me/accounts?fields=,', /fields names no field/],
    ['me/accounts?fields=id&fields=', /"fields" more than once/],
    ['me/%61ccounts', /never percent-encoded/],
    ['me/accounts?FIELDS=access_token', /not one Meta reads/],
    ['me/accounts?fields=' + encodeURIComponent('access%5Ftoken'), /percent-encoded twice/],
    ['me/./accounts', /no \. or \.\. segment/],
    ['me/x/../accounts', /no \. or \.\. segment/],
    ['me//accounts?fields=id', /no empty segment/],
  ])('refuses %s', (path, why) => {
    expect(ok(`${BASE}/${path}`)).toMatch(why)
  })
  // Review 3 — the reviewer's second probe (scratchpad probe2.mts): what still passed is refused now.
  it.each([
    ['me?fields=accounts{}', /every \{…\} in fields names a field/],
    ['me?fields=accounts{,}', /every \{…\} in fields names a field/],
    ['me?fields=accounts{%20}', /every \{…\} in fields names a field/],
    ['me?fields=accounts.limit(5){}', /every \{…\} in fields names a field/],
    ['me?fields=businesses{id,picture{}}', /every \{…\} in fields names a field/],
    ['me?fields=businesses{owned_pages{id}}', /never expands "owned_pages"/],
    ['me?fields=accounts{id', /a \{ with no \}/],
    ['me/accounts?fields=_', /fields names no field/],
    ['me?fields=id&debug=all', /"debug" is not one a Nexus read of Meta uses/],
    ['me?fields=id&metadata=1', /"metadata" is not one a Nexus read of Meta uses/],
    ['me?metadata=1', /"metadata" is not one a Nexus read of Meta uses/],
    ['me?fields=id&pretty=1', /"pretty" is not one a Nexus read of Meta uses/],
    ['me?fields=id&input_token=x', /"input_token" is not one a Nexus read of Meta uses here/],
    ['me/adaccounts?fields=id&business=1', /"business" is not one a Nexus read of Meta uses here/],
    ['me?fields=' + 'a'.repeat(4001), /at most 4000 characters/],
    ['me?fields=' + encodeURIComponent('аccounts'), /plain ASCII/],
    ['me?fields=' + encodeURIComponent('accounts\t{id}'), /plain ASCII/],
  ])('refuses %s', (path, why) => {
    expect(ok(`${BASE}/${path}`)).toMatch(why)
  })
  it('step 2 review A1 — the reviewer\'s field-expansion probe: no other portfolio\'s accounts, people or lead answers inside fields', () => {
    for (const q of [
      'act_1234567890?fields=' + encodeURIComponent('business{owned_ad_accounts{id,name,amount_spent}}'),
      'act_1234567890?fields=' + encodeURIComponent('business{client_ad_accounts{name,insights{spend}}}'),
      'act_1234567890?fields=' + encodeURIComponent('users{id,name,tasks}'),
      '120000000000010?fields=' + encodeURIComponent('leadgen_forms{leads{field_data}}'),
    ]) expect(ok(`${BASE}/${q}`), q).toMatch(/never expands/)
    // What Nexus's own reads ask still goes: the account's portfolio by id and name.
    expect(ok(`${BASE}/act_1234567890?fields=account_id,name,business{id,name}`)).toBeNull()
  })
  it('step 2 review 2 — .fields(…) is a list exactly like {…}; inside any expansion no Instagram account, owner, ratings, feed or blocked list', () => {
    const f = (fields: string) => ok(`${BASE}/act_1234567890?fields=${encodeURIComponent(fields)}`)
    expect(f('insights.fields()')).toMatch(/every \.fields\(…\) in fields names a field/)
    expect(f('insights.fields(,)')).toMatch(/every \.fields\(…\) in fields names a field/)
    expect(f('insights.fields(spend')).toMatch(/\( with no \)/)
    expect(f('promote_pages.fields(owned_pages.fields(id))')).toMatch(/never expands "owned_pages"/)
    for (const nested of ['instagram_business_account', 'owner_business', 'ratings', 'feed', 'blocked']) {
      expect(f(`promote_pages.fields(id,${nested}.fields(id))`), nested).toMatch(new RegExp(`never expands "${nested}" inside another field`))
      expect(f(`promote_pages{id,${nested}{id}}`), nested).toMatch(new RegExp(`never expands "${nested}" inside another field`))
    }
    // The reviewer's probe2 at the gateway: the nested Instagram account of a promoted Page.
    expect(f('promote_pages.fields(id,name,instagram_business_account.fields(username,followers_count))')).toMatch(/never expands "instagram_business_account"/)
    // Nexus's own reads still go: a Page list's own Instagram account at the top level (discovery), the account's
    // insights with a preset and a nested list in either form.
    expect(ok(`${BASE}/me/accounts?fields=id,name,instagram_business_account{id,username}`)).toBeNull()
    expect(f('insights.date_preset(last_7d){spend}')).toBeNull()
    expect(f('insights.fields(spend).date_preset(last_7d)')).toBeNull()
  })
  it('step 2 — the daily read and the live views add only their own keys, each where it is used', () => {
    expect(ok(`${BASE}/act_1234567890/campaigns?fields=id&effective_status=["ACTIVE"]&limit=200`)).toBeNull()
    // Review B5 — a campaign's or ad set's own edge, not `filtering` on act_<id>/adsets | ads (undocumented on v26).
    expect(ok(`${BASE}/120000000000101/adsets?fields=id&effective_status=["ACTIVE"]`)).toBeNull()
    expect(ok(`${BASE}/120000000000201/ads?fields=id&effective_status=["ACTIVE"]`)).toBeNull()
    expect(ok(`${BASE}/act_1234567890/ads?fields=id&filtering=[]`)).toMatch(/"filtering" is not one/)
    // AA-002 — the portfolio's own and client ad accounts take search_query; the pending lists do not.
    expect(ok(`${BASE}/9876543210/owned_ad_accounts?fields=account_id&search_query=shop`)).toBeNull()
    expect(ok(`${BASE}/9876543210/client_ad_accounts?fields=account_id&search_query=shop`)).toBeNull()
    expect(ok(`${BASE}/9876543210/pending_client_ad_accounts?fields=id&search_query=shop`)).toMatch(/"search_query" is not one/)
    expect(ok(`${BASE}/act_1234567890/insights?level=adset&time_increment=1&time_range={"since":"2026-10-01","until":"2026-10-19"}&fields=spend&limit=500`)).toBeNull()
    expect(ok(`${BASE}/120000000000101/insights?time_range={"since":"2026-10-01","until":"2026-10-19"}&fields=spend`)).toBeNull()
    // Review B6 — Meta's enums: status ERROR | EXECUTING | FINISHED | INITIALIZED, type ASYNC_ADGROUP_CREATION | BATCH_API | DRAFTS.
    expect(ok(`${BASE}/act_1234567890/async_requests?status=FINISHED&type=ASYNC_ADGROUP_CREATION`)).toBeNull()
    // Meta ignores both since 2025-06-10 (facts F2 T1): never sent, so never allowed.
    expect(ok(`${BASE}/act_1234567890/insights?fields=spend&use_unified_attribution_setting=true`)).toMatch(/"use_unified_attribution_setting" is not one/)
    expect(ok(`${BASE}/act_1234567890/insights?fields=spend&action_report_time=mixed`)).toMatch(/"action_report_time" is not one/)
    // Each key only where it is used.
    expect(ok(`${BASE}/me/adaccounts?fields=id&effective_status=["ACTIVE"]`)).toMatch(/"effective_status" is not one/)
    expect(ok(`${BASE}/act_1234567890/campaigns?fields=id&level=ad`)).toMatch(/"level" is not one/)
  })
  it('step 9 — targeting search and checks add only their own keys, each on its own path; /search reads targeting options only', () => {
    // Graph's targeting search (not an account path): its keys, and only a targeting `type`.
    expect(ok(`${BASE}/search?type=adgeolocation&q=rom&location_types=["city"]&country_code=IT&limit=25`)).toBeNull()
    expect(ok(`${BASE}/search?type=adgeolocationmeta&countries=["IT"]&regions=[1]&cities=[2]&zips=["IT:20121"]&country_groups=["eea"]`)).toBeNull()
    expect(ok(`${BASE}/search?type=adradiussuggestion&latitude=45.4&longitude=9.1&distance_unit=kilometer`)).toBeNull()
    expect(ok(`${BASE}/search?type=adTargetingCategory&class=behaviors`)).toBeNull()
    expect(ok(`${BASE}/search?type=adinterestvalid&interest_fbid_list=[6003000000001]`)).toBeNull()
    expect(ok(`${BASE}/search?type=targetingoptionstatus&targeting_option_list=[6003000000001]`)).toBeNull()
    for (const type of ['user', 'page', 'place', 'adcountry', 'adzipcode', 'ADGEOLOCATION', '']) {
      expect(ok(`${BASE}/search?type=${type}&q=x`), type).toMatch(/targeting options only/)
    }
    expect(ok(`${BASE}/search?q=x`)).toMatch(/targeting options only/)
    expect(ok(`${BASE}/search?type=adgeolocation&q=x&list=GLOBAL`)).toMatch(/"list" is not one/)
    expect(ok(`${BASE}/search?type=adinterest&q=x&fields=id,name`)).toBeNull()
    // The chosen account's edges and estimates.
    expect(ok(`${BASE}/act_1234567890/targetingsearch?q=moto&limit_type=interests&locale=it_IT&objective=OUTCOME_SALES&regulated_categories=["NONE"]&allow_only_fat_head_interests=true&limit=25`)).toBeNull()
    expect(ok(`${BASE}/act_1234567890/targetingsuggestions?targeting_list=[{"type":"interests","id":1}]&limit=45`)).toBeNull()
    expect(ok(`${BASE}/act_1234567890/targetingbrowse?limit_type=interests&regulated_categories=["NONE"]`)).toBeNull()
    expect(ok(`${BASE}/act_1234567890/targetingbrowse?include_nodes=true`)).toMatch(/"include_nodes" is not one/)
    expect(ok(`${BASE}/act_1234567890/targetingvalidation?targeting_list=[{"type":"interests","id":1}]&is_exclusion=true&locale=it_IT`)).toBeNull()
    expect(ok(`${BASE}/act_1234567890/broadtargetingcategories?custom_categories_only=true&fields=id,name`)).toBeNull()
    expect(ok(`${BASE}/act_1234567890/deprecatedtargetingadsets?type=delivery_paused&fields=id,name`)).toBeNull()
    expect(ok(`${BASE}/act_1234567890/reachestimate?targeting_spec={"geo_locations":{"countries":["IT"]}}`)).toBeNull()
    expect(ok(`${BASE}/act_1234567890/reachestimate?targeting_spec={}&object_store_url=x`)).toMatch(/"object_store_url" is not one/)
    expect(ok(`${BASE}/act_1234567890/delivery_estimate?optimization_goal=REACH&targeting_spec={}&promoted_object={}&fields=estimate_ready`)).toBeNull()
    expect(ok(`${BASE}/120000000000201/delivery_estimate?targeting_spec={}&fields=estimate_ready`)).toBeNull()
    expect(ok(`${BASE}/act_1234567890/message_delivery_estimate?targeting_spec={}&promoted_object={}&bid_amount=100&lifetime_budget=1000&lifetime_in_days=7&pacing_type=STANDARD`)).toBeNull()
    // Review fix B1 — both estimates also take a daily budget and a direct send (SDK adaccount.py, adset.py); nothing else.
    expect(ok(`${BASE}/act_1234567890/message_delivery_estimate?targeting_spec={}&daily_budget=100&is_direct_send_campaign=true`)).toBeNull()
    expect(ok(`${BASE}/120000000000201/message_delivery_estimate?daily_budget=100&is_direct_send_campaign=true`)).toBeNull()
    expect(ok(`${BASE}/120000000000201/message_delivery_estimate?daily_budget=100&lifetime_days=7`)).toMatch(/"lifetime_days" is not one/)
    expect(ok(`${BASE}/act_1234567890?fields=marketing_messages_settings{whatsapp_activation_status}`)).toBeNull()
    expect(ok(`${BASE}/act_1234567890/targetingsentencelines?targeting_spec={}&hide_targeting_spec_from_return=true`)).toBeNull()
    expect(ok(`${BASE}/120000000000301/targetingsentencelines?targeting_spec={}`)).toMatch(/"targeting_spec" is not one/)
    // Review fix A1 — the audience keys go only on the audience-eligibility read itself (its exact field list).
    expect(ok(`${BASE}/120000000000401?fields=id,name,is_eligible_for_sac_campaigns&ad_account_id=1234567890&special_ad_categories=HOUSING&special_ad_category_countries=IT`)).toBeNull()
    expect(ok(`${BASE}/120000000000401?fields=id&ad_account_id=1`)).toMatch(/"ad_account_id" is not one/)
    expect(ok(`${BASE}/120000000000401?fields=id,name,status&special_ad_categories=HOUSING`)).toMatch(/"special_ad_categories" is not one/)
    expect(ok(`${BASE}/120000000000401?fields=id,name,is_eligible_for_sac_campaigns,account_id&ad_account_id=1`)).toMatch(/"ad_account_id" is not one/)
    expect(ok(`${BASE}/120000000000401?ad_account_id=1`)).toMatch(/"ad_account_id" is not one/)
    // Each key only where it is used.
    expect(ok(`${BASE}/act_1234567890/campaigns?fields=id&targeting_spec={}`)).toMatch(/"targeting_spec" is not one/)
    expect(ok(`${BASE}/act_1234567890/insights?fields=spend&q=x`)).toMatch(/"q" is not one/)
    expect(ok(`${BASE}/act_1234567890?fields=id&special_ad_categories=HOUSING`)).toMatch(/"special_ad_categories" is not one/)
    expect(ok(`${BASE}/120000000000401/insights?fields=spend&ad_account_id=1`)).toMatch(/"ad_account_id" is not one/)
    expect(ok(`${BASE}/act_1234567890/adsets?fields=id&type=x`)).toMatch(/"type" is not one/)
  })
  // Step 6 — each new key on its own route (allowed there), and refused on a neighbour that does not use it.
  it.each([
    ['act_1234567890/campaigns?fields=id&is_completed=true', 'act_1234567890/ads?fields=id&is_completed=true', 'is_completed'],
    ['120000000000101/adsets?fields=id&is_completed=false', '120000000000101/adcreatives?fields=id&is_completed=false', 'is_completed'],
    ['act_1234567890/ads?fields=id&updated_since=1760000000', 'act_1234567890/campaigns?fields=id&updated_since=1760000000', 'updated_since'],
    ['120000000000201/ads?fields=id&updated_since=1760000000', '120000000000201/copies?fields=id&updated_since=1760000000', 'updated_since'],
    ['120000000000101/copies?fields=id&effective_status=["PAUSED"]&is_completed=true', '120000000000101/ad_studies?fields=id&effective_status=["PAUSED"]', 'effective_status'],
    ['120000000000301?fields=id,ad_review_feedback&review_feedback_breakdown=true', '120000000000301/ads?fields=id&review_feedback_breakdown=true', 'review_feedback_breakdown'],
    ['120000000000401?fields=id,thumbnail_url&thumbnail_width=300&thumbnail_height=300', 'act_1234567890/adcreatives?fields=id&thumbnail_width=300', 'thumbnail_width'],
    ['120000000000401?fields=id,name,thumbnail_url&thumbnail_height=300', '120000000000401?fields=id,creative{thumbnail_url}&thumbnail_height=300', 'thumbnail_height'],
    ['120000000000301?fields=ad_review_feedback&review_feedback_breakdown=true', '120000000000301?fields=id,name&review_feedback_breakdown=true', 'review_feedback_breakdown'],
    ['120000000000101/adrules_governed?fields=id,name&pass_evaluation=true', '120000000000101/ad_studies?fields=id&pass_evaluation=true', 'pass_evaluation'],
    ['120000000000101/budget_schedules?fields=id&time_start=1760000000&time_stop=1770000000', '120000000000101/copies?fields=id&time_start=1760000000', 'time_start'],
    ['120000000000201/asyncadrequests?fields=id&statuses=["ERROR"]', 'act_1234567890/asyncadcreatives?fields=id&statuses=["ERROR"]', 'statuses'],
    ['act_1234567890/asyncadcreatives?fields=id&is_completed=true', 'act_1234567890/adlabels?fields=id&is_completed=true', 'is_completed'],
    ['120000000000201/delivery_stats?groups=["LEARNING_STAGE_EXIT"]&bid_recommendation_type=LOWEST_COST_TO_COST_CAP', '120000000000201/targeting_insights?groups=["LEARNING_STAGE_EXIT"]', 'groups'],
    ['120000000000201/insights?fields=spend&breakdowns=["body_asset"]&time_range={"since":"2026-10-01","until":"2026-10-19"}', 'act_1234567890/insights?fields=spend&breakdowns=["body_asset"]', 'breakdowns'],
    ['act_1234567890/adsbylabels?fields=id&ad_label_ids=["120000000000601"]&operator=ANY', '120000000000601/ads?fields=id&ad_label_ids=["120000000000601"]', 'ad_label_ids'],
    ['act_1234567890/value_rule_set?fields=id,name&product_type=AUDIENCE&status=ACTIVE', 'act_1234567890/campaigns?fields=id&product_type=AUDIENCE', 'product_type'],
    ['act_1234567890/recommendations?fields=title&filtering=[{"field":"object_id","operator":"EQUAL","value":"120000000000101"}]', 'act_1234567890/adsets?fields=id&filtering=[]', 'filtering'],
    ['act_1234567890/suggested_ads?fields=id&use_case=AUTOMATED_SHOPPING_ADS&countries=["IT"]&promoted_object_page_id=120000000000010', 'act_1234567890/suggested_ads?fields=id&pixel_id=120000000000020', 'pixel_id'],
    ['act_1234567890/smart_suggested_ads?objective=OUTCOME_SALES&destination_type=WEBSITE', 'act_1234567890/smart_suggested_ads?product_set_id=120000000000030', 'product_set_id'],
    ['search?type=adlocale&q=Italian', 'act_1234567890/campaigns?fields=id&q=Italian', 'q'],
    ['120000000000700/categories?categorization_criteria=BRAND&fields=name', '120000000000700/products?categorization_criteria=BRAND&fields=name', 'categorization_criteria'],
    ['act_1234567890/ads_volume?fields=actor_id,ads_running_or_in_review_count&show_breakdown_by_actor=true', 'act_1234567890/adsets?fields=id&show_breakdown_by_actor=true', 'show_breakdown_by_actor'],
  ])('step 6 — %s is allowed; %s is refused (%s only where it is used)', (allowed, refused, key) => {
    expect(ok(`${BASE}/${allowed}`)).toBeNull()
    expect(ok(`${BASE}/${refused}`)).toMatch(new RegExp(`"${key}" is not one`))
  })
  it('review 3 — query keys are an allow-list: the keys step 1 reads, each only where it is used', () => {
    expect(ok(`${BASE}/me/adaccounts?fields=account_id,name,business{id,name}&limit=100&summary=total_count&after=c1`)).toBeNull()
    expect(ok(`${BASE}/me/adaccounts?fields=id&before=c0`)).toBeNull()
    expect(ok(`${BASE}/me?fields=accounts{id,name}.limit(5)`)).toBeNull()
    expect(ok(`${BASE}/debug_token?input_token=x`)).toBeNull()
    expect(ok(`${BASE}/1234567/authorized_adaccounts?business=9876543210&fields=account_id,name&limit=100`)).toBeNull()
  })
  it('review 2 — the renewal is recognised on the same parse: an odd path is refused and is never a renewal', () => {
    const keys = 'grant_type=fb_exchange_token&client_id=OTHER&client_secret=s&set_token_expires_in_60_days=true'
    for (const path of [`oauth//access_token?${keys}`, `%6Fauth/access_token?${keys}`, `%6Fauth/revoke`, `oauth/%72evoke`, `OAUTH/access_token?${keys}&x=1`]) {
      expect(ok(`${BASE}/${path}`, { auth: 'none' }), path).not.toBeNull()
      expect(metaRenewalOf(`${BASE}/${path}`), path).toBeNull()
    }
    expect(metaCallVerdict({ method: 'GET', url: `${BASE}/oauth/access_token?${keys}`, kind: 'read', auth: 'none' })).toEqual({ problem: null, renewalClientId: 'OTHER' })
    expect(metaRenewalOf(`${BASE}/oauth/access_token?${keys}`)).toEqual({ clientId: 'OTHER' })
  })
  it('a caller\'s own headers never travel on a Meta call', () => {
    expect(ok(`${BASE}/me?fields=id`, { headers: { 'X-HTTP-Method-Override': 'POST' } })).toMatch(/no header/)
  })
  it('step 17 — the publish mode is live (only the write allow-list reaches it); NEXUS_META_ADS_WRITES=off is the brake', () => {
    expect(publishModeOf('META')).toBe('live')
    for (const brake of ['off', 'OFF', 'false', '0', 'no', ' No ']) {
      vi.stubEnv('NEXUS_META_ADS_WRITES', brake)
      expect(publishModeOf('META'), brake).toBe('gated')
    }
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
    expect(publishModeOf('META')).toBe('live')
  })
  it('step 10 — media, posts, Instagram media, previews and Instant Experiences: each key only on its own edge', () => {
    const q = (path: string) => ok(`${BASE}/${path}`)
    // Allowed where the read uses it.
    for (const path of [
      'act_1234567890/adimages?fields=id,hash&hashes=["0123456789abcdef0123456789abcdef"]&name=hero&minwidth=600&minheight=600',
      'act_1234567890/advideos?fields=id&title=promo&minlength=3&maxlength=60',
      'act_1234567890/video_ads?fields=id&since=2026-10-01&until=2026-10-20',
      '9876543210/images?fields=id&creative_folder_id=300000000000001', '9876543210/videos?fields=id&creative_folder_id=300000000000001',
      '9876543210/creatives?fields=id&creative_folder_id=300000000000001',
      `act_1234567890/website_creative_assets?fields=id&link_url=${encodeURIComponent('https://shop.example.com/')}`,
      `act_1234567890/website_creative_info?fields=id&link_url=${encodeURIComponent('https://shop.example.com/')}`,
      '120000000000101/video_groups?fields=id&date_range={"start":"2026-10-01","end":"2026-10-20"}',
      '120000000000010/live_videos?fields=id&broadcast_status=["VOD"]',
      '120000000000010/feed?fields=id&include_hidden=true&show_expired=true', '120000000000010/visitor_posts?fields=id&include_hidden=true',
      '120000000000010/published_posts?fields=id&show_expired=true',
      '120000000000010/ads_posts?fields=id&include_inline_create=true&exclude_dynamic_ads=true&since=2026-10-01&until=2026-10-20',
      '170000000000001/media?fields=id&since=2026-10-01&until=2026-10-20',
      '120000000000010/insights?metric=page_media_view&period=day&since=2026-10-01&until=2026-10-20&breakdown=is_from_ads',
      '170000000000001/insights?metric=reach&period=day&metric_type=total_value&timeframe=last_30_days',
      '120000000000010_500000000000001/insights?metric=post_clicks&period=lifetime&since=2026-10-01&until=2026-10-20',
      'act_1234567890/generatepreviews?ad_format=INSTAGRAM_STANDARD&creative={"object_story_id":"1_2"}&creative_feature=image_uncrop&dynamic_asset_label=french',
      '120000000000301/previews?ad_format=MOBILE_FEED_STANDARD&product_item_ids=["400000000000001"]&dynamic_customization={"language":"fr_XX","country":"FR"}',
      '120000000000010/canvases?fields=id&is_hidden=false&is_published=true',
      '120000000000010_500000000000001?fields=id,message,attachments{media_type,url,subattachments}',
    ]) expect(q(path), path).toBeNull()
    // Refused anywhere else.
    for (const [path, key] of [
      ['act_1234567890/campaigns?fields=id&hashes=["a"]', 'hashes'], ['act_1234567890/adimages?fields=id&title=x', 'title'],
      ['act_1234567890/adimages?fields=id&creative_folder_id=1', 'creative_folder_id'], ['act_1234567890/adimages?fields=id&link_url=x', 'link_url'],
      ['120000000000010/feed?fields=id&since=2026-10-01', 'since'], ['120000000000010/feed?fields=id&with=LOCATION', 'with'],
      ['act_1234567890/insights?fields=spend&metric=page_media_view', 'metric'], ['120000000000010_500000000000001/insights?level=ad', 'level'],
      ['120000000000301/previews?ad_format=MOBILE_FEED_STANDARD&creative={}', 'creative'], ['120000000000301/previews?place_page_id=1', 'place_page_id'],
      ['act_1234567890/generatepreviews?ad_format=MOBILE_FEED_STANDARD&post={}', 'post'], ['120000000000010/canvases?fields=id&is_published=true&user_ids=[1]', 'user_ids'],
      ['120000000000010/live_videos?fields=id&source=target', 'source'], ['120000000000010/ads_posts?fields=id&include_hidden=true', 'include_hidden'],
    ]) expect(q(path), path).toMatch(new RegExp(`"${key}" is not one`))
    // Round 2 (c) — the organic-insight keys only on an organic read (no field list, every metric one Nexus names); the
    // preview keys only with an ad_format of the v26 enum.
    for (const [path, key] of [
      ['120000000000101/insights?fields=spend&metric=page_media_view', 'metric'], ['120000000000101/insights?fields=spend&period=day', 'period'],
      ['120000000000101/insights?fields=spend&since=2026-10-01', 'since'], ['120000000000010/insights?metric=spend', 'metric'],
      ['120000000000010/insights?metric=page_media_view,impressions&period=day', 'metric'], ['120000000000010/insights?period=day', 'period'],
      ['120000000000010_500000000000001/insights?metric=post_clicks&fields=id', 'metric'],
      ['act_1234567890/generatepreviews?ad_format=THREADS_STREAM&creative={}', 'ad_format'], ['act_1234567890/generatepreviews?creative={}', 'creative'],
      ['120000000000301/previews?product_item_ids=["1"]', 'product_item_ids'],
    ]) expect(q(path), path).toMatch(new RegExp(`"${key}" is not one`))
    // FIELD_DENIED stays: comments (step 14), leads and messages are never asked inside fields, on posts and Instagram too.
    expect(q('120000000000010_500000000000001?fields=id,comments{message}')).toMatch(/never expands "comments"/)
    expect(q('120000000000010/feed?fields=id,comments.limit(5){message}')).toMatch(/never expands "comments"/)
    expect(q('170000000000001/media?fields=id,comments{text}')).toMatch(/never expands "comments"/)
    expect(q('120000000000010?fields=id,conversations{messages}')).toMatch(/never expands/)
  })
  it('step 14 — leads, lead forms and comments: read only through their own edges, each key only there', () => {
    const q = (path: string) => ok(`${BASE}/${path}`)
    const filter = (list: unknown) => `filtering=${encodeURIComponent(JSON.stringify(list))}`
    const since = { field: 'time_created', operator: 'GREATER_THAN_OR_EQUAL', value: 1760000000 }
    const until = { field: 'time_created', operator: 'LESS_THAN', value: 1760600000 }
    // Allowed where the read uses it.
    for (const path of [
      '120000000000010/leadgen_forms?fields=id,name,status&limit=100',
      '600000000000001?fields=id,name,status,questions',
      `600000000000001/leads?fields=id,created_time,field_data,custom_disclaimer_responses&${filter([since, until])}`,
      `120000000000301/leads?fields=id,created_time,field_data&${filter([{ field: 'time_created', operator: 'GREATER_THAN', value: 1760000000 }])}`,
      '600000000000001/leads?fields=id,field_data&limit=100',
      '600000000000001/test_leads?fields=id,field_data', '700000000000001?fields=id,ad_id,form_id',
      '120000000000010_500000000000001/comments?fields=id,message,from{id,name}&summary=true&filter=stream&order=reverse_chronological&since=1760000000',
      '500000000000001_800000000000001/comments?fields=id,message&filter=toplevel&order=chronological',
      '120000000000010_500000000000001?fields=id,reactions.type(LOVE).limit(0).summary(total_count)',
      '120000000000010_500000000000001?fields=id,reactions.limit(0).summary(total_count),shares',
      '120000000000010_500000000000001/sharedposts?fields=id,from{id,name},message',
      '120000000000010_500000000000001/dynamic_posts?fields=id,product_id', '900000000000001/comments?fields=id,message&summary=true',
      '900000000000001/likes?fields=id&summary=true&limit=1',
      '120000000000010/blocked?fields=id,name', '120000000000010/ratings?fields=rating,review_text,reviewer{id,name},open_graph_story{id}',
      '170000000000001/media?fields=id', '180000000000001/comments?fields=id,text,username,from{id,username}&limit=50',
      '180000000000001/ordered_comments?fields=id,text&limit=50', '190000000000001?fields=id,media{id}', '190000000000001/replies?fields=id,text',
      '170000000000001?fields=id,mentioned_comment.comment_id(190000000000001){id,text,timestamp,media{id,permalink}}',
      '170000000000001?fields=id,mentioned_media.media_id(180000000000002){id,caption,comments_count}',
      '170000000000001/tags?fields=id,username&posted_after=2026-10-01T00:00:00&posted_before=2026-10-20T23:59:59&media_type=IMAGE,VIDEO',
    ]) expect(q(path), path).toBeNull()
    // The leads filter is exactly Meta's time filter: no other field, operator, value or key.
    for (const list of [
      [{ field: 'form_id', operator: 'EQUAL', value: 1 }], [{ ...since, operator: 'IN' }], [{ ...since, value: '1760000000' }],
      [{ ...since, value: -1 }], [{ ...since, extra: 1 }], [], [since, until, since], { ...since },
    ]) expect(q(`600000000000001/leads?fields=id&${filter(list)}`), JSON.stringify(list)).toMatch(/"filtering" is not one/)
    expect(q('600000000000001/leads?fields=id&filtering=not-json')).toMatch(/"filtering" is not one/)
    // Each key only on its own edge.
    for (const [path, key] of [
      ['act_1234567890/campaigns?fields=id&filter=stream', 'filter'], ['120000000000010/feed?fields=id&order=chronological', 'order'],
      ['180000000000001/comments?fields=id&since=1760000000', 'since'], ['180000000000001/comments?fields=id&filter=stream', 'filter'],
      ['600000000000001/test_leads?fields=id&filtering=[]', 'filtering'], ['120000000000010/leadgen_forms?fields=id&filtering=[]', 'filtering'],
      ['120000000000010_500000000000001/comments?fields=id&live_filter=no_filter', 'live_filter'],
      ['170000000000001/media?fields=id&posted_after=2026-10-01', 'posted_after'], ['120000000000010/blocked?fields=id&user=1', 'user'],
      ['170000000000001/tags?fields=id&since=2026-10-01', 'since'], ['120000000000010_500000000000001/reactions?type=LOVE', 'type'],
    ]) expect(q(path), path).toMatch(new RegExp(`"${key}" is not one`))
    // FIELD_DENIED and NESTED_DENIED stay: leads, comments, lead forms never inside fields; ratings, feed, blocked never nested.
    for (const fields of [
      'id,leadgen_forms{id,name}', 'id,leadgen_forms.limit(5){leads{field_data}}', 'id,leads{field_data}', 'id,leads.fields(field_data)',
      'id,comments.limit(0).summary(true)', 'id,comments{message,from}', 'id,ads{leads{id}}',
    ]) expect(q(`120000000000010?fields=${encodeURIComponent(fields)}`), fields).toMatch(/never expands "(leadgen_forms|leads|comments)"/)
    expect(q(`600000000000001?fields=${encodeURIComponent('id,leads{field_data}')}`)).toMatch(/never expands "leads"/)
    expect(q(`170000000000001?fields=${encodeURIComponent('id,mentioned_media.media_id(1){comments{text}}')}`)).toMatch(/never expands "comments"/)
    for (const nested of ['ratings', 'blocked', 'feed']) {
      expect(q(`act_1234567890?fields=${encodeURIComponent(`promote_pages{id,${nested}{id}}`)}`), nested).toMatch(new RegExp(`never expands "${nested}" inside another field`))
    }
  })
  it('step 14 review A2 — each new key only with a value Nexus sends', () => {
    const q = (path: string) => ok(`${BASE}/${path}`)
    const comments = '120000000000010_500000000000001/comments?fields=id'
    const tags = '170000000000001/tags?fields=id'
    for (const path of [
      `${comments}&filter=toplevel`, `${comments}&filter=stream`, `${comments}&order=chronological`, `${comments}&order=reverse_chronological`, `${comments}&since=1760000000`,
      `${tags}&posted_after=2026-10-01T00:00:00&posted_before=2026-10-21T00:00:00`, `${tags}&media_type=IMAGE`, `${tags}&media_type=IMAGE,VIDEO,CAROUSEL_ALBUM`,
    ]) expect(q(path), path).toBeNull()
    for (const [path, key] of [
      [`${comments}&filter=all`, 'filter'], [`${comments}&filter=`, 'filter'], [`${comments}&order=newest`, 'order'], [`${comments}&order=CHRONOLOGICAL`, 'order'],
      [`${comments}&since=2026-10-01`, 'since'], [`${comments}&since=-1`, 'since'], [`${comments}&since=1760000000000000`, 'since'],
      [`${tags}&posted_after=2026-10-01`, 'posted_after'], [`${tags}&posted_after=2026-13-01T00:00:00`, 'posted_after'], [`${tags}&posted_before=2026-02-30T00:00:00`, 'posted_before'],
      [`${tags}&posted_before=2026-10-01T00:00:00Z`, 'posted_before'], [`${tags}&media_type=STORY`, 'media_type'], [`${tags}&media_type=IMAGE,IMAGE`, 'media_type'],
      [`${tags}&media_type=`, 'media_type'], [`${tags}&media_type=image`, 'media_type'],
    ]) expect(q(path), path).toMatch(new RegExp(`"${key}" is not one`))
  })
  it('step 14 review A3 — people\'s lists never inside fields; reactions only as a count', () => {
    const f = (fields: string) => ok(`${BASE}/120000000000010_500000000000001?fields=${encodeURIComponent(fields)}`)
    for (const name of ['test_leads', 'ordered_comments', 'sharedposts', 'replies', 'blocked', 'ratings', 'likes', 'tags']) {
      expect(f(`id,${name}`), name).toMatch(new RegExp(`never expands "${name}" inside fields`))
      expect(f(`id,${name}{id}`), name).toMatch(new RegExp(`never expands "${name}"`))
      expect(ok(`${BASE}/170000000000001/media?fields=${encodeURIComponent(`id,${name}.limit(5){id}`)}`), name).toMatch(new RegExp(`never expands "${name}"`))
    }
    // Their own edges still read (the path is not `fields`).
    for (const path of ['600000000000001/test_leads?fields=id', '180000000000001/ordered_comments?fields=id', '120000000000010/blocked?fields=id,name', '190000000000001/replies?fields=id']) {
      expect(ok(`${BASE}/${path}`), path).toBeNull()
    }
    for (const fields of ['id,reactions.limit(0).summary(total_count)', 'id,reactions.type(LOVE).limit(0).summary(total_count)', 'id,reactions.type(SAD).limit(0).summary(total_count),shares']) {
      expect(f(fields), fields).toBeNull()
    }
    for (const fields of [
      'id,reactions', 'id,reactions{id,name}', 'id,reactions.limit(100)', 'id,reactions.limit(1).summary(total_count)', 'id,reactions.summary(total_count)',
      'id,reactions.limit(0).summary(total_count){id,name}', 'id,reactions.limit(0).summary(total_count).as(r)', 'id,reactions.type(LOVE).limit(0).summary(total_count).fields(name)',
      'id,attachments{reactions{id}}', 'id,reactions.type(love).limit(0).summary(total_count)',
      // Re-review 2 — a space after the count is no delimiter.
      'id,reactions.limit(0).summary(total_count) .limit(100){id,name}', 'id,reactions.limit(0).summary(total_count) .fields(id,name)',
      'id,reactions.limit(0).summary(total_count)  .as(x)', 'id,reactions.limit(0).summary(total_count) ,shares', 'id,reactions .limit(0).summary(total_count)',
    ]) expect(f(fields), fields).toMatch(/reactions inside fields only as a count/)
    // A count closing an expansion is one too.
    expect(f('id,attachments{target{id},reactions.limit(0).summary(total_count)}')).toBeNull()
  })
  it('step 3 — the account itself, its billing and who has access: each key only on its own edge; the feature settings are the only hyphenated paths', () => {
    const q = (path: string) => ok(`${BASE}/${path}`)
    for (const path of [
      'act_1234567890/assigned_users?fields=id,name,tasks,permitted_tasks,business{id,name}&business=9876543210&summary=total_count',
      '120000000000010/assigned_users?fields=id,name,tasks&business=9876543210', '170000000000001/assigned_users?fields=id,name,tasks&business=9876543210',
      'act_1234567890/advertisable_applications?fields=id,name&business_id=9876543210',
      'act_1234567890/connected_instagram_accounts_with_iabp?fields=id,username&business_id=9876543210',
      'act_1234567890/minimum_budgets?fields=currency,min_daily_budget_imp&bid_amount=150',
      'act_1234567890/campaign_attribution_options?app_id=300000000000001&optimization_goal=APP_INSTALLS&event_name=PURCHASE',
      'act_1234567890/insights/feature-settings?insights_feature=comscore', 'act_1234567890/insights/feature-settings/list-features',
      'act_1234567890/activities?fields=event_type,extra_data&since=1760000000&until=1760086400',
      '9876543210/business_invoices?fields=id,amount_due&start_date=2026-01-01&end_date=2026-10-01&issue_start_date=2026-01-01&issue_end_date=2026-10-01&type=INV&summary=total_count',
      '9876543210/business_invoices?fields=id&invoice_id=123456', '9876543210/extendedcreditapplications?fields=id,status&only_show_pending=true',
      'act_1234567890/users?fields=id,name,tasks', 'act_1234567890/agencies?fields=id,name,access_status,permitted_tasks', '9876543210/extendedcredits?fields=id,balance',
      '100000000000001/assigned_ad_accounts?fields=account_id,name', '100000000000001/extended_credit_invoice_groups?fields=id,name',
      // Review B4, B1, A4, A2.
      'act_1234567890/activities?fields=event_type&category=BUDGET&since=1760000000&until=1760086400', '9876543210/owned_instagram_assets?fields=id,ig_user_id',
      '9876543210/client_instagram_assets?fields=id,ig_user_id', '9876543210/extendedcredits?fields=id,owner_business{id}',
      'act_1234567890?fields=agency_client_declaration{agency_representing_client,client_name,client_city}',
      '100000000000001/assigned_product_catalogs?fields=id,name,owner_business{id}',
    ]) expect(q(path), path).toBeNull()
    for (const [path, key] of [
      ['act_1234567890/campaigns?fields=id&business=9876543210', 'business'], ['act_1234567890/users?fields=id&business=9876543210', 'business'],
      ['act_1234567890/applications?fields=id&business_id=9876543210', 'business_id'], ['act_1234567890/insights?fields=spend&insights_feature=comscore', 'insights_feature'],
      ['act_1234567890/ads?fields=id&since=1760000000', 'since'], ['act_1234567890/minimum_budgets?bid_amount=150&app_id=1', 'app_id'],
      ['9876543210/owned_ad_accounts?fields=id&type=INV', 'type'], ['9876543210/extendedcredits?fields=id&only_show_pending=true', 'only_show_pending'],
      ['act_1234567890/campaign_attribution_options?app_id=1&custom_event_str=x', 'custom_event_str'], ['9876543210/business_invoices?fields=id&root_id=1', 'root_id'],
      ['act_1234567890/activities?fields=event_type&category=AD', 'category'], ['act_1234567890/activities?fields=event_type&category=account', 'category'],
      ['120000000000101/activities?fields=event_type&category=BUDGET', 'category'], ['act_1234567890/campaigns?fields=id&category=BUDGET', 'category'],
      // Review round 4 — BUDGET only (where Meta files billing events), exact case; the days only as Unix seconds.
      ['act_1234567890/activities?fields=event_type&category=ACCOUNT', 'category'], ['act_1234567890/activities?fields=event_type&category=budget', 'category'],
      ['act_1234567890/activities?fields=event_type&since=yesterday', 'since'], ['act_1234567890/activities?fields=event_type&since=-5', 'since'],
      ['act_1234567890/activities?fields=event_type&since=1760000000&until=abc', 'until'], ['act_1234567890/activities?fields=event_type&since=1760000000.5', 'since'],
      ['act_1234567890/activities?fields=event_type&until=2026-10-21', 'until'], ['act_1234567890/activities?fields=event_type&since=1234567890123', 'since'],
      ['9876543210/owned_instagram_assets?fields=id&business=9876543210', 'business'],
    ]) expect(q(path), path).toMatch(new RegExp(`"${key}" is not one`))
    // A hyphen only in the two feature-settings paths, exactly as Meta writes them.
    for (const path of [
      'act_1234567890/insights/feature-settings/other-list', 'act_1234567890/feature-settings', '120000000000101/insights/feature-settings',
      'act_1234567890/insights/feature-settings/list-features/x', 'act_1234567890/Insights/feature-settings', 'act_1234567890/insights/list-features',
      'act_1234567890/ad-images', 'act_1234567890/insights/feature_settings-',
    ]) expect(q(path), path).toMatch(/letters, digits and _ only|not one a Nexus read/)
    // FIELD_DENIED stays: people and agencies are read through their own edge, never expanded into the account.
    expect(q('act_1234567890?fields=id,users{name}')).toMatch(/never expands "users"/)
    expect(q('act_1234567890?fields=id,agencies{name}')).toMatch(/never expands "agencies"/)
    expect(q('act_1234567890?fields=id,assigned_users{name}')).toMatch(/never expands "assigned_users"/)
  })
})

describe('signing and the token', () => {
  it('appsecret_proof is HMAC-SHA256 of "<token>|<time>" keyed with the app secret, hex (Meta Login Security)', () => {
    const proof = metaAppSecretProof('token-1', 'secret-1', 1760000000)
    expect(proof).toEqual({ appsecret_proof: createHmac('sha256', 'secret-1').update('token-1|1760000000').digest('hex'), appsecret_time: '1760000000' })
  })
  it('a read goes once, with the token and its proof on the URL sent — never on the URL the ledger and the answer carry', async () => {
    const res = await metaCall({ connectionId: 'm-1', operation: 'campaigns.list', path: 'act_1234567890/campaigns', query: { fields: ['id', 'name'], limit: 100 } })
    expect(res.status).toBe(200)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].init.method).toBe('GET')
    const sent = sentUrl()
    expect(sent.searchParams.get('access_token')).toBe('meta-system-user-token')
    expect(sent.searchParams.get('appsecret_proof')).toBe('proof-of-22')
    expect(sent.searchParams.get('appsecret_time')).toBe('1760000000')
    // A list goes as JSON (metaUrl).
    expect(sent.searchParams.get('fields')).toBe('["id","name"]')
    expect(h.proofs).toEqual(['meta-system-user-token'])
    expect(res.url).not.toContain('access_token')
    expect(res.url).not.toContain('appsecret_proof')
    expect((h.calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined()
    expect(authHeadersOf('META', 't')).toEqual({})
    expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'META', connectionId: 'm-1', operation: 'campaigns.list', outcome: 'sent', success: true, apiVersion: 'v26.0', endpoint: 'graph.facebook.com/v26.0/act_1234567890/campaigns' })])
  })
  it('the app token (debug_token) is signed too; a caller-held token is signed with the secret it brings', async () => {
    await metaCall({ connectionId: 'm-1', operation: 'token.debug', path: 'debug_token', query: { input_token: 'x' }, auth: 'app' })
    expect(sentUrl().searchParams.get('access_token')).toBe('1234567|app-secret-for-tests')
    await metaCall({ connectionId: null, operation: 'identity.me', path: 'me', query: { fields: 'id' }, auth: { token: 'held-token', appSecret: 'held-secret' } })
    const proof = sentUrl(1).searchParams.get('appsecret_proof')
    const time = sentUrl(1).searchParams.get('appsecret_time')
    expect(proof).toBe(createHmac('sha256', 'held-secret').update(`held-token|${time}`).digest('hex'))
  })
  it('a caller-held token without its secret is held: nothing is sent unsigned', async () => {
    const err = await gatewayCall({ channel: 'META', operation: 'identity.me', kind: 'read', connectionId: null, appLevel: true, url: metaUrl('me'), method: 'GET', auth: { token: 'held-token' } }).catch((e) => e)
    expect(err).toBeInstanceOf(GatewayRefusal)
    expect(err).toMatchObject({ outcome: 'held', code: 'META_APP_SECRET_UNAVAILABLE' })
    expect(h.calls).toHaveLength(0)
  })
  it('the token renewal goes with no account token at all, and only for the connection\'s own app', async () => {
    const renewal = (clientId: string) => metaUrl('oauth/access_token', { grant_type: 'fb_exchange_token', client_id: clientId, client_secret: 's', set_token_expires_in_60_days: 'true' })
    await gatewayCall({ channel: 'META', operation: 'token.renew', kind: 'read', connectionId: 'm-1', url: renewal('1234567'), method: 'GET', auth: 'none' })
    expect(sentUrl().searchParams.get('access_token')).toBeNull()
    expect(sentUrl().searchParams.get('appsecret_proof')).toBeNull()
    // Review 3: the token exchanged is the connection's own stored one, filled by the gateway on the URL sent only.
    expect(sentUrl().searchParams.get('fb_exchange_token')).toBe('stored-meta-token')
    expect(JSON.stringify(gatewayLedger)).not.toContain('stored-meta-token')
    const named = await gatewayCall({ channel: 'META', operation: 'token.renew', kind: 'read', connectionId: 'm-1', url: `${renewal('1234567')}&fb_exchange_token=another-token`, method: 'GET', auth: 'none' }).catch((e) => e)
    expect(named).toMatchObject({ code: 'META_READ_ONLY', message: expect.stringMatching(/names no fb_exchange_token/) })
    const err = await gatewayCall({ channel: 'META', operation: 'token.renew', kind: 'read', connectionId: 'm-1', url: renewal('7654321'), method: 'GET', auth: 'none' }).catch((e) => e)
    expect(err).toMatchObject({ code: 'META_READ_ONLY', message: expect.stringMatching(/connection's own Meta app/) })
    expect(h.calls).toHaveLength(1)
  })
  it('review 2 — no access_token key in a Meta answer reaches the caller or the ledger; the ledger counts what was dropped', async () => {
    const answer = { data: [{ id: '120000000000010', name: 'Page', access_token: 'PAGE-TOKEN-1', nested: { list: [{ Access_Token: 'PAGE-TOKEN-2' }] } }], paging: { cursors: { after: 'c' } } }
    h.answers.push(() => new Response(JSON.stringify(answer), { status: 200 }))
    const res = await metaCall({ connectionId: 'm-1', operation: 'pages.list', path: 'me/accounts', query: { fields: 'id,name' } })
    expect(res.text).not.toMatch(/PAGE-TOKEN/)
    expect(res.json()).toEqual({ data: [{ id: '120000000000010', name: 'Page', nested: { list: [{}] } }], paging: { cursors: { after: 'c' } } })
    expect(gatewayLedger.at(-1)).toMatchObject({ success: true, responsePayload: { scrubbed: 2 } })
    expect(JSON.stringify(gatewayLedger)).not.toMatch(/PAGE-TOKEN/)
    // A failed answer is kept in the ledger scrubbed too.
    h.answers.push(() => new Response(JSON.stringify({ error: { code: 100, message: 'x' }, access_token: 'PAGE-TOKEN-3' }), { status: 400 }))
    const failed = await metaCall({ connectionId: 'm-1', operation: 'pages.list', path: 'me/accounts', query: { fields: 'id' } })
    expect(failed.text).not.toMatch(/PAGE-TOKEN/)
    expect(gatewayLedger.at(-1)).toMatchObject({ success: false, responsePayload: { scrubbed: 1 } })
    expect(JSON.stringify(gatewayLedger)).not.toMatch(/PAGE-TOKEN/)
    // Not JSON: the parameter is dropped; nothing to remove: the text is untouched.
    expect(scrubMetaAnswer('access_token=SECRET&x=1')).toEqual({ text: 'x=1', scrubbed: 1 })
    expect(scrubMetaAnswer('{"id":"1"}')).toEqual({ text: '{"id":"1"}', scrubbed: 0 })
  })
  it('review 3 — a token inside a string never travels: paging links, connection links, a message, an app token; an escaped key', () => {
    const USER = 'EAAB' + 'x1Y2z3'.repeat(6)
    const APPTOKEN = '1234567|' + 'aB3_cD4-eF5gH6iJ7kL8'
    const answer = {
      data: [{ id: '120000000000010', name: 'Page', access_token: USER }],
      paging: {
        cursors: { after: 'c2', before: 'c1' },
        next: `https://graph.facebook.com/v26.0/120000000000001/accounts?access_token=${USER}&limit=100&after=c2`,
        previous: `https://graph.facebook.com/v26.0/1234567/roles?limit=100&access_token=${encodeURIComponent(APPTOKEN)}&appsecret_proof=abc&appsecret_time=1760000000`,
      },
      metadata: { connections: { accounts: `https://graph.facebook.com/v26.0/120000000000001/accounts?access_token=${USER}` } },
      message: `see access_token=${USER} and the app token ${APPTOKEN}; client_secret=s3cr3t`,
    }
    const res = scrubMetaAnswer(JSON.stringify(answer))
    expect(res.text).not.toMatch(/EAAB|aB3_cD4|s3cr3t|appsecret_proof=|access_token/)
    const clean = JSON.parse(res.text)
    expect(clean.paging).toEqual({
      cursors: { after: 'c2', before: 'c1' },
      next: 'https://graph.facebook.com/v26.0/120000000000001/accounts?limit=100&after=c2',
      previous: 'https://graph.facebook.com/v26.0/1234567/roles?limit=100',
    })
    expect(clean.metadata.connections.accounts).toBe('https://graph.facebook.com/v26.0/120000000000001/accounts')
    expect(clean.message).toBe('see  and the app token [removed]; ')
    expect(res.scrubbed).toBe(9)
    // A JSON-escaped key is the key Meta means; a "__proto__" key stays a key and is scrubbed inside.
    const escaped = scrubMetaAnswer(`{"id":"1","access\\u005ftoken":"${USER}","__proto__":{"access_token":"${USER}"}}`)
    expect(escaped.text).not.toContain(USER)
    expect(escaped.scrubbed).toBe(2)
    expect(JSON.parse(escaped.text)).toEqual(JSON.parse('{"id":"1","__proto__":{}}'))
    // Not JSON at all: one string.
    expect(scrubMetaAnswer(`access_token=${USER}&token_type=bearer`)).toEqual({ text: 'token_type=bearer', scrubbed: 1 })
    // Step 1 final review: a token used as a KEY is masked; two such keys stay apart; a URL-encoded app token is masked.
    const keyed = scrubMetaAnswer(JSON.stringify({ [USER]: { id: '1' }, [APPTOKEN]: { id: '2' }, note: `token 1234567%7C${'aB3_cD4-eF5gH6iJ7kL8'}` }))
    expect(keyed.text).not.toMatch(/EAAB|aB3_cD4/)
    expect(JSON.parse(keyed.text)).toEqual({ '[removed]': { id: '1' }, '[removed]-2': { id: '2' }, note: 'token [removed]' })
    expect(keyed.scrubbed).toBe(3)
  })
  it('review 2 — the renewal\'s own answer keeps its access_token: it IS the new token', async () => {
    h.answers.push(() => new Response(JSON.stringify({ access_token: 'NEW-TOKEN', token_type: 'bearer', expires_in: 5183944 }), { status: 200 }))
    const url = metaUrl('oauth/access_token', { grant_type: 'fb_exchange_token', client_id: '1234567', client_secret: 's', set_token_expires_in_60_days: 'true' })
    const res = await gatewayCall({ channel: 'META', operation: 'token.renew', kind: 'read', connectionId: 'm-1', url, method: 'GET', auth: 'none' })
    expect(res.json()).toMatchObject({ access_token: 'NEW-TOKEN' })
  })
  it('metaSendUrl only adds the three parameters', () => {
    expect(metaSendUrl(`${BASE}/me?fields=id`, 't', { appsecret_proof: 'p', appsecret_time: '1' })).toBe(`${BASE}/me?fields=id&access_token=t&appsecret_proof=p&appsecret_time=1`)
  })
})

describe('refusals send nothing and have their ledger row', () => {
  it('a POST that is not on the write allow-list (step 17) is refused META_WRITE_NOT_ALLOWED, before the token or the network', async () => {
    const err = await gatewayCall({ channel: 'META', operation: 'campaigns.create', kind: 'write', connectionId: 'm-1', url: `${BASE}/act_1234567890/campaigns`, method: 'POST', body: '{"name":"Shop A"}' }).catch((e) => e)
    expect(err).toBeInstanceOf(GatewayRefusal)
    expect(err).toMatchObject({ outcome: 'refused', code: 'META_WRITE_NOT_ALLOWED', statusCode: 403 })
    expect(h.calls).toHaveLength(0)
    expect(h.proofs).toHaveLength(0)
    expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'META', outcome: 'refused', errorCode: 'META_WRITE_NOT_ALLOWED' })])
  })
  it('a GET declared a write is refused too (the declared kind and the call itself must both read)', async () => {
    const err = await gatewayCall({ channel: 'META', operation: 'x', kind: 'write', connectionId: 'm-1', url: `${BASE}/me`, method: 'GET' }).catch((e) => e)
    expect(err).toMatchObject({ code: 'META_READ_ONLY' })
    expect(h.calls).toHaveLength(0)
  })
})

describe('step 8 — recommendations, studies and rules add only their own query keys, each on its own path', () => {
  const ok = (path: string) => metaReadOnlyProblem({ method: 'GET', url: `${BASE}/${path}`, kind: 'read' })
  it('allowed where meta-recommendations, meta-experiments and meta-ad-rules read', () => {
    for (const path of [
      'act_1234567890?fields=opportunity_score',
      'act_1234567890/recommendations?recommendation_stages=["mfr"]&recommendation_names=["fragmentation"]',
      '9876543210/recommendations?ad_account_ids=1234567890&fields=recommendation_content&recommendation_stages=["mid_flight_recommendation"]&recommendation_names=["fragmentation"]&locale=it_IT',
      'act_1234567890/opportunity_score_history?from_date=2026-10-01&to_date=2026-10-19&get_reason=true',
      'act_1234567890/impacting_ad_studies?fields=id,name,type,start_time,business{id},created_by{id}&limit=100',
      '9876543210/ad_studies?fields=id,name&limit=100',
      '6100000000001/cells?fields=id,name,treatment_percentage,adaccounts.limit(100),campaigns.limit(100),adsets.limit(100),control_percentage,ad_ids&limit=100',
      '6300000000001?fields=id,name,type,is_primary,last_updated_results,results&breakdowns=["cell_id","age"]',
      '6300000000001?fields=id,results&breakdowns=["cell_id"]&ds=2026-10-20',
      '6100000000001/related_ad_accounts?fields=account_id,name', '6100000000001/viewers?fields=id',
      '120000000000101?fields=can_create_brand_lift_study,brand_lift_studies{id,name,type,start_time,end_time}',
      '120000000000201/ad_studies?fields=id,name',
      'act_1234567890/adrules_library?fields=id,account_id,name,status,evaluation_spec,execution_spec,schedule_spec,created_by{id}',
      '23850000000000001/history?fields=timestamp,results&object_id=120000000000201&action=CHANGED_BUDGET&hide_no_changes=true',
      'act_1234567890/adrules_history?fields=timestamp,results,rule_id&object_id=120000000000201&action=PAUSED&hide_no_changes=true',
      '120000000000010/ab_tests?fields=id,name&since=1790812800&until=1792454400',
    ]) expect(ok(path), path).toBeNull()
  })
  it('refused anywhere else, and the keys Nexus never sends are refused there too', () => {
    for (const [path, key] of [
      // The portfolio is asked about the chosen account only: never `scopes` (owned / shared accounts).
      ['9876543210/recommendations?scopes=["shared"]', 'scopes'], ['act_1234567890/recommendations?ad_account_ids=1', 'ad_account_ids'],
      ['act_1234567890/recommendations?locale=it_IT', 'locale'], ['act_1234567890/campaigns?fields=id&recommendation_stages=["mfr"]', 'recommendation_stages'],
      ['act_1234567890/insights?fields=spend&from_date=2026-10-01', 'from_date'], ['act_1234567890/opportunity_score_history?time_range={}', 'time_range'],
      ['act_1234567890?fields=id&breakdowns=["age"]', 'breakdowns'], ['120000000000101/ad_studies?fields=id&breakdowns=["age"]', 'breakdowns'],
      ['6100000000001/cells?fields=id&breakdowns=["cell_id"]', 'breakdowns'],
      // Review fix A2 — on a bare id only with a top-level `results` field (a study objective's results read).
      ['120000000000101?fields=id,name&breakdowns=["age"]', 'breakdowns'], ['120000000000101?fields=id,name&ds=2026-10-20', 'ds'],
      ['120000000000101?fields=id,insights{results}&breakdowns=["age"]', 'breakdowns'], ['120000000000101/insights?fields=spend&ds=2026-10-20', 'ds'],
      // Review fix S4 — `.fields(results)` is a nested list, not a top-level results field.
      ['120000000000101?fields=id,insights.fields(results)&breakdowns=["age"]', 'breakdowns'], ['120000000000101?fields=id,insights.fields(results)&ds=2026-10-20', 'ds'],
      ['act_1234567890/history?object_id=1', 'object_id'], ['120000000000201/adrules_history?action=PAUSED', 'action'],
      ['act_1234567890/adrules_library?fields=id&evaluation_type=TRIGGER', 'evaluation_type'], ['act_1234567890/adrules_history?evaluation_type=TRIGGER', 'evaluation_type'],
      ['120000000000010/feed?fields=id&until=1792454400', 'until'], ['act_1234567890/ab_tests?since=1', 'since'],
      ['act_1234567890/impacting_ad_studies?fields=id&study_status=ACTIVE', 'study_status'],
    ]) expect(ok(path), path).toMatch(new RegExp(`"${key}" is not one`))
  })
})

describe('rate limits', () => {
  it('a bucket per kind of call: insights and the sign-in apart from the rest', () => {
    expect(metaCallGroup(`${BASE}/act_1234567890/insights?level=campaign`)).toBe('insights')
    expect(metaCallGroup(`${BASE}/debug_token?input_token=x`)).toBe('auth')
    expect(metaCallGroup(`${BASE}/oauth/access_token`)).toBe('auth')
    expect(metaCallGroup(`${BASE}/act_1234567890/campaigns`)).toBe('ads')
    expect(bucketGroupOf('META', 'GET', `${BASE}/120000000000001/insights`)).toBe('insights')
    expect(defaultsFor('META', bucketKey('META', 'm-1', 'insights'))).toEqual(META_BUCKETS.insights)
    expect(defaultsFor('META', bucketKey('META', 'm-1', 'ads'))).toEqual(META_BUCKETS.ads)
  })
  it('reads the usage headers: the highest percent as headroom; back off at 75 % for the reset Meta names', () => {
    const headers = new Headers({
      'x-business-use-case-usage': JSON.stringify({ '9876543210': [{ type: 'ads_management', call_count: 20, total_cputime: 12, total_time: 30, estimated_time_to_regain_access: 0, ads_api_access_tier: 'development_access' }] }),
      'x-ad-account-usage': JSON.stringify({ acc_id_util_pct: 80, reset_time_duration: 120, ads_api_access_tier: 'development_access' }),
    })
    expect(metaRateReading(headers, 200)).toEqual({ model: 'points', remaining: 20, limit: 100, retryAfterSec: 120, tier: 'development_access' })
    expect(metaRateReading(new Headers({ 'x-app-usage': '{"call_count":5,"total_cputime":1,"total_time":2}' }), 200)).toEqual({ model: 'points', remaining: 95, limit: 100 })
    expect(metaRateReading(new Headers(), 200)).toBeNull()
  })
  it('while Meta says access is blocked, the bucket is held for that many minutes', () => {
    const headers = new Headers({ 'x-business-use-case': JSON.stringify({ '1': [{ type: 'ads_insights', call_count: 100, total_cputime: 40, total_time: 50, estimated_time_to_regain_access: 7 }] }) })
    expect(metaRateReading(headers, 400)).toMatchObject({ retryAfterSec: 420, remaining: 0 })
  })
  it('a held bucket refuses the next call RATE_LIMITED_LOCAL without sending it (Meta asks callers to stop)', async () => {
    h.answers.push(() => new Response('{"data":[]}', { status: 200, headers: { 'x-ad-account-usage': '{"acc_id_util_pct":90,"reset_time_duration":300}' } }))
    await metaCall({ connectionId: 'm-1', operation: 'campaigns.list', path: 'act_1234567890/campaigns' })
    const err = await gatewayCall({ channel: 'META', operation: 'campaigns.list', kind: 'read', connectionId: 'm-1', url: metaUrl('act_1234567890/campaigns'), method: 'GET', maxRateWaitMs: 10 }).catch((e) => e)
    expect(err).toMatchObject({ code: 'RATE_LIMITED_LOCAL' })
    expect(h.calls).toHaveLength(1)
  })
  it('a throttle answer with no usage header still holds the bucket: 300 s; never for the two per-object limits (613/4841018, 613/1487632: step 17 holds only that object)', async () => {
    h.answers.push(() => new Response(JSON.stringify({ error: { code: 17, error_subcode: 2446079, message: 'User request limit reached' } }), { status: 400 }))
    await metaCall({ connectionId: 'm-2', operation: 'campaigns.list', path: 'act_1234567890/campaigns', query: { fields: 'id' } })
    const held = await takeToken('META', bucketKey('META', 'm-2', 'ads'), 0)
    expect(held.ok).toBe(false)
    expect(held.waitMs).toBeGreaterThan(290_000)
    expect(held.waitMs).toBeLessThanOrEqual(300_000)
    h.answers.push(() => new Response(JSON.stringify({ error: { code: 613, error_subcode: 1487632 } }), { status: 400 }))
    await metaCall({ connectionId: 'm-3', operation: 'adsets.list', path: 'act_1234567890/adsets', query: { fields: 'id' } })
    expect(await takeToken('META', bucketKey('META', 'm-3', 'ads'), 0)).toMatchObject({ ok: true, waitMs: 0 })
  })
  it('the Full tier, as the headers name it, sizes the bucket up; Limited sizes it back', async () => {
    const key = bucketKey('META', 'm-4', 'ads')
    await observeRate('META', key, { tier: 'standard_access' })
    const full = await takeToken('META', key, 0)
    expect(full.tokensLeft).toBe(META_FULL_BUCKETS.ads.capacity - 1)
    expect(META_BUCKETS.ads).toEqual({ capacity: 45, refillPerSec: 0.08 })
  })
  it('a dead token answer makes the next heartbeat check the token again at once', async () => {
    h.answers.push(() => new Response(JSON.stringify({ error: { code: 190, error_subcode: 460, message: 'Password changed' } }), { status: 400 }))
    await metaCall({ connectionId: 'm-5', operation: 'campaigns.list', path: 'act_1234567890/campaigns', query: { fields: 'id' } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(h.forgotten).toEqual(['m-5'])
  })
  it('spells out the usage for a person (meta-connection view check)', () => {
    const usage = metaUsageOf(new Headers({
      'x-ad-account-usage': '{"acc_id_util_pct":9.5,"reset_time_duration":0,"ads_api_access_tier":"standard_access"}',
      'x-ad-api-version-warning': 'The call was upgraded to v26.0',
    }))
    expect(usage).toMatchObject({ adAccount: { usedPct: 9.5, resetSeconds: 0, tier: 'standard_access' }, tier: 'standard_access', versionWarning: 'The call was upgraded to v26.0', businessUseCase: [] })
  })
})

describe('Graph error codes (developers.facebook.com/docs/graph-api/guides/error-handling)', () => {
  const body = (code: number, subcode?: number, message = 'm') => JSON.stringify({ error: { message, type: 'OAuthException', code, ...(subcode ? { error_subcode: subcode } : {}), fbtrace_id: 'x' } })
  it('the token: 190/463 expired, any other 190 revoked; both need a new token', () => {
    expect(classifyChannelAnswer('META', 400, body(190, 463))).toMatchObject({ errorClass: 'auth_expired', channelCode: '190/463' })
    expect(classifyChannelAnswer('META', 400, body(190, 460))).toMatchObject({ errorClass: 'auth_revoked', channelCode: '190/460' })
    expect(classifyChannelAnswer('META', 401, body(190))).toMatchObject({ errorClass: 'auth_revoked', channelCode: '190' })
  })
  it('rate limits: 4, 17, 32, 613 and 80000–80014, whatever the HTTP status', () => {
    for (const code of [4, 17, 32, 613, 80000, 80004, 80014]) expect(classifyChannelAnswer('META', 400, body(code)).errorClass, String(code)).toBe('rate_limited')
    expect(classifyChannelAnswer('META', 400, body(613, 1487632))).toMatchObject({ errorClass: 'rate_limited', channelCode: '613/1487632', retryable: true })
  })
  it('permissions, parameters, a missing object, an old version, Meta unwell', () => {
    expect(classifyChannelAnswer('META', 403, body(10)).errorClass).toBe('forbidden')
    expect(classifyChannelAnswer('META', 400, body(200)).errorClass).toBe('forbidden')
    expect(classifyChannelAnswer('META', 400, body(100)).errorClass).toBe('validation')
    expect(classifyChannelAnswer('META', 400, body(100, 33)).errorClass).toBe('not_found')
    expect(classifyChannelAnswer('META', 400, body(2635)).errorClass).toBe('configuration')
    expect(classifyChannelAnswer('META', 500, body(2)).errorClass).toBe('transient')
    expect(classifyChannelAnswer('META', 503, 'not json').errorClass).toBe('transient')
  })
  it('a person reads Meta\'s own title and message first, with the trace id Meta support asks for and the field it blames', () => {
    const text = JSON.stringify({ error: { message: 'Invalid parameter', code: 100, error_user_title: 'Budget too low', error_user_msg: 'The budget is too low.', fbtrace_id: 'Abc123', error_data: { blame_field_specs: [['daily_budget']] } } })
    expect(classifyChannelAnswer('META', 400, text)).toMatchObject({ errorClass: 'validation', channelMessage: 'Budget too low: The budget is too low. (Meta trace Abc123)', attribute: 'daily_budget' })
  })
  it('100/33 says "not found or no access"; a negative code routes on its subcode; is_transient is transient', () => {
    expect(classifyChannelAnswer('META', 400, body(100, 33, 'Unsupported get request')).channelMessage).toMatch(/^Not found or no access \(is the system user assigned to it\?\)/)
    expect(classifyChannelAnswer('META', 400, body(-1, 613))).toMatchObject({ errorClass: 'rate_limited', channelCode: '-1/613' })
    expect(classifyChannelAnswer('META', 500, body(-2)).errorClass).toBe('transient')
    expect(classifyChannelAnswer('META', 400, JSON.stringify({ error: { code: 100, is_transient: true } })).errorClass).toBe('transient')
  })
})

describe('the ledger never keeps a Meta secret', () => {
  it('masks the token, the proof, the renewed token and the inspected token in a text body', () => {
    const safe = ledgerSafeBody('access_token=a&appsecret_proof=b&fb_exchange_token=c&input_token=d&client_secret=e&fields=id') as string
    expect(safe).toBe('access_token=[redacted]&appsecret_proof=[redacted]&fb_exchange_token=[redacted]&input_token=[redacted]&client_secret=[redacted]&fields=id')
  })
})

describe('step 16 — partnership, research and brand-safety reads: their own keys on their own routes, and Meta\'s REST host', () => {
  const ok = (url: string, extra: Partial<Parameters<typeof metaReadOnlyProblem>[0]> = {}) => metaReadOnlyProblem({ method: 'GET', url, kind: 'read', ...extra })
  const REST = 'https://api.facebook.com/partnership-ads'
  it('the one hyphenated Graph edge, only as an edge and only that name', () => {
    expect(ok(`${BASE}/9876543210/partnership-ads-advertisable-content?fb_page_id=120000000000010&ig_user_id=170000000000001&fields=content_id&limit=25`)).toBeNull()
    expect(ok(`${BASE}/9876543210/partnership-ads-advertisable-content?content_ids=["1","2"]&fields=content_id`)).toBeNull()
    expect(ok(`${BASE}/partnership-ads-advertisable-content?fields=content_id`)).toMatch(/letters, digits and _ only/)
    expect(ok(`${BASE}/9876543210/partnership-ads-other?fields=id`)).toMatch(/letters, digits and _ only/)
    expect(ok(`${BASE}/9876543210/partnership-ads-advertisable-content?fields=content_id&search_query=x`)).toMatch(/"search_query" is not one/)
    // A change of it stays refused by the write allow-list.
    expect(metaWriteProblemOf('POST', `${BASE}/9876543210/partnership-ads-advertisable-content`, 'name=x')).toMatch(/only Meta change Nexus sends/)
  })
  it('each new key on its own route only, a neighbour route refused', () => {
    expect(ok(`${BASE}/170000000000001/branded_content_ad_permissions?creator_username=shop_a&fields=id`)).toBeNull()
    expect(ok(`${BASE}/170000000000001/branded_content_tag_approval?user_ids=1,2&fields=id`)).toBeNull()
    expect(ok(`${BASE}/170000000000001/creator_marketplace_creators?creator_countries=["IT"]&custom_audience_id=120000000000501&fields=id`)).toBeNull()
    expect(ok(`${BASE}/170000000000001/creator_marketplace_brand_info?acting_business_id=1`)).toMatch(/"acting_business_id" is not one/)
    expect(ok(`${BASE}/ads_archive?ad_reached_countries=["IT"]&search_terms=casco&search_page_ids=[1]&fields=id,page_id&limit=25`)).toBeNull()
    expect(ok(`${BASE}/ads_archive?ad_reached_countries=["IT"]&bylines=["x"]`)).toMatch(/"bylines" is not one/)
    expect(ok(`${BASE}/ig_hashtag_search?user_id=170000000000001&q=moto`)).toBeNull()
    expect(ok(`${BASE}/17800000000000591/top_media?user_id=170000000000001&fields=id`)).toBeNull()
    expect(ok(`${BASE}/120000000000201/publisher_delivery_report?platform=facebook&position=instream_video&start_date=2026-10-01&end_date=2026-10-20&summary=true&fields=url`)).toBeNull()
    expect(ok(`${BASE}/120000000000201/content_delivery_report?platform=facebook&position=instream_video&datetime=2026-10-20T10:00&fields=content_id`)).toBeNull()
    expect(ok(`${BASE}/120000000000201/adjacent_content_delivery_report?platform=facebook&position=feed&datetime=2026-10-20T10:00`)).toBeNull()
    expect(ok(`${BASE}/adjacent_content_delivery_report_date_ranges?platform=threads&position=reels&fields=earliest_datetime`)).toBeNull()
    expect(ok(`${BASE}/brand_safety_publisher_list?platform=facebook&position=instream_video&follower_count=all&include_summary=true&fields=url`)).toBeNull()
    expect(ok(`${BASE}/120000000000901/assigned_users?business_id=9876543210`)).toBeNull()
    // Neighbours: a key on the route next door is refused.
    expect(ok(`${BASE}/120000000000201/insights?platform=facebook&fields=spend`)).toMatch(/"platform" is not one/)
    expect(ok(`${BASE}/act_1234567890/campaigns?fields=id&user_id=1`)).toMatch(/"user_id" is not one/)
    expect(ok(`${BASE}/120000000000201/publisher_delivery_report?datetime=2026-10-20T10:00&fields=url`)).toMatch(/"datetime" is not one/)
    expect(ok(`${BASE}/act_1234567890/assigned_users?business_id=9876543210`)).toMatch(/"business_id" is not one/)
    expect(ok(`${BASE}/170000000000001/media?q=moto&fields=id`)).toMatch(/"q" is not one/)
  })
  it('Meta\'s REST host: four GET paths of one Page, their own keys, the account\'s own token; everything else refused', () => {
    expect(ok(`${REST}/fb-account-level-permissions/120000000000010?status=[1,2]&permission_direction=sent&limit=100&offset=0`)).toBeNull()
    expect(ok(`${REST}/fb-branded-content/120000000000010/brand-allowlist-status`)).toBeNull()
    expect(ok(`${REST}/fb-branded-content/120000000000010/brand-allowlisted-creators`)).toBeNull()
    expect(ok(`${REST}/fb-branded-content/120000000000010/branded-content-posts?start_date=2026-10-01&end_date=2026-10-21&creator_page_ids=[1]`)).toBeNull()
    expect(metaCallVerdict({ method: 'GET', url: `${REST}/fb-branded-content/120000000000010/brand-allowlist-status`, kind: 'read' })).toEqual({ problem: null, renewalClientId: null, rest: true })
    for (const url of [
      'https://api.facebook.com/content_block_lists/120000000000701/file_download',
      'https://api.facebook.com/content-block-lists/120000000000701/file-download',
      'https://api.facebook.com/adjacent_content_delivery_reports/9876543210/file_download',
      'https://api.facebook.com/adjacent-content-delivery-reports/9876543210/file-download',
      `${REST}/fb-branded-content/120000000000010/brand-allowlist-status/x`,
      `${REST}/fb-account-level-permissions/me`,
      `${REST}//fb-account-level-permissions/120000000000010`,
      `${REST}/fb-account-level-permissions/%31`,
      `${REST}/FB-account-level-permissions/120000000000010`,
      'http://api.facebook.com/partnership-ads/fb-branded-content/120000000000010/brand-allowlist-status',
      'https://api.facebook.com:8443/partnership-ads/fb-branded-content/120000000000010/brand-allowlist-status',
    ]) expect(ok(url), url).not.toBeNull()
    expect(ok(`${REST}/fb-branded-content/120000000000010/brand-allowlist-status?is_enabled=true`)).toMatch(/"is_enabled" is not one/)
    expect(ok(`${REST}/fb-branded-content/120000000000010/branded-content-posts?post_ids=[1]`)).toMatch(/"post_ids" is not one/)
    expect(ok(`${REST}/fb-branded-content/120000000000010/brand-allowlist-status?access_token=x`)).toMatch(/no Nexus read sends/)
    expect(ok(`${REST}/fb-account-level-permissions/120000000000010?limit=1&limit=2`)).toMatch(/more than once/)
    expect(ok(`${REST}/fb-account-level-permissions/120000000000010?_method=DELETE`)).toMatch(/no Nexus read sends/)
    expect(ok(`${REST}/fb-branded-content/120000000000010/brand-allowlist-status`, { auth: 'app' })).toMatch(/own system-user token/)
    expect(ok(`${REST}/fb-branded-content/120000000000010/brand-allowlist-status`, { auth: 'none' })).toMatch(/own system-user token/)
    expect(ok(`${REST}/fb-branded-content/120000000000010/brand-allowlist-status`, { headers: { Authorization: 'Bearer x' } })).toMatch(/no header/)
    // Never a change: a PUT, POST or DELETE of the same paths goes to the write allow-list, which has no REST host at all.
    for (const method of ['PUT', 'POST', 'DELETE']) {
      expect(metaWriteProblemOf(method, `${REST}/fb-branded-content/120000000000010/brand-allowlist-status`, 'is_enabled=true')).toMatch(/graph\.facebook\.com/)
    }
    expect(metaRenewalOf(`${REST}/fb-branded-content/120000000000010/brand-allowlist-status`)).toBeNull()
  })
  it('a REST read goes with the token as a Bearer header and Meta\'s API version header — never on the URL, no proof', async () => {
    h.answers.push(() => new Response('[{"creator_page_id": 12345678901234567, "creator_page_name": "Shop B"}]', { status: 200 }))
    const res = await metaRestCall({ connectionId: 'm-1', operation: 'partners.allowlistCreators', path: 'partnership-ads/fb-branded-content/120000000000010/brand-allowlisted-creators' })
    expect(res.status).toBe(200)
    expect(h.calls).toHaveLength(1)
    const sent = sentUrl()
    expect(`${sent.host}${sent.pathname}`).toBe('api.facebook.com/partnership-ads/fb-branded-content/120000000000010/brand-allowlisted-creators')
    expect([...sent.searchParams.keys()]).toEqual([])
    const headers = h.calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer meta-system-user-token')
    expect(headers['X-API-Version']).toBe('1.0.0')
    expect(h.calls[0].init.redirect).toBe('error')
    expect(h.proofs).toEqual([])
    expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'META', operation: 'partners.allowlistCreators', outcome: 'sent', success: true, endpoint: 'api.facebook.com/partnership-ads/fb-branded-content/120000000000010/brand-allowlisted-creators' })])
    expect(metaRestUrl('partnership-ads/fb-account-level-permissions/1', { status: [1, 2], limit: 5 })).toBe('https://api.facebook.com/partnership-ads/fb-account-level-permissions/1?status=%5B1%2C2%5D&limit=5')
    // A Graph read keeps its token on the URL with its proof, and no Authorization header.
    await metaCall({ connectionId: 'm-1', operation: 'campaigns.list', path: 'act_1234567890/campaigns', query: { fields: 'id' } })
    expect((h.calls[1].init.headers as Record<string, string>).Authorization).toBeUndefined()
    expect(sentUrl(1).searchParams.get('access_token')).toBe('meta-system-user-token')
  })
  it('a REST path off the allow-list is refused with its ledger row and nothing is sent', async () => {
    await expect(gatewayCall({ channel: 'META', operation: 'x', kind: 'read', connectionId: 'm-1', url: 'https://api.facebook.com/content_block_lists/120000000000701/file_download', method: 'GET' })).rejects.toBeInstanceOf(GatewayRefusal)
    expect(h.calls).toHaveLength(0)
    expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'META', outcome: 'refused', errorCode: 'META_READ_ONLY' })])
  })
})

describe('step 16 review fixes — no creator picked by gender or age; a backslash never splits the judged path from the sent one; the hyphenated edge only after an id', () => {
  const ok = (url: string, extra: Partial<Parameters<typeof metaReadOnlyProblem>[0]> = {}) => metaReadOnlyProblem({ method: 'GET', url, kind: 'read', ...extra })
  it('A1 — creator_gender and creator_age_bucket are refused; the audience filters stay', () => {
    expect(ok(`${BASE}/170000000000001/creator_marketplace_creators?creator_gender=["female"]&fields=id`)).toMatch(/"creator_gender" is not one/)
    expect(ok(`${BASE}/170000000000001/creator_marketplace_creators?creator_age_bucket=["18_to_24"]&fields=id`)).toMatch(/"creator_age_bucket" is not one/)
    expect(ok(`${BASE}/170000000000001/creator_marketplace_creators?major_audience_gender=["female"]&major_audience_age_bucket=["18_to_24"]&fields=id`)).toBeNull()
  })
  it('A2 — a backslash anywhere is refused on both hosts (the URL parser reads it as /)', () => {
    expect(new URL('https://graph.facebook.com\\x/v26.0/act_1/campaigns').pathname).toBe('/x/v26.0/act_1/campaigns')
    expect(ok('https://graph.facebook.com\\x/v26.0/act_1/campaigns?fields=id')).toMatch(/no backslash/)
    expect(ok(`${BASE}/act_1/campaigns\\x?fields=id`)).not.toBeNull()
    expect(ok('https://api.facebook.com\\x/partnership-ads/fb-branded-content/120000000000010/brand-allowlist-status')).toMatch(/no backslash/)
    expect(ok('https://api.facebook.com/partnership-ads/fb-branded-content/120000000000010\\brand-allowlist-status')).not.toBeNull()
    // The plain forms still go.
    expect(ok(`${BASE}/act_1/campaigns?fields=id`)).toBeNull()
    expect(ok('https://api.facebook.com/partnership-ads/fb-branded-content/120000000000010/brand-allowlist-status')).toBeNull()
  })
  it('A6 — the hyphenated edge only as <digits>/partnership-ads-advertisable-content, nothing before or after', () => {
    expect(ok(`${BASE}/9876543210/partnership-ads-advertisable-content?fields=content_id`)).toBeNull()
    for (const path of ['me/partnership-ads-advertisable-content', 'act_1/partnership-ads-advertisable-content', '123/partnership-ads-advertisable-content/x', '123/456/partnership-ads-advertisable-content']) {
      expect(ok(`${BASE}/${path}?fields=content_id`), path).toMatch(/letters, digits and _ only/)
    }
  })
})

function metaWriteProblemOf(method: string, url: string, body: string): string | null {
  const verdict = metaWriteVerdict({ method, url, kind: 'write', body })
  return 'problem' in verdict ? verdict.problem : null
}
