/**
 * P4.5d — the Reports v3 media type, and the parity that outlives it.
 *
 * ## The row, and what the evidence actually says
 *
 * FINAL-PLAN §4.5: *"The client's `fetchReport` sends no v3 content type, while the
 * report service does (:2153)."* True. Both POST to `/reporting/reports`; one sent
 * `application/vnd.createasyncreportrequest.v3+json` and one sent the default
 * `application/json`.
 *
 * 🟡 **It is a drift, not a breakage — measured, not assumed.** 1,197 real
 * `POST /reporting/reports` rows in `OutboundApiCallLog` (development database,
 * 2026-08-05 → 2026-09-08):
 *
 * | status | n | what it proves |
 * |---|---|---|
 * | 200 | 1,135 | accepted |
 * | 400 | 47 | `configuration columns includes invalid values: (__nope__)` — deliberate probes |
 * | 425 | 9 | Amazon's documented "duplicate of <reportId>" dedupe |
 * | 429 | 1 | throttle |
 * | null | 5 | transport |
 *
 * **Zero 415 Unsupported Media Type.** And 10 of the 400s plus all 9 of the 425s were
 * made by `fetchReport` — the builder WITHOUT the media type — which means Amazon read
 * its body, validated the columns and matched it against an existing report. Amazon
 * accepts `application/json` on this endpoint today.
 *
 * So the media type is corrected because Amazon documents it and could enforce it, not
 * because anything is failing. **The part that matters is the parity test**: two
 * builders on one endpoint is exactly how a required header survived missing in one of
 * them for months, and it is the shape `reference_two_column_builders_drift` names.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPORT_V3_MIME } from './ads-api-client.js'

const HERE = import.meta.dirname
const client = readFileSync(join(HERE, 'ads-api-client.ts'), 'utf8')
const service = readFileSync(join(HERE, 'ads-reports.service.ts'), 'utf8')

/** Every line of real code that POSTs to the async reports endpoint. */
function reportCreateBuilders(): Array<{ file: string; src: string }> {
  const out: Array<{ file: string; src: string }> = []
  for (const [file, src] of [['ads-api-client.ts', client], ['ads-reports.service.ts', service]] as const) {
    // The block from the `path: '/reporting/reports'` line to the end of its call.
    let from = 0
    while (true) {
      const at = src.indexOf("path: '/reporting/reports',", from)
      if (at === -1) break
      // Back to the liveCall that owns it, forward to that call's closing `})` at the
      // same indent. A fixed-size window is not safe here: the client's request body
      // is ~1.5 KB of columns on its own, and a window that stops short of the
      // options reads as "no media type" when the truth is "did not look".
      const start = src.lastIndexOf('liveCall', at)
      const close = src.indexOf('\n    })', at)
      out.push({ file, src: src.slice(start, close === -1 ? src.length : close) })
      from = at + 1
    }
  }
  return out
}

describe('report create parity (P4.5d — two builders, one endpoint)', () => {
  it('finds both builders (positive control — an empty census is not a pass)', () => {
    const builders = reportCreateBuilders()
    expect(builders.map((b) => b.file).sort()).toEqual(['ads-api-client.ts', 'ads-reports.service.ts'])
  })

  it('both send the v3 media type, through the SAME constant', () => {
    for (const b of reportCreateBuilders()) {
      expect(b.src, `${b.file} does not send the Reports v3 media type on POST /reporting/reports`)
        .toContain('contentType: REPORT_V3_MIME')
    }
  })

  it('the constant is the media type Amazon documents', () => {
    expect(REPORT_V3_MIME).toBe('application/vnd.createasyncreportrequest.v3+json')
  })

  it('neither builder spells the media type as a literal', () => {
    // One definition. A second literal is how the two drifted in the first place.
    for (const [file, src] of [['ads-api-client.ts', client], ['ads-reports.service.ts', service]] as const) {
      const hits = src.split('\n').filter(
        (l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && l.includes("'application/vnd.createasyncreportrequest"),
      )
      // The client's own `export const` is the single allowed definition.
      const allowed = file === 'ads-api-client.ts' ? 1 : 0
      expect(hits.length, `${file}:\n${hits.join('\n')}`).toBe(allowed)
    }
  })

  it('the poll and the download are NOT given the create media type', () => {
    // `application/vnd.createasyncreportrequest.v3+json` describes the CREATE body.
    // Sending it on the status GET, or on the pre-signed S3 download, is the obvious
    // over-application of this fix.
    const poll = client.slice(client.indexOf('path: `/reporting/reports/${reportId}`'))
    expect(poll.slice(0, 400)).not.toContain('REPORT_V3_MIME')
  })
})
