/**
 * A8 (XLSM hybrid) — identity round-trip smoke against the REAL Amazon
 * templates on the owner's Desktop (read-only: bytes in memory only).
 *
 * For each file: detect → take the parsed data rows verbatim →
 * rewriteTemplateDataRows(original, rows) → re-detect the output → the
 * re-parsed rows must equal the originals cell-for-cell (headers, labels and
 * settings must survive too). Proves "import(export(x)) = x" on production
 * files, not fixtures.
 *
 * Run: cd apps/api && npx tsx scripts/_xlsm-roundtrip-smoke.mts
 */
import { readFile } from 'node:fs/promises'
import { detectAmazonTemplate, rewriteTemplateDataRows } from '../src/services/amazon/template-workbook.js'

const BASE = '/Users/awais/Desktop/2026/LISTNGS'
const FILES = [
  `${BASE}/JACKETS/AIREON/AMAZON/LISTINGS/IT/AIREON IT - FINAL (upload this)/AIREON IT.xlsm`,
  `${BASE}/JACKETS/AIREON/AMAZON/LISTINGS/DE/AIREON DE - FINAL (upload this)/AIREON DE.xlsm`,
  `${BASE}/JACKETS/AIREON/AMAZON/LISTINGS/ES/AIREON ES - FINAL (upload this)/AIREON ES.xlsm`,
  `${BASE}/JACKETS/AIREON/AMAZON/LISTINGS/FR/AIREON FR - FINAL (upload this)/AIREON FR.xlsm`,
  `${BASE}/SUITS/XAVIA X AAA/AMAZON/LISTINGS/IT/X-RACING IT - FINAL (upload this)/X-RACING IT.xlsm`,
]

let failures = 0
for (const path of FILES) {
  const short = path.split('/').slice(-2).join('/')
  try {
    const bytes = new Uint8Array(await readFile(path))
    const t0 = Date.now()
    const original = await detectAmazonTemplate(bytes)
    if (!original) throw new Error('not detected as Amazon template')

    // Verbatim data rows (drop the synthetic __action key; keep everything else,
    // including localized ::record_action values — the rewriter is verbatim).
    const rows = original.rows.map((r) => {
      const { __action, ...rest } = r as Record<string, string>
      return rest
    })

    const out = await rewriteTemplateDataRows(bytes, rows)
    const reparsed = await detectAmazonTemplate(new Uint8Array(out.bytes))
    if (!reparsed) throw new Error('rewritten output not detected as Amazon template')

    const errs: string[] = []
    if (JSON.stringify(reparsed.headers) !== JSON.stringify(original.headers)) errs.push('headers differ')
    if (JSON.stringify(reparsed.labels) !== JSON.stringify(original.labels)) errs.push('labels differ')
    if (reparsed.meta.templateIdentifier !== original.meta.templateIdentifier) errs.push('templateIdentifier differs')
    if (reparsed.meta.marketplace !== original.meta.marketplace) errs.push('marketplace differs')
    if (reparsed.rows.length !== original.rows.length) {
      errs.push(`row count ${original.rows.length} → ${reparsed.rows.length}`)
    } else {
      let cellDiffs = 0
      for (let i = 0; i < original.rows.length; i++) {
        for (const h of original.headers) {
          const a = (original.rows[i][h] ?? '').trim()
          const b = (reparsed.rows[i][h] ?? '').trim()
          if (a !== b) {
            if (cellDiffs < 3) errs.push(`row ${i} [${h}]: ${JSON.stringify(a)} → ${JSON.stringify(b)}`)
            cellDiffs++
          }
        }
      }
      if (cellDiffs > 0) errs.push(`${cellDiffs} cell diffs total`)
      if (JSON.stringify(reparsed.meta.actions) !== JSON.stringify(original.meta.actions)) {
        errs.push(`actions ${JSON.stringify(original.meta.actions)} → ${JSON.stringify(reparsed.meta.actions)}`)
      }
    }

    const ms = Date.now() - t0
    if (errs.length) {
      failures++
      console.log(`✗ ${short}`)
      for (const e of errs.slice(0, 6)) console.log(`    ${e}`)
    } else {
      console.log(
        `✓ ${short} — ${original.rows.length} rows × ${original.headers.length} cols round-trip identical (${ms}ms, out ${(out.bytes.length / 1024).toFixed(0)}KB)`,
      )
    }
  } catch (err: any) {
    failures++
    console.log(`✗ ${short} — ${err?.message ?? err}`)
  }
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
