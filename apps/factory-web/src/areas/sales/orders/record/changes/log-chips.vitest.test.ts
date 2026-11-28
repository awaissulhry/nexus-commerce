import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ORDER_LOG_ACTIONS } from '@nexus/factory-domain/sales/order-log/faces'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE } from '../../../../../lib/i18n/messages'
import { ORDER_FLOW_NS } from '../flow-words'
import { CHANGES_SECTIONS } from './layout'
import { LOG_CHIPS, logChipCounts, logChipOf, rowsOfChip } from './log-chips'

/**
 * owb-of6 step 2 — the Changes tab (design plan § 5l): Waiting · Can it still change? · Customer's agreement · What changed (the
 * agreement BEFORE the log); What changed = the base's ONE order log with the chips All · Asks · Lines · Dates · Design · Status; a money
 * row never carries an amount for sales (the log's values are words, days, counts, states — never money). Written, not run.
 */

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('owb-of6 step 2: the order of the 4 sections', () => {
  it('Waiting · Can it still change? · Customer\'s agreement · What changed — in the layout and in the tab', () => {
    expect(CHANGES_SECTIONS).toEqual(['waiting', 'freeze', 'confirmation', 'history'])
    const tab = read('./view/ChangesTab.tsx')
    const at = ['<WaitingSection ', '<FreezeSection ', '<AgreementSection ', '<HistorySection '].map((part) => tab.indexOf(part))
    expect(at.every((value) => value > -1)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })
})

describe('owb-of6 step 2: What changed = the ONE order log, with its chips', () => {
  it('each log action has its chip (people and other show under All only); counts and filters', () => {
    expect(LOG_CHIPS).toEqual(['all', 'asks', 'lines', 'dates', 'design', 'status'])
    expect(logChipOf('PROMISE_MOVED')).toBe('dates')
    expect(logChipOf('LINE_CHANGED')).toBe('lines')
    expect(logChipOf('PICTURE_SET')).toBe('design')
    expect(logChipOf('CHANGE_ACCEPTED')).toBe('asks')
    expect(logChipOf('CONFIRMED')).toBe('status')
    expect(logChipOf('PEOPLE_CHANGED')).toBeNull()
    expect(logChipOf('OTHER')).toBeNull()
    for (const action of ORDER_LOG_ACTIONS) expect(() => logChipOf(action), action).not.toThrow()
    const rows = [{ action: 'PROMISE_MOVED' }, { action: 'LINE_CHANGED' }, { action: 'PEOPLE_CHANGED' }]
    expect(logChipCounts(rows)).toMatchObject({ all: 3, dates: 1, lines: 1, design: 0 })
    expect(rowsOfChip(rows, 'dates')).toEqual([{ action: 'PROMISE_MOVED' }])
    expect(rowsOfChip(rows, 'all')).toHaveLength(3)
  })
  it('the section IS the log where the page gives its port (Restore as before… its one door); a design case keeps the revision rows', () => {
    const history = read('./view/HistorySection.tsx')
    expect(history).toContain('if (model.flow?.log) {')
    expect(history).toContain('<WhatChangedLog read={model.flow.log} />')
    expect(read('./view/WhatChangedLog.tsx')).toContain('<ChangeLog model={{ rows, status: state.status, more: state.more, departments, picture: null }}')
  })
  it('a money row has no amount for sales: the log has no money value kind at all (words, days, counts, states, departments, pictures)', () => {
    const model = read('../../../../../lib/change-log/model.ts')
    const kinds = [...model.matchAll(/readonly kind: '([A-Z_]+)'/g)].map((match) => match[1])
    expect(kinds).toEqual(expect.arrayContaining(['LIFE', 'DEPT', 'DATE', 'TEXT', 'COUNT', 'PICTURE']))
    for (const money of ['MONEY', 'AMOUNT', 'PRICE']) expect(kinds, money).not.toContain(money)
  })
  it('every new word in English and Italian', () => {
    const keys = ['log.chipsLabel', 'log.emptyChip', ...LOG_CHIPS.map((chip) => `log.chips.${chip}`)]
    for (const locale of LOCALES) for (const key of keys) expect(CATALOGUE[locale][ORDER_FLOW_NS]?.[key], `${locale} ${key}`).toBeTruthy()
  })
})
