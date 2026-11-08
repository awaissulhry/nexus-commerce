import { describe, expect, it } from 'vitest'
import { QUEUED_ACTIONS } from '@nexus/factory-domain/floor-sync/kinds'
import { ALLOCATION_REFUSALS, ALLOCATION_WARNINGS } from '@nexus/factory-domain/production/cutorders/allocation'
import { PLY_REFUSALS } from '@nexus/factory-domain/production/cutorders/plies'
import { TICKET_REFUSALS } from '@nexus/factory-domain/production/cutorders/tickets'
import { SECONDARY_REFUSALS } from '@nexus/factory-domain/production/cutissue/secondary'
import { TROLLEY_REFUSALS, TROLLEY_WARNINGS, trolleyCodeProblem } from '@nexus/factory-domain/production/cutissue/trolley'
import { LAY_REFUSALS, LAY_WARNINGS } from '@nexus/factory-domain/production/lays/rules'
import { RECUT_REFUSALS } from '@nexus/factory-domain/production/rework/recut'
import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { TILE_RULES } from '../../model'
import { whatKeyOf } from '../../queue/actions'
import { readScan } from '../../scan/scan-model'
import { FLOOR_NAMESPACES, TASK_ROUTES } from '../routes'
import type { FabricUsed, LayView, Trolley } from './api'
import {
  applyKeptCount,
  applyKeptRoll,
  applyKeptUndo,
  countProblem,
  fabricBody,
  fabricDifference,
  fabricScan,
  fabricStart,
  isKeptRow,
  isTrolleyCode,
  KNOWN_REFUSALS,
  KNOWN_WARNINGS,
  metresText,
  ratioChips,
  rollBody,
  rollDraftOf,
  rollHeld,
  sameCode,
  sendHeld,
  stepOf,
  stepStates,
  toggleMissing,
  trolleyCodeOf,
} from './model'

/**
 * SCR-182's rules (B-W2b-121): the refusal codes of the three APIs it stands on have the screen's words (never the API's English),
 * the steps of a lay, a roll's report as it is sent, the count's hard stop, the fabric used against the estimate, the trolley's label,
 * what a kept write does to the lay on screen, and the tile, page, catalogue and queue words this step adds.
 */

const words = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale]['floor-fabriccut'] ?? {}

describe('the refusals and warnings are worded by the screen', () => {
  it('every rule code of the lays, tickets, ply runs, rolls, recuts, secondary processes and trolleys is known', () => {
    const domain = [...LAY_REFUSALS, ...TICKET_REFUSALS, ...PLY_REFUSALS, ...ALLOCATION_REFUSALS, ...RECUT_REFUSALS, ...SECONDARY_REFUSALS, ...TROLLEY_REFUSALS, 'FLOOR_NOT_READY']
    for (const code of domain) expect(KNOWN_REFUSALS, code).toContain(code)
    expect(new Set(KNOWN_REFUSALS).size).toBe(KNOWN_REFUSALS.length)
    for (const code of [...LAY_WARNINGS, ...ALLOCATION_WARNINGS, ...TROLLEY_WARNINGS]) expect(KNOWN_WARNINGS, code).toContain(code)
  })

  it('each has a message and a fix in Italian and English', () => {
    for (const locale of LOCALES) {
      const catalogue = words(locale)
      for (const code of KNOWN_REFUSALS) {
        expect(catalogue[`refusal.${code}.message`], `${locale} ${code}`).toBeTruthy()
        expect(catalogue[`refusal.${code}.fix`], `${locale} ${code}`).toBeTruthy()
      }
      for (const code of KNOWN_WARNINGS) expect(catalogue[`warning.${code}`], `${locale} ${code}`).toBeTruthy()
    }
  })
})

describe('the tile, the page and the words this step adds', () => {
  it('Fabric cutting is a built tile at the cutting table after Cut a hide, asking production.cut; its page and catalogue load', () => {
    const keys = TILE_RULES.map((rule) => rule.key)
    expect(keys.indexOf('fabriccut')).toBe(keys.indexOf('cut') + 1)
    expect(TILE_RULES.find((rule) => rule.key === 'fabriccut')).toMatchObject({ permission: 'production.cut', modes: ['cutting'], built: true, takesScans: true })
    expect(TASK_ROUTES.fabriccut).toBe('/floor/fabriccut')
    expect(FLOOR_NAMESPACES).toContain('floor-fabriccut')
    for (const locale of LOCALES) {
      expect(CATALOGUE[locale].floor?.['tile.fabriccut'], locale).toBeTruthy()
      expect(CATALOGUE[locale].floor?.['tile.hint.fabriccut'], locale).toBeTruthy()
    }
  })

  it('the seven queue kinds of the table and the trolleys have their own words on Waiting to send', () => {
    const kinds = ['production.lay.roll', 'production.lay.undo', 'production.lay.count', 'production.trolley.load', 'production.trolley.unload', 'production.trolley.send', 'production.trolley.receive'] as const
    for (const kind of kinds) {
      expect(QUEUED_ACTIONS[kind], kind).toBeTruthy()
      const key = whatKeyOf(kind)
      expect(key, kind).not.toBe('other')
      for (const locale of LOCALES) expect(CATALOGUE[locale].floor?.[`sync.what.${key}`], `${locale} ${kind}`).toBeTruthy()
    }
  })
})

describe('the steps of a lay', () => {
  it('an open ticket starts, a started one spreads until counted, a checked one is cut, a done one numbers its plies', () => {
    expect(stepOf('OPEN', 'PLANNED')).toBe('start')
    expect(stepOf('STARTED', 'PLANNED')).toBe('spread')
    expect(stepOf('STARTED', 'SPREADING')).toBe('spread')
    expect(stepOf('STARTED', 'CHECKED')).toBe('cut')
    expect(stepOf('DONE', 'CUT')).toBe('stickers')
    expect(stepOf('VOID', 'PLANNED')).toBeNull()
    expect(stepOf('STARTED', 'CANCELLED')).toBeNull()
    expect(stepStates('cut').map((entry) => entry.state)).toEqual(['done', 'done', 'done', 'now', 'todo', 'todo'])
  })

  it('reads the ratio as size chips', () => {
    expect(ratioChips('46:1 · 48:2 · 50:2 · 52:1')).toEqual([
      { size: '46', ratio: 1 },
      { size: '48', ratio: 2 },
      { size: '50', ratio: 2 },
      { size: '52', ratio: 1 },
    ])
    expect(ratioChips(null)).toEqual([])
    expect(ratioChips('XL:3')).toEqual([{ size: 'XL', ratio: 3 }])
  })

  it('reads a cut ticket\'s number as the code it is, though it looks like a carton label; a roll or a bundle stays a label', () => {
    const TAG = tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10')
    const scanned = (raw: string) => {
      const read = readScan(raw, TAG)
      if (read.kind === 'badge') throw new Error('badge')
      return fabricScan(read, raw)
    }
    for (let n = 1; n <= 40; n++) {
      const number = `CTA-2026-${String(n).padStart(5, '0')}`
      expect(scanned(number), number).toMatchObject({ code: number, label: null, misread: false, ticketLike: true })
    }
    const carton = formatScanId({ type: 'CARTON', tenantTag: TAG, ref: 77 })
    expect(scanned(carton)).toMatchObject({ code: carton, label: null, ticketLike: true })
    expect(scanned(formatScanId({ type: 'ROLL', tenantTag: TAG, ref: 9 }))).toMatchObject({ label: 'roll', ticketLike: false })
    expect(scanned(formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 9 }))).toMatchObject({ label: 'bundle', ticketLike: false })
    expect(scanned('T-3')).toMatchObject({ code: 'T-3', label: null, ticketLike: false })
  })

  it('knows the same ticket scanned again, whatever its case or spaces', () => {
    expect(sameCode(' cta-2026-00031 ', 'CTA-2026-00031')).toBe(true)
    expect(sameCode('CTA-2026-00032', 'CTA-2026-00031')).toBe(false)
  })
})

describe('one roll of the lay report', () => {
  it('starts at what the lay still needs and sends only what the cutter said (plies untouched: as far as the roll goes)', () => {
    const draft = rollDraftOf('RL-AB-0001-X', 6)
    expect(draft).toMatchObject({ plies: 6, pliesTouched: false, splices: 0, endLoss: null })
    expect(rollBody(draft)).toEqual({ code: 'RL-AB-0001-X' })
    expect(rollBody({ ...draft, plies: 4, pliesTouched: true, splices: 1, endLoss: 0.3, endReturned: 12.25 })).toEqual({ code: 'RL-AB-0001-X', plies: 4, splices: 1, endLoss: '0.3', endReturned: '12.25', uom: 'M' })
    expect(rollDraftOf('RL-AB-0001-X', 0).plies).toBeNull()
  })

  it('a roll the lay already has starts at its row (in metres), so the scan confirms or corrects it', () => {
    const draft = rollDraftOf('RL-AB-0001-X', 0, { plies: 6, splices: 1, endLoss: '30', endReturned: '0', uom: 'CM' })
    expect(draft).toMatchObject({ plies: 6, pliesTouched: true, splices: 1, endLoss: 0.3, endReturned: null })
    expect(rollBody(draft)).toEqual({ code: 'RL-AB-0001-X', plies: 6, splices: 1, endLoss: '0.3', uom: 'M' })
    expect(rollHeld(draft, 0)).toBeNull()
  })

  it('holds Add roll with a pad cleared, or when the lay has every ply and the plies were not typed', () => {
    const draft = rollDraftOf('R', 2)
    expect(rollHeld(draft, 2)).toBeNull()
    expect(rollHeld({ ...draft, plies: null, pliesTouched: true }, 2)).toBe('plies')
    expect(rollHeld(rollDraftOf('R', 0), 0)).toBe('full')
    expect(rollHeld({ ...rollDraftOf('R', 0), plies: 2, pliesTouched: true }, 0)).toBeNull()
  })

  it('writes metres as the API takes them', () => {
    expect(metresText(0.3)).toBe('0.3')
    expect(metresText(12)).toBe('12')
    expect(metresText(1.23456)).toBe('1.235')
    expect(metresText(0)).toBe('0')
  })
})

describe('the count at both ends (any difference stops the cut)', () => {
  it('stops a difference before it is sent, and waits for both numbers', () => {
    expect(countProblem({ left: 24, right: 23 }, 24)).toBe('differ')
    expect(countProblem({ left: 24, right: 24 }, 24)).toBeNull()
    expect(countProblem({ left: null, right: 24 }, 24)).toBe('empty')
    expect(countProblem({ left: 1, right: 1 }, 0)).toBe('nothing')
    // Equal ends that differ from the plies spread go to the office, which refuses them in words (COUNT_NOT_SPREAD).
    expect(countProblem({ left: 23, right: 23 }, 24)).toBeNull()
  })
})

describe('fabric used against the estimate', () => {
  const used = (extra: Partial<FabricUsed> = {}): FabricUsed => ({ posted: false, uom: 'M', plies: 24, estimated: '76.8000', recorded: '77.4000', confirmed: null, confirmedAt: null, ...extra })

  it('starts at the confirmed figure, else the lay report', () => {
    expect(fabricStart(used())).toBe(77.4)
    expect(fabricStart(used({ posted: true, confirmed: '76.9500' }))).toBe(76.95)
  })

  it('says more or less by metres and per cent', () => {
    expect(fabricDifference(77.4, '76.8000')).toEqual({ kind: 'more', metres: 0.6, percent: 1 })
    expect(fabricDifference(72.96, '76.8000')).toEqual({ kind: 'less', metres: 3.84, percent: 5 })
    expect(fabricDifference(76.8, '76.8000').kind).toBe('same')
  })

  it('confirms the lay report with an empty body the first time, sends a typed figure, and nothing when posted with it', () => {
    expect(fabricBody(77.4, used())).toEqual({})
    expect(fabricBody(76.5, used())).toEqual({ confirmed: '76.5', uom: 'M' })
    expect(fabricBody(77.4, used({ posted: true, confirmed: '77.4000' }))).toBeNull()
    expect(fabricBody(77, used({ posted: true, confirmed: '77.4000' }))).toEqual({ confirmed: '77', uom: 'M' })
  })
})

describe('trolleys to sewing', () => {
  it('reads a label as the API does (factory-domain trolleyCodeProblem)', () => {
    for (const code of ['t-3', 'T-3', 'TR/12', 'A.B_C-1', ' t9 ', 'T 3', '-T3', '', 'X'.repeat(21), 'T3É']) {
      expect(isTrolleyCode(code), code).toBe(trolleyCodeProblem(trolleyCodeOf(code)) === null)
    }
  })

  it('names a bundle missing or found with one tap; Send waits for a bundle', () => {
    expect(toggleMissing([], 'B1')).toEqual(['B1'])
    expect(toggleMissing(['B1', 'B2'], 'B1')).toEqual(['B2'])
    const empty = { counts: { bundles: 0, received: 0, missing: 0 } } as Trolley
    expect(sendHeld(null, 0)).toBe('empty')
    expect(sendHeld(empty, 1)).toBeNull()
    expect(sendHeld({ ...empty, counts: { bundles: 3, received: 0, missing: 0 } }, 0)).toBeNull()
  })
})

describe('a write kept on the tablet moves the lay on screen', () => {
  const view: LayView = {
    lay: { id: 'lay-1', seq: 1, of: 2, plies: 24, status: 'SPREADING', plyMetres: '3.2000', counted: null, cutAt: null, version: 3 },
    cutOrder: { id: 'co', number: 'CO-1', ratio: '46:1', garmentsPerPly: 1 },
    ticket: null,
    rolls: [{ id: 'lr-1', seq: 10, code: 'R1', lotCode: 'L', plies: 14, splices: 0, endLoss: '0', endReturned: '0', uom: 'M', used: '44.8', shade: 'A' }],
    spread: { plies: 14, rolls: 1, needed: 10, used: '44.8' },
    fabricUsed: null,
    refusal: null,
    can: { spread: true, count: true, fabricUsed: false },
  }

  it('a kept roll adds a row (as needed: what the lay still needs) and moves the sums; a roll of the lay again replaces its row', () => {
    const kept = applyKeptRoll(view, rollDraftOf('R2', 10))
    expect(kept.rolls).toHaveLength(2)
    expect(isKeptRow(kept.rolls[1]!.id)).toBe(true)
    expect(kept.spread).toMatchObject({ plies: 24, rolls: 2, needed: 0 })
    const corrected = applyKeptRoll(view, { ...rollDraftOf('R1', 10), plies: 12, pliesTouched: true })
    expect(corrected.rolls).toHaveLength(1)
    expect(corrected.spread).toMatchObject({ plies: 12, needed: 12 })
  })

  it('a kept Undo takes the last roll off; a kept count checks the lay; a roll after the count spreads it again', () => {
    expect(applyKeptUndo(view).spread).toMatchObject({ plies: 0, rolls: 0, needed: 24 })
    const checked = applyKeptCount(view, { left: 14, right: 14 }, '2026-11-08T09:00:00.000Z')
    expect(checked.lay).toMatchObject({ status: 'CHECKED', counted: { left: 14, right: 14 } })
    expect(applyKeptRoll(checked, rollDraftOf('R2', 10)).lay).toMatchObject({ status: 'SPREADING', counted: null })
  })
})
