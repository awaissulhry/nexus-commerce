#!/usr/bin/env node
/**
 * P4.4a — the market→currency ratchet.
 *
 * ONE fact — which currency a market prices in — lives in `Marketplace.currency`
 * and is read through `services/pim/market-currency.ts`. Before P4.4a it was
 * re-implemented in EIGHT places, including two functions with the identical
 * name `currencyForMarket` in two different files, neither importing the other.
 * They agreed on EUR and GBP and disagreed on everything else, so a price pushed
 * to Amazon Poland (PLN), Sweden (SEK) or Turkey (TRY) carried EUR — and Amazon
 * reports that as a success.
 *
 * This gate fails when a new one appears.
 *
 * 🔴 It carries a POSITIVE CONTROL. A pattern-based gate that finds nothing is
 * indistinguishable from a broken one: "could not measure" reads exactly like
 * "measured clean". So before it reports a pass it runs its own detector over
 * synthetic lines it knows are violations, and fails loudly if the detector
 * misses them.
 */
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const ROOT = new URL('../src/', import.meta.url).pathname
// The accessor itself, and the docs that quote the old shapes, are the only
// places these patterns may appear.
const ALLOWED = [
  { file: 'services/pim/market-currency.ts', why: 'the accessor itself' },
  {
    // A-53: the seed list moved out of `routes/marketplaces.routes.ts` into the one catalogue that every
    // Marketplace writer reads (business creation, the create-only seed route, the backfill migration).
    file: 'services/pim/market-catalogue.ts',
    why: 'the SEED catalogue that WRITES Marketplace rows — it is the authority\'s source, not a reader of it',
    // The reason is checked, not just asserted: the seed must actually carry the
    // non-euro markets, or it is not the authority it claims to be.
    requires: (text) => /code: 'SE'[^\n]*currency: 'SEK'/.test(text) && /code: 'PL'[^\n]*currency: 'PLN'/.test(text) && /code: 'TR'[^\n]*currency: 'TRY'/.test(text),
  },
  {
    file: 'services/ai/listing-content.service.ts',
    why: 'a JSON example inside an AI prompt template — it decides nothing',
    requires: (text) => /"recommendedPrice"/.test(text) && !/marketCurrency/.test(text),
  },
]

const CUR = `(?:EUR|GBP|USD|SEK|PLN|TRY|CHF|CZK|DKK|NOK|HUF|JPY|CAD|AUD|MXN)`
// A market code, with or without a channel prefix (`EBAY_GB`).
const MKT = `(?:[A-Z]+_)?(?:IT|DE|FR|ES|UK|GB|NL|BE|IE|PL|SE|TR|US|AT|CH|JP|CA|MX|AU)`
/** A conditional on a market code that yields a currency literal, within 3 lines. */
const CONDITIONAL = new RegExp(`['"\`]${MKT}['"\`][\\s\\S]{0,120}?['"\`]${CUR}['"\`]`)
/** A map literal from a market code to a currency literal. */
const MAP = new RegExp(`\\b${MKT}\\s*:\\s*['"\`]${CUR}['"\`]`)

function violationsIn(text) {
  // Comments are stripped: this gate's own explanations quote the old code, and
  // so do the replacement comments left where each copy used to live.
  const lines = text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
  const out = []
  lines.forEach((line, i) => {
    const window = lines.slice(i, i + 3).join('\n')
    if (MAP.test(line) || CONDITIONAL.test(window)) out.push({ line: i + 1, text: lines[i].trim().slice(0, 110) })
  })
  // One report per contiguous run.
  return out.filter((h, i) => i === 0 || h.line - out[i - 1].line > 2)
}

// ── the positive control, before any verdict ────────────────────────────────
const CONTROLS = [
  [`const c = mp === 'UK' ? 'GBP' : 'EUR'`, 'a UK ternary'],
  [`const M: Record<string,string> = { IT: 'EUR', UK: 'GBP' }`, 'a market→currency map'],
  [`return marketplaceId === "EBAY_GB" ? "GBP" : "EUR";`, 'a channel-prefixed code'],
  [`if (m === 'UK' || m === 'GB')\n  return 'GBP'`, 'a two-line conditional'],
]
for (const [sample, what] of CONTROLS) {
  if (violationsIn(sample).length === 0) {
    console.error(`❌ market-currency gate: its own detector missed ${what}. The gate is broken, not the tree.`)
    process.exit(2)
  }
}
// And the negative control: the replacement shape must NOT trip it.
if (violationsIn(`const currency = await marketCurrency('EBAY', mp)`).length > 0) {
  console.error('❌ market-currency gate: the detector flags the accessor itself.')
  process.exit(2)
}

// ── the tree ────────────────────────────────────────────────────────────────
const files = execSync(`/usr/bin/find ${ROOT} -name '*.ts'`, { encoding: 'utf8' })
  .split('\n').filter(Boolean).filter((f) => !/\.test\.ts$|vitest/.test(f))
if (files.length < 500) {
  console.error(`❌ market-currency gate: only ${files.length} files found — the scan did not run.`)
  process.exit(2)
}

const found = []
for (const file of files) {
  const rel = file.slice(ROOT.length)
  const exempt = ALLOWED.find((a) => (a.file ?? a) === rel)
  if (exempt) {
    // 🔴 Each exemption's REASON is checked. An exemption whose reason has gone
    // stale is a hole in the gate, and a stale one reads exactly like a valid one.
    if (exempt.requires && !exempt.requires(readFileSync(file, 'utf8'))) {
      console.error(`❌ market-currency: the exemption for ${rel} is STALE.`)
      console.error(`   Its written reason — "${exempt.why}" — no longer holds. Re-check it before widening the gate.`)
      process.exit(1)
    }
    continue
  }
  for (const hit of violationsIn(readFileSync(file, 'utf8'))) found.push({ rel, ...hit })
}

if (found.length > 0) {
  console.error(`❌ market-currency: ${found.length} market→currency decision(s) outside services/pim/market-currency.ts\n`)
  for (const f of found) console.error(`  apps/api/src/${f.rel}:${f.line}  ${f.text}`)
  console.error(`\n  Which currency a market prices in is Marketplace.currency, read through`)
  console.error(`  marketCurrency() / marketCurrencyAcrossChannels(). Deriving it from the market`)
  console.error(`  code prices Poland, Sweden and Turkey in euros, and no channel reports that.`)
  process.exit(1)
}
console.log(`✓ market-currency: one accessor, ${files.length} files scanned, 0 market→currency decisions outside it (${ALLOWED.length} exemptions, each reason checked; 4 detector controls passed)`)
