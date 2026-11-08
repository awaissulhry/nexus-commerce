import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { cutLogOf } from '../../_shared/fixtures'
import { recordCase, RecordDesign, type RecordCase } from '../record/fixtures'
import { dailyFor, YIELD } from '../daily/demo/fixtures'
import type { CutLogW2b } from './api'

/**
 * SCR-071 — the work order's Cutting tab (design wo-cutlog, wo-cutplan; MES-056) with made-up data only: cut against
 * plan, each hide's area bar, the cut log per hide (a closing cut, a corrected entry and its mirror), an entry's detail,
 * the correction (a reason; a closing cut opens its hide again; a cut of a used-up hide that is not its closing one is
 * held with the reason), and the states. Roles: Production manager (corrects), Team leader and Sales (read). B-W2b-130: an
 * entry's detail with the photo of the hide taken at the table and the thickness measured there, an entry without a photo, the
 * photo being read, and a photo that could not be shown or may not be opened.
 */

const ID = (n: number) => `0190f0e2-6161-7000-8000-${String(n).padStart(12, '0')}`
const cutting = (role: Parameters<typeof recordCase>[0], over: Parameters<typeof recordCase>[2] = {}): RecordCase => recordCase(role, 'IN_PROGRESS', { tab: 'cutting', ...over })

// B-W2b-130: entry 3 with the hide's photo (a made-up picture of a hide, no person) and its thickness measured at the table.
const PHOTO = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200" fill="#e9e4dc"/><path d="M40 60 C70 20 130 30 160 22 C200 30 250 18 285 55 C300 95 292 140 270 168 C230 186 180 176 160 182 C120 188 70 184 46 160 C24 130 26 92 40 60 Z" fill="#2b2622"/></svg>')}`
const withPhoto = (): CutLogW2b => {
  const log = cutLogOf()
  return { ...log, entries: log.entries.map((entry) => (entry.id === ID(3) ? { ...entry, photoFileId: ID(90), measuredThicknessMm: '1.20' } : entry)) }
}
const photo = (url: string | null, problem: string | null = null) => ({ entryId: ID(3), url, problem })

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-071',
  title: 'Work order › Cutting (cut log per hide)',
  view: RecordDesign,
  cases: [
    { id: 'log', label: 'Production manager: cut against plan, the hides, the cut log (newest first)', model: cutting('manager'), note: 'Enter on an entry opens it; ⋯ Correct entry… (held with the reason when it may not be corrected).' },
    { id: 'entry', label: 'An entry: pieces per size and part, area, station, who cut it (a site that records workers)', model: cutting('manager', { cutOpen: ID(3) }) },
    { id: 'entry-closing', label: 'The closing cut of a used-up hide: correcting it opens the hide again', model: cutting('manager', { cutOpen: ID(4) }) },
    { id: 'entry-correction', label: 'A correction (the mirror entry), in words', model: cutting('manager', { cutOpen: ID(6) }) },
    { id: 'correct', label: 'Correct an entry: the reason, what it takes back, the bundle rule', model: cutting('manager', { dialog: { kind: 'correct', entryId: ID(3) } }) },
    { id: 'correct-closing', label: 'Correct the closing cut: the hide opens again', model: cutting('manager', { dialog: { kind: 'correct', entryId: ID(4) }, draft: { reason: 'Wrong size typed at the table' } }) },
    { id: 'correct-refused', label: 'Refused: bundles were made from this cut (void them first) — inside the dialog', model: cutting('manager', { dialog: { kind: 'correct', entryId: ID(1) }, draft: { reason: 'Size 48 cut twice' }, dialogProblem: { key: 'refusal.cut.IN_BUNDLE' } }) },
    { id: 'corrected', label: 'After a correction: the notice, the mirror in the log', model: cutting('manager', { notice: { tone: 'success', words: { key: 'notice.corrected' } } }) },
    { id: 'empty', label: 'Not cut yet', model: cutting('manager', { cutLog: { value: cutLogOf('empty'), problem: null } }) },
    { id: 'loading', label: 'Loading the cut log', model: cutting('manager', { cutLog: { value: null, problem: null } }) },
    { id: 'error', label: 'The cut log failed: in words, with Try again', model: cutting('manager', { cutLog: { value: null, problem: 'error.read' } }) },
    { id: 'draft', label: 'A draft: nothing is cut before the release', model: recordCase('manager', 'DRAFT', { tab: 'cutting' }) },
    { id: 'team-leader', label: 'Team leader: reads the log; Correct is held (production.cut.correct)', model: cutting('teamLeader', { cutOpen: ID(3) }) },
    { id: 'sales', label: 'Sales (read-only)', model: cutting('sales') },
    // ---- B-W2a-46: yield (wo-yield) and the cutting list (wo-docs) ----
    // ---- B-W2b-130: the hide photo in an entry's detail (wo-cutlog W2b) ----
    { id: 'w2b-entry-photo', label: 'W2b · An entry: the photo of the hide taken at the table, the thickness measured there', model: cutting('manager', { cutLog: { value: withPhoto(), problem: null }, cutOpen: ID(3), cutPhoto: photo(PHOTO) }), note: 'A picture of the leather only (COL-017). Esc closes.' },
    { id: 'w2b-entry-photo-loading', label: 'W2b · An entry: its photo being read', model: cutting('manager', { cutLog: { value: withPhoto(), problem: null }, cutOpen: ID(3), cutPhoto: photo(null) }) },
    { id: 'w2b-entry-photo-failed', label: 'W2b · An entry: the photo could not be shown', model: cutting('manager', { cutLog: { value: withPhoto(), problem: null }, cutOpen: ID(3), cutPhoto: photo(null, 'error.offline') }) },
    { id: 'w2b-entry-photo-forbidden', label: 'W2b · Team leader without files.read: the photo is not opened, said', model: cutting('teamLeader', { cutLog: { value: withPhoto(), problem: null }, cutOpen: ID(3), cutPhoto: photo(null, 'error.forbidden') }) },
    { id: 'w2b-entry-no-photo', label: 'W2b · An entry cut without a photo (optional at the site)', model: cutting('manager', { cutOpen: ID(2) }) },
    { id: 'w2a-yield', label: 'W2a · Yield: area in, pattern, remnant, waste %; planned vs actual; a bar per hide (never by cutter)', model: cutting('manager'), note: 'Scroll below the cut log: Yield, then Print cutting list.' },
    { id: 'w2a-yield-none', label: 'W2a · Yield before any cut', model: cutting('manager', { daily: dailyFor('manager', 'IN_PROGRESS', { yield: { value: { ...YIELD, hides: [] }, problem: null } }) }) },
    { id: 'w2a-yield-loading', label: 'W2a · Yield loading', model: cutting('manager', { daily: dailyFor('manager', 'IN_PROGRESS', { yield: { value: null, problem: null } }) }) },
    { id: 'w2a-yield-error', label: 'W2a · Yield could not be read (Try again)', model: cutting('manager', { daily: dailyFor('manager', 'IN_PROGRESS', { yield: { value: null, problem: 'problem.read' } }) }) },
    { id: 'w2a-print-cutting', label: 'W2a · Print cutting list: garments per colourway and size, with the parts', model: cutting('manager', { daily: dailyFor('manager', 'IN_PROGRESS', { dialog: { kind: 'print', what: 'cutting' } }) }) },
  ],
})
