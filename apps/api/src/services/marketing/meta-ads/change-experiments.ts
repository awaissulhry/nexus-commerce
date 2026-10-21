/**
 * Meta step 28 — create-meta-experiment, set-meta-experiment and end-meta-experiment as drafts (pure: no reads). Meta's
 * facts are in gateway/meta-optimize-rules.ts (where they were read). In short:
 *   - A study is made on the chosen ad account's business portfolio (`POST /<business>/ad_studies`): an A/B test
 *     (SPLIT_TEST: ad sets or campaigns, 2–10 cells in Nexus), a creative test (SPLIT_TEST_V2: one ad per cell, 2–5 cells,
 *     whole percentages summing to 100, a test budget; cooldown = start and observation end = end, Meta's guide), or a
 *     conversion lift study (LIFT: test and holdout percentages, at least one objective with the account's pixel or custom
 *     conversions; Meta's grant). Each cell's share is at least 10 %, the shares at most 100 %. Meta has no pre-check
 *     (EX-011: Meta's own MCP has one): the preview runs Nexus's — the objects are the chosen account's, in no test that is
 *     not over, the account under Meta's 100 open studies, the start in the future.
 *   - A study CANNOT be deleted (Meta: "You can't perform this operation"): making one has no undo.
 *   - Once a study runs, its start and its split are fixed and nothing can be removed from it; its end can move to a later
 *     time while it has not ended; objectives cannot change. set-meta-experiment does what Meta allows at that moment.
 *   - Ending early (EX-023): Meta documents no cancel; it takes only a FUTURE end_time. end-meta-experiment moves the end
 *     to a time soon (the person names it; 15 minutes from now suggested), a creative test's observation end with it.
 *     Whether Meta takes an EARLIER end is a live probe (LIVE-PROBES EX-023): Meta's answer decides, in its words.
 *   - A Page video A/B test (EX-901): `POST /<page>/ab_tests` with 2–4 of the chosen Page's unpublished videos; deleting one
 *     (EX-902) only once it concluded; Meta's guide asks for a Page access token (Meta's answer decides).
 * Spend: a study splits the audience of the cells' own budgets and adds none — except a creative test's own daily test
 * budget (Meta does not say whether it is on top): SPENDS MONEY. Extending a creative test keeps its test budget running.
 */
import { LIFT_PIXEL_EVENTS, MAX_CELL_OBJECTS, MAX_CREATIVE_TEST_CELLS, MAX_STUDY_CELLS, MAX_STUDY_VIEWERS, VIDEO_TEST_GOALS, VIDEO_TEST_MAX_SECONDS, VIDEO_TEST_MIN_SECONDS } from '../../gateway/meta-optimize-rules.js'
import { changeLines, plural, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import { money } from './change-settings-common.js'
import type { LiveCell, LiveStudy } from './live-optimize-changes.js'
import { budgetParam, MetaUnitError, unixSecondsParam } from './settings-units.js'

export const EXPERIMENT_KINDS = ['ab-test', 'creative-test', 'lift', 'page-video-test'] as const
export type ExperimentKind = typeof EXPERIMENT_KINDS[number]
export type LiftPixelEvent = typeof LIFT_PIXEL_EVENTS[number]
export type VideoTestGoal = typeof VIDEO_TEST_GOALS[number]
/** The most objects a new study names in Nexus (each read twice: the object and the studies it is in). */
export const MAX_STUDY_OBJECTS_CREATE = 20
const STUDY_TYPE: Record<Exclude<ExperimentKind, 'page-video-test'>, 'SPLIT_TEST' | 'SPLIT_TEST_V2' | 'LIFT'> = { 'ab-test': 'SPLIT_TEST', 'creative-test': 'SPLIT_TEST_V2', lift: 'LIFT' }
const KIND_WORDS: Record<ExperimentKind, string> = { 'ab-test': 'A/B test', 'creative-test': 'creative test', lift: 'conversion lift study', 'page-video-test': 'Page video A/B test' }
const TYPE_WORDS: Record<string, string> = { SPLIT_TEST: 'A/B test', SPLIT_TEST_V2: 'creative test', LIFT: 'conversion lift study' }

/**
 * Ending early: the end a person names lands at least this far ahead (Meta takes only a FUTURE end_time; the request must
 * still be in the future when it reaches Meta) and at most a day ahead. The end is an argument, never "now": the request
 * a person approves is the one sent (its plan does not move with the clock).
 */
export const END_MIN_AHEAD_SECONDS = 2 * 60
export const END_MAX_AHEAD_SECONDS = 24 * 3600
/** The margin the tool suggests (Meta's own rule is only "a future time"). */
export const END_SUGGESTED_AHEAD_SECONDS = 15 * 60

export interface ExperimentCellInput {
  name: string
  description?: string
  /** Its share of the audience that sees the ads (at least 10). */
  percent: number
  /** lift: its holdout (people who see none of these ads). */
  controlPercent?: number
  campaignIds?: string[]
  adSetIds?: string[]
  adIds?: string[]
  /** lift: the whole chosen ad account. */
  wholeAdAccount?: boolean
}

export interface ObjectiveInput {
  name: string
  primary?: boolean
  pixelId?: string
  pixelEvents?: LiftPixelEvent[]
  customConversionIds?: string[]
}

export interface CreateExperimentRequest {
  kind: ExperimentKind
  name: string
  description?: string
  startTime?: string
  endTime?: string
  observationEndTime?: string
  confidenceLevel?: number
  cells?: ExperimentCellInput[]
  creativeTestBudget?: { dailyBudgetCents?: number; lifetimeBudgetPercent?: number }
  objectives?: ObjectiveInput[]
  videoIds?: string[]
  controlVideoId?: string
  goal?: VideoTestGoal
  durationMinutes?: number
}

/** One object of a cell as read now. */
export interface StudyObject { kind: 'campaign' | 'adset' | 'ad'; id: string; name: string | null; effectiveStatus: string | null }
export interface OpenStudy { studyId: string; name: string | null; state: string | null; endTime: number | null }

export interface CreateExperimentLive {
  /** UTC Unix seconds. */
  now: number
  adAccountId: string
  currency: string | null
  businessId: string | null
  pageId: string | null
  objects: Map<string, StudyObject>
  objectStudies: Map<string, OpenStudy[]>
  openStudies: number | null
  pixels: Set<string> | null
  customConversions: Set<string> | null
  videos: Array<{ id: string; title: string | null; published: boolean | null }>
}

/** The record of a study change (AgentChange before / after). */
export interface ExperimentRecord {
  kind: 'study' | 'page-video-test'
  /** The study or test (after a create: Meta's new id). */
  id: string
  type: string | null
  /** field → value as viewed (times as UTC Unix seconds, viewers and splits as sorted lists). */
  fields: Record<string, string | null>
  /** before only: the arguments of set-meta-experiment that put back what it replaced (null: none), and what has none. */
  undo?: Record<string, unknown> | null
  noUndo?: string[]
}

const two = (v: number) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9
const isoOf = (unix: number) => new Date(unix * 1000).toISOString().replace('.000Z', 'Z')
const objectWord = (k: 'campaign' | 'adset' | 'ad') => (k === 'adset' ? 'ad set' : k)
const listed = (o: StudyObject) => `${objectWord(o.kind)} "${o.name ?? o.id}" (${o.id})`

/** Each cell's objects as (key, kind, ids). */
function cellObjects(cell: ExperimentCellInput): Array<{ key: 'campaigns' | 'adsets' | 'ads'; kind: 'campaign' | 'adset' | 'ad'; ids: string[] }> {
  return ([['campaigns', 'campaign', cell.campaignIds], ['adsets', 'adset', cell.adSetIds], ['ads', 'ad', cell.adIds]] as const)
    .filter(([, , ids]) => ids?.length).map(([key, kind, ids]) => ({ key, kind, ids: [...new Set(ids!)] }))
}

/** The ids of every object a request's cells name, by kind (the tool reads these first). */
export function cellObjectIds(cells: ExperimentCellInput[] | undefined): Array<{ kind: 'campaign' | 'adset' | 'ad'; id: string }> {
  const out: Array<{ kind: 'campaign' | 'adset' | 'ad'; id: string }> = []
  for (const cell of cells ?? []) for (const o of cellObjects(cell)) for (const id of o.ids) out.push({ kind: o.kind, id })
  return out
}

/** Nexus's own pre-check of one object for a test (EX-011 / EX-003): the account's, readable, in no test that is not over. */
function objectProblem(o: { kind: 'campaign' | 'adset' | 'ad'; id: string }, live: { objects: Map<string, StudyObject>; objectStudies: Map<string, OpenStudy[]> }): string | null {
  const read = live.objects.get(o.id)
  if (!read || read.kind !== o.kind) return `${objectWord(o.kind)} ${o.id} is not ${o.kind === 'campaign' ? 'a' : 'an'} ${objectWord(o.kind)} of the chosen ad account.`
  const open = live.objectStudies.get(o.id) ?? []
  if (open.length) return `${listed(read)} is already in ${open.map((s) => `study "${s.name ?? s.studyId}" (${s.studyId}, ${s.state}${s.endTime ? ` until ${isoOf(s.endTime)}` : ''})`).join(', ')}: an object is in one test at a time, or the results mix.`
  return null
}

/** A cell as Meta writes it (name, share, holdout, its objects). */
function cellParam(cell: ExperimentCellInput, type: string, adAccountId: string): Record<string, unknown> {
  const out: Record<string, unknown> = { name: cell.name }
  if (cell.description) out.description = cell.description
  out.treatment_percentage = cell.percent
  if (type === 'LIFT') out.control_percentage = cell.controlPercent ?? 0
  if (cell.wholeAdAccount) out.adaccounts = [adAccountId]
  for (const o of cellObjects(cell)) out[o.key] = o.ids
  return out
}

/** Why a request's cells do not make a study of this type, or null. */
function cellsProblem(cells: ExperimentCellInput[], type: string, existingShare = 0): string | null {
  const max = type === 'SPLIT_TEST_V2' ? MAX_CREATIVE_TEST_CELLS : MAX_STUDY_CELLS
  if (cells.length > max) return `A ${TYPE_WORDS[type]} has at most ${max} cells in Nexus${type === 'SPLIT_TEST_V2' ? ' (Meta\'s reference: 2–5)' : ''}.`
  let sum = existingShare
  const levels = new Set<string>()
  for (const cell of cells) {
    const objects = cellObjects(cell)
    const named = objects.length + (cell.wholeAdAccount ? 1 : 0)
    if (named !== 1) return `Cell "${cell.name}" names exactly one kind of object: ${type === 'SPLIT_TEST_V2' ? 'adIds' : type === 'LIFT' ? 'campaignIds, adSetIds or wholeAdAccount' : 'campaignIds or adSetIds'}.`
    if (cell.percent < 10 || cell.percent > 100 || !two(cell.percent)) return `Cell "${cell.name}": its share is 10 to 100 % with at most two decimals (Meta: at least 10).`
    if (type === 'SPLIT_TEST_V2' && !Number.isInteger(cell.percent)) return 'A creative test\'s shares are whole numbers (Meta\'s guide).'
    if (cell.controlPercent !== undefined && type !== 'LIFT') return 'A holdout (controlPercent) is a lift study\'s only.'
    if (cell.controlPercent !== undefined && (cell.controlPercent < 0 || cell.controlPercent > 100 || !two(cell.controlPercent))) return `Cell "${cell.name}": its holdout is 0 to 100 % with at most two decimals.`
    if (cell.wholeAdAccount && type !== 'LIFT') return 'The whole ad account is a lift study\'s cell only.'
    sum += cell.percent + (cell.controlPercent ?? 0)
    for (const o of objects) {
      if (o.ids.length > (type === 'SPLIT_TEST_V2' ? 1 : MAX_CELL_OBJECTS)) return type === 'SPLIT_TEST_V2' ? `Cell "${cell.name}": a creative test has exactly one ad per cell.` : `Cell "${cell.name}" names at most ${MAX_CELL_OBJECTS} objects.`
      if (type === 'SPLIT_TEST' && o.kind === 'ad') return 'An A/B test compares ad sets or campaigns (a creative test compares ads).'
      if (type === 'SPLIT_TEST_V2' && o.kind !== 'ad') return 'A creative test compares ads: one ad per cell (adIds).'
      if (type === 'LIFT' && o.kind === 'ad') return 'A lift study measures campaigns, ad sets or the whole ad account.'
      levels.add(o.kind)
    }
  }
  if (type === 'SPLIT_TEST' && levels.size > 1) return 'An A/B test compares one level: every cell names ad sets, or every cell campaigns.'
  if (sum > 100 + 1e-9) return `The cells' shares${type === 'LIFT' ? ' and holdouts' : ''} sum to at most 100 % (now ${Math.round(sum * 100) / 100}).`
  return null
}

function objectivesParam(objectives: ObjectiveInput[], live: { pixels: Set<string> | null; customConversions: Set<string> | null }): Array<Record<string, unknown>> | { refusal: string } {
  if (!objectives.length) return { refusal: 'A lift study measures at least one objective (Meta): name it with its pixel (and events) or custom conversions.' }
  if (objectives.length > 5) return { refusal: 'At most 5 objectives in Nexus.' }
  const primaries = objectives.filter((o) => o.primary).length
  if (primaries > 1) return { refusal: 'Only one objective is the primary one.' }
  const out: Array<Record<string, unknown>> = []
  for (const [i, o] of objectives.entries()) {
    if (!o.pixelId && !o.customConversionIds?.length) return { refusal: `Objective "${o.name}" names its source: the ad account's pixel (pixelId) or custom conversions.` }
    if (o.pixelId && !live.pixels?.has(o.pixelId)) return { refusal: `Pixel ${o.pixelId} is not one of the chosen ad account's own pixels.` }
    for (const id of o.customConversionIds ?? []) if (!live.customConversions?.has(id)) return { refusal: `Custom conversion ${id} is not one of the chosen ad account's.` }
    out.push({
      name: o.name, is_primary: primaries ? !!o.primary : i === 0, type: 'CONVERSIONS',
      ...(o.pixelId ? { adspixels: [{ id: o.pixelId, ...(o.pixelEvents?.length ? { event_names: [...new Set(o.pixelEvents)] } : {}) }] } : {}),
      ...(o.customConversionIds?.length ? { customconversions: [...new Set(o.customConversionIds)].map((id) => ({ id })) } : {}),
    })
  }
  return out
}

const timeOf = (iso: string | undefined, what: string): number | { refusal: string } => {
  if (!iso) return { refusal: `Name ${what} (ISO 8601 with its offset, e.g. 2026-11-01T08:00:00Z).` }
  try { return Number(unixSecondsParam(iso)) } catch (err) { if (err instanceof MetaUnitError) return { refusal: err.message }; throw err }
}

/**
 * A creative test's daily test budget: Meta's budget unit of the account currency (its guide's example
 * `{"daily_budget":15000}` names no unit; Meta's budgets are in the currency's offset unit — settings-units.ts budgetParam,
 * LIVE-PROBES EX-015). ONE helper.
 */
export function creativeTestBudgetParam(cents: number, currency: string | null): number {
  return Number(budgetParam(cents, currency))
}

/** The draft of a new study or Page video test (ONE request). */
export function createExperimentDraft(request: CreateExperimentRequest, live: CreateExperimentLive): MetaChangeDraft | { refusal: string } {
  const lines: Array<[string, unknown, unknown]> = []
  const warnings: string[] = []
  const spendsMoney: string[] = []
  const cur = live.currency
  const words = KIND_WORDS[request.kind]

  if (request.kind === 'page-video-test') {
    if (!live.pageId) return { refusal: 'No Facebook Page is chosen for this business yet: a person chooses it in Settings › Channels › Meta (or set-meta-connection).' }
    const videos = [...new Set(request.videoIds ?? [])]
    if (videos.length < 2 || videos.length > 4) return { refusal: 'A Page video A/B test compares 2 to 4 of the Page\'s videos (videoIds).' }
    if (!request.goal) return { refusal: `Name what decides the winner (goal: ${VIDEO_TEST_GOALS.join(', ')}).` }
    if (!request.description) return { refusal: 'Meta needs a description for a Page video A/B test.' }
    const control = request.controlVideoId ?? videos[0]
    if (!videos.includes(control)) return { refusal: 'The control video (the winner in a tie) is one of videoIds.' }
    for (const id of videos) {
      const v = live.videos.find((x) => x.id === id)
      if (!v) return { refusal: `Video ${id} could not be read as one of the chosen Page's.` }
      if (v.published === true) return { refusal: `Video ${id} is published already: Meta tests only uploaded videos that are not published yet (each in one test only).` }
    }
    const params: Record<string, string> = { name: request.name, description: request.description, optimization_goal: request.goal, control_video_id: control, experiment_video_ids: JSON.stringify(videos) }
    if (request.durationMinutes !== undefined) {
      const seconds = Math.round(request.durationMinutes * 60)
      if (seconds < VIDEO_TEST_MIN_SECONDS || seconds > VIDEO_TEST_MAX_SECONDS) return { refusal: 'A Page video test runs 30 minutes to a week (Meta).' }
      params.duration = String(seconds)
    }
    if (request.startTime) {
      const start = timeOf(request.startTime, 'its start')
      if (typeof start !== 'number') return start
      if (start <= live.now) return { refusal: 'A scheduled start is in the future.' }
      params.scheduled_experiment_timestamp = String(start)
    }
    lines.push(['Page video test', 'none', `"${request.name}": ${videos.length} videos (control ${control}), winner by ${request.goal}${params.duration ? `, ${request.durationMinutes} minutes` : ''}${params.scheduled_experiment_timestamp ? `, from ${isoOf(Number(params.scheduled_experiment_timestamp))}` : ', from when Meta makes it'}`])
    warnings.push('Meta publishes the test versions of these Page videos to the Page\'s followers (organic: no ad spend); a video can be in one test only, and Meta allows up to 50 tests at once.')
    warnings.push('Meta\'s guide asks for a Page access token for this; Nexus sends it with the business\'s system-user token (with the Page assigned to it): when Meta refuses it, its words say what is missing.')
    warnings.push('No undo: Meta deletes a video test only once it has concluded (set-meta-experiment action delete-page-video-test); the posts stay.')
    const req: MetaChangeRequest = {
      step: 1, label: `Make the Page video A/B test "${request.name}"`, kind: 'ad', objectId: live.pageId, objectKind: 'page', edge: 'ab_tests', params,
      check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false, operation: 'pageVideoTest.create',
      expect: { name: request.name }, readBackFields: 'id,name,publish_status',
    }
    return draftOf(req, lines, warnings, spendsMoney, { kind: request.kind, pageId: live.pageId, videos: live.videos },
      { kind: 'page-video-test', id: '', type: null, fields: {}, undo: null, noUndo: ['Meta deletes a video test only once it has concluded.'] },
      { kind: 'page-video-test', id: '', type: null, fields: { name: request.name, videos: [...videos].sort().join(',') } })
  }

  const type = STUDY_TYPE[request.kind]
  if (!live.businessId) return { refusal: 'Meta makes studies on a business portfolio, and the chosen ad account belongs to none Meta named: make the test in Ads Manager.' }
  const cells = request.cells ?? []
  const minCells = type === 'LIFT' ? 1 : 2
  if (cells.length < minCells) return { refusal: `A ${words} has at least ${minCells} cell${minCells === 1 ? '' : 's'} (cells).` }
  const problem = cellsProblem(cells, type)
  if (problem) return { refusal: problem }
  if (cellObjectIds(cells).length > MAX_STUDY_OBJECTS_CREATE) return { refusal: `A new test names at most ${MAX_STUDY_OBJECTS_CREATE} objects in Nexus (each is read twice before it is asked: Meta's Limited access tier allows about 60 reads per 5 minutes).` }
  if (type === 'SPLIT_TEST_V2' && Math.abs(cells.reduce((s, c) => s + c.percent, 0) - 100) > 1e-9) return { refusal: 'A creative test\'s shares sum to exactly 100 % (Meta\'s guide).' }
  const seen = new Set<string>()
  for (const o of cellObjectIds(cells)) {
    if (seen.has(o.id)) return { refusal: `${objectWord(o.kind)} ${o.id} is in two cells: an object is in one cell only.` }
    seen.add(o.id)
    const p = objectProblem(o, live)
    if (p) return { refusal: p }
  }
  if (live.openStudies !== null && live.openStudies >= 100) return { refusal: `The chosen ad account has ${live.openStudies} studies planned or running: Meta allows at most 100 at once.` }
  const start = timeOf(request.startTime, 'its start (startTime)')
  if (typeof start !== 'number') return start
  const end = timeOf(request.endTime, 'its end (endTime)')
  if (typeof end !== 'number') return end
  if (start <= live.now) return { refusal: 'A study starts in the future (Meta).' }
  if (end <= start) return { refusal: 'Its end is after its start.' }
  const params: Record<string, string> = { name: request.name, type, start_time: String(start), end_time: String(end) }
  if (request.description) params.description = request.description
  if (type === 'SPLIT_TEST_V2') {
    params.cooldown_start_time = String(start)
    params.observation_end_time = String(end)
    const b = request.creativeTestBudget
    if (!b || (b.dailyBudgetCents === undefined) === (b.lifetimeBudgetPercent === undefined)) return { refusal: 'A creative test has its own test budget: creativeTestBudget with dailyBudgetCents OR lifetimeBudgetPercent (Meta needs one).' }
    let config: Record<string, number>
    if (b.dailyBudgetCents !== undefined) {
      try { config = { daily_budget: creativeTestBudgetParam(b.dailyBudgetCents, cur) } } catch (err) { if (err instanceof MetaUnitError) return { refusal: err.message }; throw err }
      lines.push(['Creative test budget', 'none', `${money(b.dailyBudgetCents, cur)} a day`])
      warnings.push('Meta\'s guide names no unit for a creative test\'s daily_budget: Nexus sends it in Meta\'s budget unit, like every Meta budget (cents for EUR) — LIVE-PROBES EX-015.')
    } else {
      if (b.lifetimeBudgetPercent! <= 0 || b.lifetimeBudgetPercent! > 100 || !two(b.lifetimeBudgetPercent!)) return { refusal: 'lifetimeBudgetPercent is 1 to 100.' }
      config = { lifetime_budget_percentage: b.lifetimeBudgetPercent! }
      lines.push(['Creative test budget', 'none', `${b.lifetimeBudgetPercent} % of the lifetime budget`])
    }
    params.creative_test_config = JSON.stringify(config)
    const adsOn = cellObjectIds(cells).map((o) => live.objects.get(o.id)!).filter((o) => o.effectiveStatus === 'ACTIVE')
    spendsMoney.push(`A creative test with its own test budget (${b.dailyBudgetCents !== undefined ? `${money(b.dailyBudgetCents, cur)} a day` : `${b.lifetimeBudgetPercent} % of the lifetime budget`}): Meta does not say whether it comes on top of the ads' own budgets — ${adsOn.length ? `${plural(adsOn.length, 'ad')} ${adsOn.length === 1 ? 'is' : 'are'} on, so it can spend from ${isoOf(start)}` : 'none of the ads is on now: nothing spends unless they are on during the test'}.`)
  }
  if (type === 'LIFT') {
    const observe = request.observationEndTime ? timeOf(request.observationEndTime, 'its observation end') : end
    if (typeof observe !== 'number') return observe
    if (observe < end) return { refusal: 'The observation end (when Meta stops counting conversions) is at or after the end.' }
    params.observation_end_time = String(observe)
    const objectives = objectivesParam(request.objectives ?? [], live)
    if ('refusal' in objectives) return objectives
    params.objectives = JSON.stringify(objectives)
    for (const o of objectives) lines.push([`Objective "${o.name}"${o.is_primary ? ' (primary)' : ''}`, 'none', o.adspixels ? `pixel ${(o.adspixels as Array<{ id: string; event_names?: string[] }>)[0].id}${(o.adspixels as Array<{ event_names?: string[] }>)[0].event_names ? `: ${(o.adspixels as Array<{ event_names?: string[] }>)[0].event_names!.join(', ')}` : ''}` : `custom conversions ${(o.customconversions as Array<{ id: string }>).map((c) => c.id).join(', ')}`])
    warnings.push('Conversion lift needs Meta\'s grant ("Conversion Lift Measurement is currently limited"): when Meta refuses, the business asks its Meta representative. Objectives cannot change once the study runs.')
    warnings.push('The holdout sees none of these ads: fewer people reached, not more spend.')
  } else if (request.observationEndTime) return { refusal: 'An observation end is a lift study\'s (a creative test\'s equals its end).' }
  else if (request.objectives?.length) return { refusal: 'Objectives are a lift study\'s.' }
  if (type !== 'SPLIT_TEST_V2' && request.creativeTestBudget) return { refusal: 'A test budget is a creative test\'s.' }
  if (request.confidenceLevel !== undefined) {
    if (request.confidenceLevel < 0.5 || request.confidenceLevel > 0.99 || !two(request.confidenceLevel)) return { refusal: 'confidenceLevel is 0.5 to 0.99.' }
    params.confidence_level = String(request.confidenceLevel)
  }
  params.cells = JSON.stringify(cells.map((c) => cellParam(c, type, live.adAccountId)))
  lines.push([`New ${words}`, 'none', `"${request.name}", ${isoOf(start)} → ${isoOf(end)}`])
  for (const c of cells) {
    const objs = cellObjects(c).flatMap((o) => o.ids.map((id) => live.objects.get(id)!).map(listed))
    lines.push([`Cell "${c.name}"`, 'none', `${c.percent} %${c.controlPercent !== undefined ? ` (+ ${c.controlPercent} % holdout)` : ''}: ${c.wholeAdAccount ? `the whole ad account ${live.adAccountId}` : objs.join(', ')}`])
  }
  const on = cellObjectIds(cells).map((o) => live.objects.get(o.id)!).filter((o) => o.effectiveStatus === 'ACTIVE')
  const off = cellObjectIds(cells).map((o) => live.objects.get(o.id)!).filter((o) => o.effectiveStatus !== 'ACTIVE')
  if (type !== 'SPLIT_TEST_V2') warnings.push(`A ${words} adds no budget: the cells' campaigns and ad sets keep spending as they are set (${on.length} on, ${off.length} not on); Meta only splits who sees which.`)
  if (off.length) warnings.push(`Not on now, so they deliver nothing in the test unless switched on: ${off.slice(0, 5).map(listed).join(', ')}${off.length > 5 ? ', …' : ''}.`)
  if (type !== 'LIFT') warnings.push('Test one variable only, with comparable budgets and audiences, and agree the result that decides (and its attribution) before it starts (Meta\'s split-testing guidelines).')
  warnings.push('No undo: Meta cannot delete a study. Once it runs, its start and split are fixed and nothing can be removed from it (set-meta-experiment can extend it, add objects, rename it and share it; end-meta-experiment ends it early).')
  const firstKind = cellObjectIds(cells)[0]?.kind ?? 'campaign'
  const req: MetaChangeRequest = {
    step: 1, label: `Make the ${words} "${request.name}" (${plural(cells.length, 'cell')})`, kind: firstKind, objectId: live.businessId, objectKind: 'business', edge: 'ad_studies', params,
    check: 'none', raisesSpend: spendsMoney.length > 0, readBackInPost: false, budget: false, undoable: false, operation: 'study.create',
    expect: { name: request.name }, readBackFields: 'id,name,type,start_time,end_time',
  }
  return draftOf(req, lines, warnings, spendsMoney, { kind: request.kind, businessId: live.businessId, objects: [...live.objects.values()], objectStudies: [...live.objectStudies.entries()], openStudies: live.openStudies },
    { kind: 'study', id: '', type, fields: {}, undo: null, noUndo: ['Meta cannot delete a study.'] },
    { kind: 'study', id: '', type, fields: { name: request.name, start_time: String(start), end_time: String(end) } })
}

function draftOf(req: MetaChangeRequest, lines: Array<[string, unknown, unknown]>, warnings: string[], spendsMoney: string[], stands: unknown, before: ExperimentRecord, after: ExperimentRecord, skipped: string[] = []): MetaChangeDraft {
  const { changes, more } = changeLines(lines)
  return {
    summary: `Meta: ${req.label}.`,
    changes,
    totals: { requests: 1, ...(more ? { moreLines: more } : {}) },
    warnings,
    spendsMoney,
    skipped,
    requests: [req],
    stands,
    before,
    after,
  }
}

// ── set-meta-experiment ───────────────────────────────────────────────────────────────────────────────────────────

export interface SetExperimentRequest {
  action: 'update' | 'delete-page-video-test'
  studyId?: string
  name?: string
  description?: string
  startTime?: string
  endTime?: string
  observationEndTime?: string
  confidenceLevel?: number
  splits?: Array<{ cellId: string; percent: number; controlPercent?: number }>
  addCells?: ExperimentCellInput[]
  removeCellIds?: string[]
  addObjects?: Array<{ cellId: string; campaignIds?: string[]; adSetIds?: string[]; adIds?: string[] }>
  objectives?: ObjectiveInput[]
  viewers?: string[]
  testId?: string
}

export interface SetExperimentLive {
  now: number
  adAccountId: string
  study: LiveStudy | null
  objects: Map<string, StudyObject>
  objectStudies: Map<string, OpenStudy[]>
  pixels: Set<string> | null
  customConversions: Set<string> | null
  /** The people with a role on the chosen ad account (null: Meta did not answer). */
  people: Set<string> | null
  videoTest: { id: string; name: string | null; publishStatus: string | null; concluded: boolean | null } | null
}

/** A study's fields as a record views them (times as UTC Unix seconds; viewers and splits sorted). */
export function studyFields(study: LiveStudy): Record<string, string | null> {
  return {
    name: study.name, description: study.description,
    start_time: study.startTime === null ? null : String(study.startTime), end_time: study.endTime === null ? null : String(study.endTime),
    observation_end_time: study.observationEndTime === null ? null : String(study.observationEndTime),
    viewers: study.viewers ? [...study.viewers].sort().join(',') : null,
    splits: study.cells ? study.cells.map((c) => `${c.id}:${c.treatment ?? ''}/${c.control ?? ''}`).sort().join(',') : null,
  }
}

const cellLevel = (c: LiveCell): { key: 'campaigns' | 'adsets' | 'ads' | 'adaccounts'; ids: string[] } | null =>
  c.campaigns.length ? { key: 'campaigns', ids: c.campaigns } : c.adSets.length ? { key: 'adsets', ids: c.adSets } : c.ads.length ? { key: 'ads', ids: c.ads } : c.adAccounts.length ? { key: 'adaccounts', ids: c.adAccounts } : null

/** The ids of the objects a set-meta-experiment request adds (the tool reads these first). */
export function addedObjectIds(request: SetExperimentRequest): Array<{ kind: 'campaign' | 'adset' | 'ad'; id: string }> {
  const out = cellObjectIds(request.addCells)
  for (const a of request.addObjects ?? []) for (const [kind, ids] of [['campaign', a.campaignIds], ['adset', a.adSetIds], ['ad', a.adIds]] as const) for (const id of ids ?? []) out.push({ kind, id })
  return out
}

/** The draft of a change of one study (ONE request), or of deleting a Page video test. */
export function setExperimentDraft(request: SetExperimentRequest, live: SetExperimentLive): MetaChangeDraft | { refusal: string } {
  const lines: Array<[string, unknown, unknown]> = []
  const warnings: string[] = []
  const spendsMoney: string[] = []
  if (request.action === 'delete-page-video-test') {
    const t = live.videoTest
    if (!t) return { refusal: 'Name the Page video test (testId, from meta-experiments view page-video-tests).' }
    if (t.concluded === false) return { refusal: `The video test "${t.name ?? t.id}" still runs (${t.publishStatus}): Meta deletes a test only once it has concluded.` }
    warnings.push('Deleting a Page video test is for good (no undo); the posts of its videos stay on the Page. Meta deletes only a test that has concluded: its answer decides.')
    const req: MetaChangeRequest = {
      step: 1, label: `Delete the Page video test "${t.name ?? t.id}" (${t.id})`, kind: 'ad', objectId: t.id, objectKind: 'pagevideotest', method: 'DELETE', params: {},
      check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false, operation: 'pageVideoTest.delete',
    }
    return draftOf(req, [['Page video test', t.name ?? t.id, 'deleted']], warnings, spendsMoney, { videoTest: t },
      { kind: 'page-video-test', id: t.id, type: null, fields: { exists: 'yes' }, undo: null, noUndo: ['A deleted video test cannot be made again as it was.'] },
      { kind: 'page-video-test', id: t.id, type: null, fields: { exists: 'no' } })
  }

  const s = live.study
  if (!s) return { refusal: 'Name the study (studyId, from meta-experiments view list).' }
  const who = `${TYPE_WORDS[s.type ?? ''] ?? 'study'} "${s.name ?? s.id}" (${s.id})`
  if (s.type !== 'SPLIT_TEST' && s.type !== 'SPLIT_TEST_V2' && s.type !== 'LIFT') return { refusal: `${who} is a ${s.type ?? 'study'} study: Nexus changes A/B tests, creative tests and conversion lift studies only (Meta runs the others).` }
  const over = s.state === 'finished' || s.state === 'cancelled'
  const ended = over || s.state === 'measuring'
  const started = s.state !== 'planned'
  const params: Record<string, string> = {}
  const undo: Record<string, unknown> = {}
  const noUndo: string[] = []
  const iso = (u: number | null) => (u === null ? 'none' : isoOf(u))
  const refuseAfterStart = (what: string) => (started ? { refusal: `${who} has started: Meta does not let ${what} change once a study runs.` } : null)

  if (request.name !== undefined && request.name !== s.name) {
    params.name = request.name
    lines.push(['Name', s.name, request.name])
    if (s.name) undo.name = s.name
  }
  if (request.description !== undefined && request.description !== s.description) {
    params.description = request.description
    lines.push(['Description', s.description, request.description])
    if (s.description) undo.description = s.description
    else noUndo.push('It had no description: Nexus cannot put an empty one back.')
  }
  if (request.startTime !== undefined) {
    const r = refuseAfterStart('its start'); if (r) return r
    const start = timeOf(request.startTime, 'its start')
    if (typeof start !== 'number') return start
    if (start <= live.now) return { refusal: 'A study starts in the future.' }
    if (start !== s.startTime) {
      params.start_time = String(start)
      if (s.type === 'SPLIT_TEST_V2') params.cooldown_start_time = String(start)
      lines.push(['Start', iso(s.startTime), iso(start)])
      if (s.startTime !== null) undo.startTime = isoOf(s.startTime)
      if (s.type === 'SPLIT_TEST_V2' && s.startTime !== null && start < s.startTime) spendsMoney.push(`${who} starts sooner (${iso(start)}), and its own test budget with it.`)
    }
  }
  const newStart = params.start_time ? Number(params.start_time) : s.startTime
  if (request.endTime !== undefined) {
    if (ended) return { refusal: `${who} has ended (${s.state}): Meta moves the end only of a study that has not ended.` }
    const end = timeOf(request.endTime, 'its end')
    if (typeof end !== 'number') return end
    if (end <= live.now) return { refusal: 'Meta takes only a future end.' }
    if (newStart !== null && end <= newStart) return { refusal: 'Its end is after its start.' }
    if (started && s.endTime !== null && end < s.endTime) return { refusal: `To end ${who} sooner, use end-meta-experiment: set-meta-experiment moves a running study's end only later (Meta documents extending it).` }
    if (end !== s.endTime) {
      params.end_time = String(end)
      if (s.type === 'SPLIT_TEST_V2') params.observation_end_time = String(end)
      lines.push(['End', iso(s.endTime), iso(end)])
      // A running study's end only moves later (Meta); its old, earlier end comes back only through end-meta-experiment.
      if (started) noUndo.push(`Its old end (${iso(s.endTime)}) is not put back by undo: a running study's end only moves later; end-meta-experiment ends it sooner.`)
      else if (s.endTime !== null && s.endTime > live.now) undo.endTime = isoOf(s.endTime)
      else noUndo.push('Its old end is not in the future, so it cannot be set back.')
      if (s.endTime !== null && end > s.endTime) {
        if (s.type === 'SPLIT_TEST_V2') spendsMoney.push(`${who} runs longer (to ${iso(end)}), and its own test budget with it.`)
        else warnings.push('A longer test keeps splitting the cells\' audiences longer; it adds no budget (the cells spend as they are set).')
      }
    }
  }
  if (request.observationEndTime !== undefined) {
    if (s.type !== 'LIFT') return { refusal: s.type === 'SPLIT_TEST_V2' ? 'A creative test\'s observation end is its end (endTime moves both).' : 'An observation window is a lift study\'s.' }
    if (over) return { refusal: `${who} is over: Meta takes no new observation end.` }
    const observe = timeOf(request.observationEndTime, 'its observation end')
    if (typeof observe !== 'number') return observe
    const newEnd = params.end_time ? Number(params.end_time) : s.endTime
    if (observe <= live.now) return { refusal: 'Meta takes only a future observation end.' }
    if (newEnd !== null && observe < newEnd) return { refusal: 'The observation end is at or after the end.' }
    if (observe !== s.observationEndTime) {
      params.observation_end_time = String(observe)
      lines.push(['Observation end', iso(s.observationEndTime), iso(observe)])
      if (s.observationEndTime !== null && s.observationEndTime > live.now) undo.observationEndTime = isoOf(s.observationEndTime)
    }
  }
  if (request.confidenceLevel !== undefined) {
    if (request.confidenceLevel < 0.5 || request.confidenceLevel > 0.99 || !two(request.confidenceLevel)) return { refusal: 'confidenceLevel is 0.5 to 0.99.' }
    params.confidence_level = String(request.confidenceLevel)
    lines.push(['Confidence level', 'as set', String(request.confidenceLevel)])
    noUndo.push('Meta does not read a study\'s confidence level back, so Nexus cannot put the old one back.')
  }

  // ── cells: every cell is sent (Meta: "provide the percentage of all existing and new cells") ──
  const cellChange = !!(request.splits?.length || request.addCells?.length || request.removeCellIds?.length || request.addObjects?.length)
  if (cellChange) {
    if (over) return { refusal: `${who} is over: Meta takes no change of its cells.` }
    if (!s.cells) return { refusal: `Nexus could not read the cells of ${who}${s.cellsNote ? ` (${s.cellsNote})` : ''}, and Meta needs every cell in a change of them.` }
    if (request.splits?.length) { const r = refuseAfterStart('the split (treatment percentages)'); if (r) return r }
    if (request.removeCellIds?.length) { const r = refuseAfterStart('its cells be removed (nothing can be removed from a running study)'); if (r) return r }
    const splits = new Map((request.splits ?? []).map((x) => [x.cellId, x]))
    const removed = new Set(request.removeCellIds ?? [])
    for (const id of [...splits.keys(), ...removed]) if (!s.cells.some((c) => c.id === id)) return { refusal: `${id} is not a cell of ${who}.` }
    if (request.splits?.length && s.cells.some((c) => !removed.has(c.id) && !splits.has(c.id))) return { refusal: 'A change of the split names every remaining cell\'s share (Meta: they are correlated).' }
    const addedTo = new Map<string, Array<{ kind: 'campaign' | 'adset' | 'ad'; id: string }>>()
    for (const a of request.addObjects ?? []) {
      const cell = s.cells.find((c) => c.id === a.cellId)
      if (!cell) return { refusal: `${a.cellId} is not a cell of ${who}.` }
      if (removed.has(cell.id)) return { refusal: `Cell ${cell.id} is removed in the same change.` }
      const level = cellLevel(cell)
      const adds = ([['campaign', a.campaignIds], ['adset', a.adSetIds], ['ad', a.adIds]] as const).flatMap(([kind, ids]) => (ids ?? []).map((id) => ({ kind, id })))
      const wanted = level?.key === 'campaigns' ? 'campaign' : level?.key === 'adsets' ? 'adset' : level?.key === 'ads' ? 'ad' : null
      if (!wanted) return { refusal: `Cell ${cell.id} measures the whole ad account: there is nothing to add to it.` }
      if (adds.some((x) => x.kind !== wanted)) return { refusal: `Cell ${cell.id} holds ${objectWord(wanted)}s: add only ${objectWord(wanted)}s to it.` }
      if (s.type === 'SPLIT_TEST_V2') return { refusal: 'A creative test has exactly one ad per cell: nothing can be added to a cell.' }
      addedTo.set(cell.id, [...(addedTo.get(cell.id) ?? []), ...adds])
    }
    for (const o of addedObjectIds(request)) {
      if (s.cells.some((c) => [...c.campaigns, ...c.adSets, ...c.ads].includes(o.id))) return { refusal: `${objectWord(o.kind)} ${o.id} is in ${who} already.` }
      const p = objectProblem(o, live)
      if (p) return { refusal: p }
    }
    const withShares = !!(request.splits?.length || request.addCells?.length)
    const kept = s.cells.filter((c) => !removed.has(c.id))
    const existing = kept.map((c) => {
      const out: Record<string, unknown> = { id: c.id }
      if (withShares) {
        const sp = splits.get(c.id)
        out.treatment_percentage = sp?.percent ?? c.treatment
        if (s.type === 'LIFT') out.control_percentage = sp?.controlPercent ?? c.control ?? 0
      }
      const adds = addedTo.get(c.id)
      const level = cellLevel(c)
      if (adds?.length && level) out[level.key] = [...level.ids, ...adds.map((x) => x.id).filter((id) => !level.ids.includes(id))]
      return out
    })
    if (withShares && existing.some((c) => typeof c.treatment_percentage !== 'number')) return { refusal: 'Nexus could not read every cell\'s share, which Meta needs with a change of the split or a new cell.' }
    for (const c of existing) if (typeof c.treatment_percentage === 'number' && (c.treatment_percentage < 10 || !two(c.treatment_percentage))) return { refusal: 'Each cell\'s share is 10 to 100 % with at most two decimals (Meta: at least 10).' }
    const share = existing.reduce((sum, c) => sum + (typeof c.treatment_percentage === 'number' ? c.treatment_percentage : 0) + (typeof c.control_percentage === 'number' ? c.control_percentage : 0), 0)
    const added = request.addCells ?? []
    if (added.length) {
      const p = cellsProblem(added, s.type, share)
      if (p) return { refusal: p }
      if (s.cells.length - removed.size + added.length > (s.type === 'SPLIT_TEST_V2' ? MAX_CREATIVE_TEST_CELLS : MAX_STUDY_CELLS)) return { refusal: `A ${TYPE_WORDS[s.type]} has at most ${s.type === 'SPLIT_TEST_V2' ? MAX_CREATIVE_TEST_CELLS : MAX_STUDY_CELLS} cells in Nexus.` }
      if (started) warnings.push('Adding a cell to a running study: Meta needs every cell\'s share with it while it keeps the running cells\' shares fixed — its answer decides (LIVE-PROBES EX-020).')
    } else if (share > 100 + 1e-9) return { refusal: 'The cells\' shares sum to at most 100 %.' }
    const minCells = s.type === 'LIFT' ? 1 : 2
    if (kept.length + added.length < minCells) return { refusal: `A ${TYPE_WORDS[s.type]} keeps at least ${minCells} cell${minCells === 1 ? '' : 's'}.` }
    params.cells = JSON.stringify([...existing, ...added.map((c) => cellParam(c, s.type!, live.adAccountId))])
    for (const c of s.cells) {
      if (removed.has(c.id)) { lines.push([`Cell "${c.name ?? c.id}"`, `${c.treatment ?? '?'} %`, 'removed']); continue }
      const sp = splits.get(c.id)
      if (sp) lines.push([`Cell "${c.name ?? c.id}" share`, `${c.treatment ?? '?'} %${c.control !== null ? ` (+ ${c.control} % holdout)` : ''}`, `${sp.percent} %${sp.controlPercent !== undefined ? ` (+ ${sp.controlPercent} % holdout)` : ''}`])
      const adds = addedTo.get(c.id)
      if (adds?.length) lines.push([`Cell "${c.name ?? c.id}" objects`, `${(cellLevel(c)?.ids.length ?? 0)}`, `+ ${adds.map((x) => listed(live.objects.get(x.id)!)).join(', ')}`])
    }
    for (const c of added) lines.push([`New cell "${c.name}"`, 'none', `${c.percent} %${c.controlPercent !== undefined ? ` (+ ${c.controlPercent} % holdout)` : ''}`])
    if (request.splits?.length && s.cells.every((c) => c.treatment !== null)) undo.splits = s.cells.filter((c) => !removed.has(c.id)).map((c) => ({ cellId: c.id, percent: c.treatment!, ...(s.type === 'LIFT' && c.control !== null ? { controlPercent: c.control } : {}) }))
    if (added.length || request.addObjects?.length || removed.size) noUndo.push(started ? 'Meta lets nothing be removed from a running study: added cells and objects stay.' : 'Added or removed cells and objects are not put back by undo (ask set-meta-experiment again before it starts).')
    if (request.addObjects?.length || added.length) {
      const addedObjs = addedObjectIds(request).map((o) => live.objects.get(o.id)!).filter(Boolean)
      if (addedObjs.some((o) => o.effectiveStatus === 'ACTIVE')) warnings.push('The objects added keep spending as they are set; the test only splits who sees which.')
    }
  }
  if (request.objectives !== undefined) {
    if (s.type !== 'LIFT') return { refusal: 'Objectives are a lift study\'s.' }
    const r = refuseAfterStart('its objectives'); if (r) return r
    const objectives = objectivesParam(request.objectives, live)
    if ('refusal' in objectives) return objectives
    params.objectives = JSON.stringify(objectives)
    lines.push(['Objectives', (s.objectives ?? []).map((o) => o.name ?? o.id).join(', ') || 'none read', objectives.map((o) => o.name as string).join(', ')])
    noUndo.push('The objectives it replaces are not put back by undo (Meta answers no source of an objective to Nexus\'s read).')
  }
  if (request.viewers !== undefined) {
    const next = [...new Set(request.viewers)]
    if (next.length > MAX_STUDY_VIEWERS) return { refusal: `Share a study with at most ${MAX_STUDY_VIEWERS} people.` }
    const current = new Set(s.viewers ?? [])
    const newcomers = next.filter((id) => !current.has(id))
    if (newcomers.length) {
      if (!live.people) return { refusal: 'Nexus could not read who has a role on the chosen ad account: it shares a study only with such people.' }
      const strangers = newcomers.filter((id) => !live.people!.has(id))
      if (strangers.length) return { refusal: `${strangers.join(', ')} ${strangers.length === 1 ? 'has' : 'have'} no role on the chosen ad account: Nexus shares a study only with people who do (a study's results are the business's).` }
    }
    params.viewers = JSON.stringify(next)
    lines.push(['Shared with', s.viewers ? `${s.viewers.length} people` : 'not read', `${next.length} people (ids only)`])
    if (s.viewers) undo.viewers = s.viewers
    else noUndo.push('Meta did not answer who the study was shared with, so Nexus cannot put that back.')
    warnings.push('People are Meta ids only: their names stay on Meta\'s side, and Nexus stores no more than the ids of this change.')
  }
  if (!Object.keys(params).length) return { refusal: `Nothing to change: ${who} is as asked already, or the request names no change.` }
  if (started && !ended) warnings.push('Changing a running test can weaken its results (Meta: test one variable, keep the groups comparable).')
  const expectFields: Record<string, string> = { name: params.name ?? s.name ?? '' }
  if (params.end_time) expectFields.end_time = params.end_time
  if (params.observation_end_time) expectFields.observation_end_time = params.observation_end_time
  if (params.start_time) expectFields.start_time = params.start_time
  if (!expectFields.name) delete expectFields.name
  const req: MetaChangeRequest = {
    step: 1, label: `Change ${who}`, kind: 'adset', objectId: s.id, objectKind: 'adstudy', params,
    check: 'none', raisesSpend: spendsMoney.length > 0, readBackInPost: false, budget: false, undoable: Object.keys(undo).length > 0, operation: 'study.update',
    expect: expectFields, readBackFields: 'id,name,start_time,end_time,observation_end_time',
  }
  const beforeFields = studyFields(s)
  const afterFields: Record<string, string | null> = { ...beforeFields }
  for (const k of ['name', 'description', 'start_time', 'end_time', 'observation_end_time'] as const) if (params[k] !== undefined) afterFields[k] = params[k]
  if (params.viewers) afterFields.viewers = (JSON.parse(params.viewers) as string[]).sort().join(',')
  if (params.cells) afterFields.splits = null
  const keep = (o: Record<string, string | null>) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'splits' || !params.cells))
  return draftOf(req, lines, warnings, spendsMoney, { study: s },
    { kind: 'study', id: s.id, type: s.type, fields: keep(beforeFields), undo: Object.keys(undo).length ? { action: 'update', studyId: s.id, ...undo } : null, noUndo },
    { kind: 'study', id: s.id, type: s.type, fields: keep(afterFields) })
}

// ── end-meta-experiment ───────────────────────────────────────────────────────────────────────────────────────────

/** The draft of ending a running study early: its end moved to the time named, soon (a creative test's observation end too). */
export function endExperimentDraft(study: LiveStudy | null, now: number, endAt: string): MetaChangeDraft | { refusal: string } {
  if (!study) return { refusal: 'Name the study (studyId, from meta-experiments view list).' }
  const who = `${TYPE_WORDS[study.type ?? ''] ?? 'study'} "${study.name ?? study.id}" (${study.id})`
  if (study.type !== 'SPLIT_TEST' && study.type !== 'SPLIT_TEST_V2' && study.type !== 'LIFT') return { refusal: `${who} is a ${study.type ?? 'study'} study run by Meta: Nexus ends A/B tests, creative tests and conversion lift studies only.` }
  if (study.state === 'cancelled' || study.state === 'finished' || study.state === 'measuring') return { refusal: `${who} has ended already (${study.state}).` }
  if (study.state === 'planned') return { refusal: `${who} has not started (it starts ${study.startTime ? isoOf(study.startTime) : 'later'}): Meta documents no cancel of a study by API and takes an earlier end only while one runs; until it starts, set-meta-experiment can move its dates. Meta's own MCP says it can cancel a test on Meta's side.` }
  if (study.state !== 'running' || study.endTime === null) return { refusal: `Nexus could not tell whether ${who} runs (its times were not read).` }
  const end = timeOf(endAt, 'when it ends (endAt)')
  if (typeof end !== 'number') return end
  if (end < now + END_MIN_AHEAD_SECONDS) return { refusal: `endAt is ${isoOf(end)}: Meta takes only a future end, so it is at least 2 minutes from now (e.g. ${isoOf(now + END_SUGGESTED_AHEAD_SECONDS)}, 15 minutes from now). An approval that came later than the end asked: ask again.` }
  if (end > now + END_MAX_AHEAD_SECONDS) return { refusal: 'endAt is within a day from now: to end a test later, set-meta-experiment endTime.' }
  if (end >= study.endTime) return { refusal: `${who} ends at ${isoOf(study.endTime)} already: endAt is earlier than that (set-meta-experiment endTime moves an end later).` }
  const params: Record<string, string> = { end_time: String(end) }
  if (study.type === 'SPLIT_TEST_V2') params.observation_end_time = String(end)
  const lines: Array<[string, unknown, unknown]> = [['End', isoOf(study.endTime), isoOf(end)]]
  if (params.observation_end_time) lines.push(['Observation end', study.observationEndTime ? isoOf(study.observationEndTime) : 'none', isoOf(end)])
  const warnings = [
    'Meta documents no cancel: it takes only a FUTURE end, so Nexus moves the end to the time named (soon). Whether Meta takes an earlier end than the one set is not proven yet (LIVE-PROBES EX-023): its answer decides, in its words.',
    'The results of a test cut short are weaker: fewer people, fewer conversions, a lower confidence.',
    'Its campaigns, ad sets and ads keep running as they are set after the test ends: pause them with set-meta-status if they should stop.',
  ]
  if (study.type === 'LIFT') warnings.push(`A lift study keeps counting conversions until its observation end (${study.observationEndTime ? isoOf(study.observationEndTime) : 'none set'}); set-meta-experiment observationEndTime can move it.`)
  warnings.push('No undo once the new end has passed (a study cannot be restarted or deleted); until then set-meta-experiment endTime can move the end later again.')
  const req: MetaChangeRequest = {
    step: 1, label: `End ${who} early`, kind: 'adset', objectId: study.id, objectKind: 'adstudy', params,
    check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false, operation: 'study.end',
    expect: { ...params }, readBackFields: 'id,name,end_time,observation_end_time',
  }
  const fields = studyFields(study)
  return draftOf(req, lines, warnings, [], { study },
    { kind: 'study', id: study.id, type: study.type, fields: { end_time: fields.end_time, observation_end_time: fields.observation_end_time }, undo: null, noUndo: ['A study cannot be restarted once its end has passed.'] },
    { kind: 'study', id: study.id, type: study.type, fields: { end_time: params.end_time, observation_end_time: params.observation_end_time ?? fields.observation_end_time } })
}
