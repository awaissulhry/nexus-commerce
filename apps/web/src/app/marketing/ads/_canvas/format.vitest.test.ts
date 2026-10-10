/**
 * AM-30 — one rendering per metric on every ads screen, at the Ad Manager's precision: money €1,234.56, ACoS 38.02 %,
 * ROAS 2.31. The same campaign read €1,234 on the Dashboard, 38 % / 3.8 % on Portfolios, "2.3×" on Mission Control and
 * 38.5 % / 2.3 in the report runner, beside the grid's €1,234.56 / 38.50 % / 2.30.
 */
import { describe, expect, it } from 'vitest'
import { eur, eur2, pct, roas } from './format'
import { eur as gridEur, pct as gridPct, roasText } from '../campaigns/_grid/format'
import { formatCell } from '../reporting/report-api'
import { money, pct as businessPct } from '../reporting/business-api'
import { eurC, pctP } from '../ebay/_lib/format'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

describe('money', () => {
  it('is two decimals with thousands separated, everywhere', () => {
    expect(eur(1234.56)).toBe('€1,234.56') // the Dashboard / Portfolios printed €1,235
    expect(eur(1234)).toBe('€1,234.00')
    expect(eur2(1234.5)).toBe(eur(1234.5))
    expect(eur(1234.5)).toBe(gridEur(1234.5))
    expect(formatCell(1234.5, 'money', 'EUR')).toBe('€1,234.50')
    expect(money(1234.5)).toBe('€1,234.50') // the business context panel printed €1,235
  })
  it('no value is a dash, never €0', () => {
    expect(eur(undefined)).toBe('—')
    expect(eur(Number.NaN)).toBe('—')
  })
})

describe('ACoS and other percents (a FRACTION in)', () => {
  it('two decimals, everywhere', () => {
    expect(pct(0.3802)).toBe('38.02%') // Portfolios printed 38%
    expect(pct(0.038)).toBe('3.80%') // …and 3.8%
    expect(pct(0.385)).toBe(gridPct(0.385))
    expect(formatCell(0.385, 'pct', 'EUR')).toBe('38.50%') // the runner printed 38.5%
    expect(formatCell(0.00002, 'pct', 'EUR')).toBe('<0.01%') // a tiny share, never a rounded 0.00%
    expect(businessPct(0.385)).toBe('38.50%') // the business context panel printed 38.5%
  })
  it('no value is a dash', () => {
    expect(pct(undefined)).toBe('—')
    expect(businessPct(null)).toBe('—')
  })
})

describe('ROAS', () => {
  it('two decimals and no suffix, as in the Ad Manager', () => {
    expect(roas(2.3)).toBe('2.30') // the Dashboard printed 2.3×
    expect(roas(2.314)).toBe('2.31')
    expect(roasText(2.3)).toBe('2.30')
    expect(formatCell(2.3, 'ratio', 'EUR')).toBe('2.30') // the runner printed 2.3
  })
  it('no value is a dash', () => {
    expect(roas(undefined)).toBe('—')
    expect(roasText(null)).toBe('—')
    expect(roasText('')).toBe('—')
  })
})

describe('eBay screens use the same rendering (AM-30)', () => {
  it('money has the thousands separator; percent points read with 2 decimals', () => {
    expect(eurC(123456)).toBe('€1,234.56')
    expect(eurC(null)).toBe('—')
    expect(pctP(38.5)).toBe('38.50%') // was "38.5%" (1 decimal)
    expect(pctP(150)).toBe('150.00%')
    expect(pctP(null)).toBe('—')
  })
})

describe('no hand-built euro string without a thousands separator (AM-30)', () => {
  const ADS = fileURLToPath(new URL('..', import.meta.url))
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (/\.tsx?$/.test(p) && !p.includes('.vitest.')) out.push(p)
    }
    return out
  }
  // "€" followed by cents ÷ 100 printed with toFixed(2): €1234.56 instead of €1,234.56.
  const HAND_BUILT = /€\$?\{\(?[^}]*\/ 100\)?\.toFixed\(2\)\}/

  it.each(['_shared', 'analytics', 'ebay', 'portfolios', 'suggestions'])('%s renders money through the shared formatter', (dir) => {
    const offenders = walk(join(ADS, dir)).filter((f) => HAND_BUILT.test(readFileSync(f, 'utf8'))).map((f) => f.slice(ADS.length))
    expect(offenders).toEqual([])
  })
})

