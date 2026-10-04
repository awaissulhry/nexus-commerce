/**
 * The sweep's view of the wire: every sheet write the page sends, and the loopback control.
 *
 * A commit must send EXACTLY ONE `POST /api/products/bulk-save` (the sheet's cell write), holding one unit with one
 * change — the field, the value, the target, the intent, the content address and the version the GET gave the row — and
 * the API must answer it saved. A stock cell (Mode / Qty / Buffer, kind `stockControl`) is the Matrix's own cell: its
 * ONE write is `PATCH /api/products/:familyId/studio/matrix` with one cell. A gesture that writes nothing, twice, or
 * something else is the defect.
 */
import { expect, type Page, type Request } from '@playwright/test'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
/** The Matrix door (`MATRIX_ENDPOINTS.write`). */
const MATRIX_WRITE = /\/api\/products\/[^/]+\/studio\/matrix$/

export interface Change { id: string; field: string; value: unknown; target?: string; intent?: string; contentAddress?: unknown }
export interface Unit { key: string; changes: Change[]; marketplaceContexts?: Array<Record<string, unknown>>; expectedVersion?: number }
export interface Save { request: Request; body: { operationId?: string; units: Unit[] }; status: number; answer: { saved: number; failed: number; units: Array<{ key: string; status: number; body: Record<string, unknown> }> } }
/** `MatrixWriteCell` / `MatrixWriteOutcome` (@nexus/shared/matrix-contract), as the wire carries them. */
export interface MatrixCellWrite { rowId: string; coordinateKey: string; cell: string; value: unknown; expectedVersion: number; expectedListingId?: string }
export interface MatrixSave {
  request: Request
  body: { cells: MatrixCellWrite[]; accountId?: string | null }
  status: number
  answer: { results: Array<{ rowId: string; coordinateKey: string; cell: string; outcome: string; reason?: string; version: number }>; version: number } | null
}

export class Wire {
  readonly writes: Request[] = []
  readonly offLoopback: string[] = []

  constructor(page: Page) {
    page.on('request', (request) => {
      const url = new URL(request.url())
      // 🔴 The wire control: nothing this page asks for may leave the machine.
      if (/^https?:$/.test(url.protocol) && !LOOPBACK.has(url.hostname)) this.offLoopback.push(`${request.method()} ${url.origin}${url.pathname}`)
      if (request.method() === 'POST' && /\/api\/products\/bulk-save$/.test(url.pathname)) this.writes.push(request)
      else if (request.method() === 'PATCH' && /\/api\/products\/bulk$/.test(url.pathname)) this.writes.push(request)
      else if (request.method() === 'PATCH' && MATRIX_WRITE.test(url.pathname)) this.writes.push(request)
    })
  }

  mark() { return this.writes.length }

  /** The ONE write sent since `mark`, answered. Fails on none, and on a second one inside the settle window. */
  async one(mark: number, what: string): Promise<Save> {
    return this.answered<Save>(mark, what)
  }

  /** The ONE write sent since `mark` — and it is the Matrix door's, not the bulk route's. */
  async oneMatrix(mark: number, what: string): Promise<MatrixSave> {
    const save = await this.answered<MatrixSave>(mark, what)
    expect(new URL(save.request.url()).pathname, `${what}: a stock cell is written through the Matrix door`).toMatch(MATRIX_WRITE)
    return save
  }

  private async answered<S extends { body: unknown; answer: unknown }>(mark: number, what: string): Promise<{ request: Request; body: S['body']; status: number; answer: S['answer'] }> {
    await expect.poll(() => this.writes.length - mark, { timeout: 15_000, message: `${what}: no write was sent` }).toBeGreaterThanOrEqual(1)
    const request = this.writes[mark]
    const response = await request.response()
    // A second write for one commit (a re-send, a second cell) would arrive right behind the first.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(this.writes.length - mark, `${what}: ${this.writes.length - mark} writes for one commit — ${this.writes.slice(mark).map((w) => w.postData()).join(' ‖ ')}`).toBe(1)
    const body = request.postDataJSON() as S['body']
    const answer = (await response?.json().catch(() => null)) as S['answer']
    return { request, body, status: response?.status() ?? 0, answer }
  }

  /** No write since `mark` (an unchanged commit, an Escape). */
  async none(mark: number, what: string) {
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(this.writes.length - mark, `${what}: wrote ${this.writes.slice(mark).map((w) => w.postData()).join(' ‖ ')}`).toBe(0)
  }

  assertLoopback() {
    expect(this.offLoopback, 'a request left the machine').toEqual([])
  }
}

/** A committed unit can still refuse individual cells. `saved` counts units, not successful cells. */
export function assertSaved(save: Pick<Save, 'status' | 'answer'>, what: string) {
  expect(save.status, `${what}: HTTP status`).toBe(200)
  expect(save.answer, `${what}: save counts`).toMatchObject({ saved: 1, failed: 0 })
  expect(save.answer.units, `${what}: answered units`).toHaveLength(1)
  for (const unit of save.answer.units) {
    expect(unit.status, `${what}: unit status`).toBe(200)
    expect(unit.body.errors ?? [], `${what}: refused cells ${JSON.stringify(unit.body.errors ?? [])}`).toEqual([])
  }
}
