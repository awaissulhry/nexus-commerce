import { describe, expect, it } from 'vitest'
import type { MappingDiff, MappingFieldRow, MappingSetSummary } from '@nexus/shared/channel-mapping'
import {
  changedKeys, decisionBody, decisionSentence, DIRECTION_WORD, exportBlocker, exportSummarySentence, filenameFromDisposition,
  filterCounts, filterRows, filterSets, formLabel, groupByForm, initialDraft, isLocked, marketsOf, matchesSearch,
  needsTemplateUpload, pageOf, parseExportSummary, parseSkus, requirementWord, sharedTarget, siblingsOf, stateTone,
  targetLabel, templateResultSentence, transformSummary, useCount, versionName,
} from './model'
import { fileSetHref, mappingViewHref, readMappingView } from './urls'

const counts = { fields: 0, mapped: 0, ignored: 0, managed: 0, unmapped: 0, requiredUnmapped: 0, conditionalUnmapped: 0 }
const set = (over: Partial<MappingSetSummary>): MappingSetSummary => ({
  id: 'x', channel: 'AMAZON', marketplace: 'IT', formKind: 'AMAZON_TEMPLATE', formKey: 'COAT', templateIdentifier: null,
  templateVersion: '2026.0713', language: 'it_IT', layout: null, keyFingerprint: 'f', version: 1, status: 'DRAFT', basedOnId: null,
  source: 'FILE', notes: null, createdAt: '2026-09-26T10:00:00.000Z', activatedAt: null, retiredAt: null, counts, ...over,
})
const row = (over: Partial<MappingFieldRow>): MappingFieldRow => ({
  channelKey: 'item_name[language_tag=it_IT]#1.value', columnKey: null, label: 'Nome dell’articolo', aliases: [], productTypes: [],
  requirement: 'required', templateRequirement: null, targetKind: 'channelField', targetKey: 'item_name', transform: [],
  direction: 'both', state: 'mapped', reason: null, decidedBy: 'rule', sortOrder: 0, ...over,
})

describe('words', () => {
  it('names a form by channel, market and form', () => {
    expect(formLabel(set({ formKey: 'COAT+PANTS' }))).toBe('Amazon IT · COAT + PANTS template')
    expect(formLabel(set({ formKind: 'AMAZON_FLAT_FILE' }))).toBe('Amazon IT · COAT flat file (old format)')
    expect(formLabel(set({ channel: 'EBAY', formKind: 'EBAY_WORKBOOK', formKey: '177104' }))).toBe('eBay IT · category 177104 workbook')
  })

  it('says every requirement in plain words, and says so when the channel states none', () => {
    expect(['required', 'requiredIfRelevant', 'bestPractice', 'optional', null].map(requirementWord))
      .toEqual(['Required', 'Required if relevant', 'Best practice', 'Optional', 'Not stated'])
  })

  it('names the target the way the screen shows it', () => {
    expect(targetLabel(row({}))).toBe('Channel field · item_name')
    expect(targetLabel(row({ targetKind: 'itemSpecific', targetKey: 'team name' }))).toBe('Item specific · team name')
    expect(targetLabel(row({ targetKind: 'price', targetKey: null }))).toBe('Price door')
    expect(targetLabel(row({ targetKind: 'quantity', state: 'managed' }))).toBe('Managed · quantity')
    expect(targetLabel(row({ targetKind: 'channelField', state: 'managed', targetKey: null }))).toBe('Managed elsewhere')
    expect(targetLabel(row({ targetKind: 'none', state: 'ignored', targetKey: null }))).toBe('No target')
    expect(targetLabel(row({ targetKind: 'productType' }), 'EBAY')).toBe('Category')
  })

  it('summarises transforms in order', () => {
    expect(transformSummary([{ op: 'dictionary' }, { op: 'list', slot: 2 }])).toBe('dictionary · list slot 2')
    expect(transformSummary([{ op: 'measure', part: 'unit' }])).toBe('measure unit')
    expect(transformSummary([{ op: 'list', join: ', ' }])).toBe('list joined by “, ”')
    expect(transformSummary([])).toBe('')
  })

  it('marks an open or ignored REQUIRED column as the danger tone, and only that', () => {
    expect(stateTone(row({ state: 'unmapped' }))).toBe('danger')
    expect(stateTone(row({ state: 'ignored' }))).toBe('danger')
    expect(stateTone(row({ state: 'unmapped', requirement: 'optional' }))).toBe('warning')
    expect(stateTone(row({ state: 'mapped' }))).toBe('success')
  })

  it('locks the SKU, product-type and action columns only', () => {
    expect(['identity', 'productType', 'recordAction', 'channelField', 'price'].map(k => isLocked({ targetKind: k as MappingFieldRow['targetKind'] })))
      .toEqual([true, true, true, false, false])
  })
})

describe('versions', () => {
  const sets = [
    set({ id: 'a1', version: 1, status: 'RETIRED' }),
    set({ id: 'a3', version: 3 }),
    set({ id: 'a2', version: 2, status: 'ACTIVE' }),
    set({ id: 'd1', marketplace: 'DE' }),
    set({ id: 'e1', channel: 'EBAY', formKind: 'EBAY_WORKBOOK', formKey: '177104' }),
  ]

  it('groups by form, newest version first', () => {
    const groups = groupByForm(sets)
    expect(groups.map(g => g.label)).toEqual(['Amazon DE · COAT template', 'Amazon IT · COAT template', 'eBay IT · category 177104 workbook'])
    expect(groups[1].versions.map(v => v.version)).toEqual([3, 2, 1])
  })

  it('filters by channel and market, and lists the markets present', () => {
    expect(filterSets(sets, { channel: 'AMAZON', market: 'DE' }).map(s => s.id)).toEqual(['d1'])
    expect(filterSets(sets, { channel: '', market: '' })).toHaveLength(5)
    expect(marketsOf(sets)).toEqual(['DE', 'IT'])
    expect(marketsOf(sets, 'EBAY')).toEqual(['IT'])
  })

  it('offers only the other versions of the same form to compare with', () => {
    expect(siblingsOf(sets[1], sets).map(s => s.id)).toEqual(['a2', 'a1'])
  })

  it('names a copied-from version briefly within a form and fully across forms', () => {
    expect(versionName(sets[2], sets[1])).toBe('v2')
    expect(versionName(sets[3], sets[1])).toBe('Amazon DE · COAT template v1')
  })
})

describe('column filters', () => {
  const rows = [
    row({ channelKey: 'a', state: 'mapped' }),
    row({ channelKey: 'b', state: 'unmapped', requirement: 'optional' }),
    row({ channelKey: 'c', state: 'ignored', requirement: null, reason: 'Amazon only' }),
    row({ channelKey: 'd', state: 'managed', targetKind: 'quantity', targetKey: null }),
    row({ channelKey: 'e', state: 'unmapped', label: 'Colore', targetKey: null }),
  ]
  const diff: MappingDiff = {
    added: ['e'], removed: ['gone'],
    requirementChanged: [{ channelKey: 'a', from: 'optional', to: 'required' }],
    decisionChanged: [{ channelKey: 'c', from: { state: 'mapped', targetKind: 'channelField', targetKey: 'x' }, to: { state: 'ignored', targetKind: 'none', targetKey: null } }],
  }
  const changed = changedKeys(diff)

  it('counts what each filter keeps', () => {
    expect(filterCounts(rows, changed)).toEqual({ all: 5, unmapped: 2, required: 3, ignored: 1, managed: 1, changed: 3 })
  })

  it('treats added, requirement-changed and decision-changed columns as changed, never removed ones', () => {
    expect([...changed].sort()).toEqual(['a', 'c', 'e'])
    expect(changedKeys(null).size).toBe(0)
  })

  it('searches the key, label and target, case-insensitively', () => {
    expect(filterRows(rows, 'all', 'COLORE', changed).map(r => r.channelKey)).toEqual(['e'])
    expect(filterRows(rows, 'unmapped', 'colore', changed).map(r => r.channelKey)).toEqual(['e'])
    expect(matchesSearch(row({ targetKey: 'item_name' }), 'ITEM_NAME')).toBe(true)
    expect(matchesSearch(row({}), '   ')).toBe(true)
  })

  it('pages rows and clamps the page into range', () => {
    const many = Array.from({ length: 344 }, (_, i) => i)
    expect(pageOf(many, 4, 100)).toMatchObject({ page: 4, pageCount: 4, from: 301, to: 344 })
    expect(pageOf(many, 9, 100).page).toBe(4)
    expect(pageOf([], 1, 100)).toMatchObject({ page: 1, pageCount: 1, from: 0, to: 0 })
  })
})

describe('decisions', () => {
  it('opens on what the column is today', () => {
    expect(initialDraft(row({})).choice).toBe('field')
    expect(initialDraft(row({ targetKind: 'itemSpecific', targetKey: 'team' }))).toMatchObject({ choice: 'specific', specificName: 'team' })
    expect(initialDraft(row({ targetKind: 'price', targetKey: null })).choice).toBe('current')
    expect(initialDraft(row({ state: 'ignored', reason: 'why' }))).toMatchObject({ choice: 'ignored', reason: 'why' })
  })

  it('sends a mapping only with a field, and nothing when nothing changed', () => {
    const r = row({})
    expect(decisionBody(r, { ...initialDraft(r), targetKey: '' })).toEqual({ body: null, problem: 'Choose the field this column maps to.' })
    expect(decisionBody(r, initialDraft(r))).toEqual({ body: null, problem: null })
    expect(decisionBody(r, { ...initialDraft(r), targetKey: 'model_name' }).body)
      .toEqual({ channelKey: r.channelKey, state: 'mapped', targetKind: 'channelField', targetKey: 'model_name', reason: null, direction: 'both' })
  })

  it('refuses an ignore or managed decision without a reason, and trims the reason it sends', () => {
    const r = row({})
    expect(decisionBody(r, { ...initialDraft(r), choice: 'ignored', reason: '  ' }).problem).toMatch(/Say why/)
    expect(decisionBody(r, { ...initialDraft(r), choice: 'managed', reason: ' Stock page ' }).body)
      .toEqual({ channelKey: r.channelKey, state: 'managed', reason: 'Stock page' })
  })

  it('names an item specific and leaves a column unmapped', () => {
    const r = row({ state: 'unmapped', targetKind: 'none', targetKey: null })
    expect(decisionBody(r, { ...initialDraft(r), choice: 'specific', specificName: ' Team ' }).body)
      .toEqual({ channelKey: r.channelKey, state: 'mapped', targetKind: 'itemSpecific', targetKey: 'Team', reason: null, direction: 'both' })
    expect(decisionBody(r, initialDraft(r))).toEqual({ body: null, problem: null })
    expect(decisionBody(row({}), { ...initialDraft(row({})), choice: 'unmapped' }).body).toEqual({ channelKey: row({}).channelKey, state: 'unmapped' })
    expect(decisionBody(row({ targetKind: 'price', targetKey: null }), initialDraft(row({ targetKind: 'price', targetKey: null })))).toEqual({ body: null, problem: null })
  })

  it('says what was saved', () => {
    expect(decisionSentence(row({}), { channelKey: 'k', state: 'mapped', targetKind: 'channelField', targetKey: 'brand' }))
      .toBe('Nome dell’articolo now maps to field brand.')
    expect(decisionSentence(row({ label: null, channelKey: 'k' }), { channelKey: 'k', state: 'ignored', reason: 'x' })).toBe('k is ignored.')
  })
})

describe('direction', () => {
  it('says each direction in the Owner\'s words', () => {
    expect([DIRECTION_WORD.both, DIRECTION_WORD.in, DIRECTION_WORD.out]).toEqual(['Read and write back', 'Read on import only', 'Write on export only'])
  })

  it('sends a direction change alone, with the current state, target and note kept', () => {
    const r = row({ direction: 'in', reason: 'written back into Quellort' })
    expect(decisionBody(r, { ...initialDraft(r), direction: 'both' }).body)
      .toEqual({ channelKey: r.channelKey, state: 'mapped', targetKind: 'channelField', targetKey: 'item_name', reason: 'written back into Quellort', direction: 'both' })
    const door = row({ targetKind: 'price', targetKey: null })
    expect(decisionBody(door, { ...initialDraft(door), direction: 'out' }).body).toEqual({ channelKey: door.channelKey, state: 'mapped', reason: null, direction: 'out' })
    expect(decisionBody(r, initialDraft(r)).body).toBeNull()
  })

  it('names the columns that write a shared field back', () => {
    const fields = [
      row({ channelKey: 'a', targetKey: 'compliance_media', direction: 'both' }),
      row({ channelKey: 'b', targetKey: 'compliance_media', direction: 'in' }),
      row({ channelKey: 'c', targetKey: 'compliance_media', direction: 'in', state: 'ignored' }),
      row({ channelKey: 'd', targetKey: 'other', direction: 'both' }),
    ]
    const shared = sharedTarget(fields, fields[1])
    expect(shared.others.map(f => f.channelKey)).toEqual(['a'])
    expect(shared.writers.map(f => f.channelKey)).toEqual(['a'])
    expect(sharedTarget(fields, fields[0]).writers).toEqual([])
  })

  it('shows the dictionary details', () => {
    expect(transformSummary([{ op: 'dictionary', write: 'code' }, { op: 'list', slot: 1 }])).toBe('dictionary (writes Amazon’s codes) · list slot 1')
    expect(transformSummary([{ op: 'dictionary', prefer: { x_s: 'XS (x_s)', xx_s: 'XXS (xx_s)' } }])).toBe('dictionary (keeps the file’s labels for 2 codes)')
    expect(transformSummary([{ op: 'dictionary', prefer: { x_s: 'XS (x_s)' } }])).toBe('dictionary (keeps the file’s labels for 1 code)')
  })
})

describe('export', () => {
  it('exports only an active template or workbook version', () => {
    expect(exportBlocker({ status: 'ACTIVE', formKind: 'AMAZON_TEMPLATE', version: 3 })).toBeNull()
    expect(exportBlocker({ status: 'ACTIVE', formKind: 'EBAY_WORKBOOK', version: 1 })).toBeNull()
    expect(exportBlocker({ status: 'DRAFT', formKind: 'AMAZON_TEMPLATE', version: 3 })).toBe('Only an active version exports. Activate v3 first.')
    expect(exportBlocker({ status: 'ACTIVE', formKind: 'AMAZON_FLAT_FILE', version: 1 })).toMatch(/flat files are read only/)
  })

  it('reads SKUs one per line or comma separated, each once', () => {
    expect(parseSkus(' GALE-JACKET \nAIREON-JACKET, MOSS-JACKET,,\nGALE-JACKET\n')).toEqual(['GALE-JACKET', 'AIREON-JACKET', 'MOSS-JACKET'])
    expect(parseSkus('  \n ')).toEqual([])
  })

  it('parses the summary header and writes the sentence', () => {
    const header = encodeURIComponent(JSON.stringify({ rows: 12, gaps: 4, blankColumns: 21, mapping: 'Amazon IT · COAT+PANTS · v3 (active)' }))
    const summary = parseExportSummary(header)
    expect(summary).toEqual({ rows: 12, gaps: 4, blankColumns: 21, mapping: 'Amazon IT · COAT+PANTS · v3 (active)' })
    expect(exportSummarySentence(summary!)).toBe('12 rows written with Amazon IT · COAT+PANTS · v3 (active). 4 required cells had no value in Nexus; 21 columns left blank on purpose.')
    expect(exportSummarySentence({ rows: 1, gaps: 1, blankColumns: 1, mapping: 'X' })).toBe('1 row written with X. 1 required cell had no value in Nexus; 1 column left blank on purpose.')
    expect(exportSummarySentence({ rows: 1204, gaps: 0, blankColumns: 2, mapping: 'X' }, n => n.toLocaleString('en-US'))).toMatch(/^1,204 rows/)
  })

  it('refuses a summary it cannot read rather than guess', () => {
    expect(parseExportSummary(null)).toBeNull()
    expect(parseExportSummary('%E0%A4%A')).toBeNull()
    expect(parseExportSummary(encodeURIComponent('{"rows":"12","gaps":0,"blankColumns":0,"mapping":"X"}'))).toBeNull()
    expect(parseExportSummary(encodeURIComponent('{"rows":1,"gaps":0,"blankColumns":0}'))).toBeNull()
  })

  it('reads the file name from Content-Disposition', () => {
    expect(filenameFromDisposition('attachment; filename="GALE IT - Nexus.xlsm"')).toBe('GALE IT - Nexus.xlsm')
    expect(filenameFromDisposition("attachment; filename*=UTF-8''Caf%C3%A9.xlsx")).toBe('Café.xlsx')
    expect(filenameFromDisposition('attachment; filename=plain.xlsx')).toBe('plain.xlsx')
    expect(filenameFromDisposition('attachment')).toBeNull()
    expect(filenameFromDisposition(null)).toBeNull()
  })

  it('offers the upload only for the refusals a template answers', () => {
    expect(needsTemplateUpload('Nexus does not hold the Amazon template of Amazon IT · COAT+PANTS · v3 (active) (template 2026.0713). Upload it once on the Mapping page, then export.')).toBe(true)
    expect(needsTemplateUpload("The stored template's columns differ from X. Upload the template this version was made from.")).toBe(true)
    expect(needsTemplateUpload('The stored file is not an Amazon template. Upload the template again.')).toBe(true)
    expect(needsTemplateUpload('Some requested SKUs are missing or archived; correct the selection before exporting')).toBe(false)
    expect(needsTemplateUpload('Activate version 3 before exporting with it.')).toBe(false)
  })

  it('says what an uploaded template reads with', () => {
    expect(templateResultSentence({ templateVersion: '2026.0715', label: 'Amazon DE · COAT+PANTS · v2 (draft)', created: false }))
      .toBe('Template 2026.0715 stored; it reads with Amazon DE · COAT+PANTS · v2 (draft).')
    expect(templateResultSentence({ templateVersion: null, label: 'L', created: true })).toMatch(/not stated\).*review it before activating/)
  })
})

describe('recent uses', () => {
  it('reads a recorded counter, and says nothing when it was not recorded', () => {
    expect(useCount({ rows: 21, refused: 0 }, 'rows')).toBe(21)
    expect(useCount({ rows: 21, refused: 0 }, 'refused')).toBe(0)
    expect(useCount({ rows: '21' }, 'rows')).toBeNull()
    expect(useCount(null, 'rows')).toBeNull()
  })
})

describe('urls', () => {
  it('switches views keeping the push-rule parameters, and drops the file selection when leaving', () => {
    expect(mappingViewHref('channel=AMAZON&market=IT', 'files')).toBe('/channels/mapping?channel=AMAZON&market=IT&view=files')
    expect(mappingViewHref('channel=AMAZON&view=files&set=abc', 'rules')).toBe('/channels/mapping?channel=AMAZON')
    expect(mappingViewHref('view=files&set=abc', 'rules')).toBe('/channels/mapping')
    expect(readMappingView('files')).toBe('files')
    expect(readMappingView(null)).toBe('rules')
    expect(readMappingView('anything')).toBe('rules')
  })

  it('deep-links one version', () => {
    expect(fileSetHref('view=files', 'abc')).toBe('/channels/mapping?view=files&set=abc')
    expect(fileSetHref('view=files&set=abc', null)).toBe('/channels/mapping?view=files')
  })
})
