/**
 * The sweep's view of the wire: every sheet write the page sends, and the loopback control.
 *
 * A commit must send EXACTLY ONE `POST /api/products/bulk-save` (the sheet's only cell write), holding one unit with one
 * change — the field, the value, the target, the intent, the content address and the version the GET gave the row — and
 * the API must answer it saved. A gesture that writes nothing, twice, or something else is the defect.
 */
import { expect, type Page, type Request } from '@playwright/test'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

export interface Change { id: string; field: string; value: unknown; target?: string; intent?: string; contentAddress?: unknown }
export interface Unit { key: string; changes: Change[]; marketplaceContexts?: Array<Record<string, unknown>>; expectedVersion?: number }
export interface Save { request: Request; body: { operationId?: string; units: Unit[] }; status: number; answer: { saved: number; failed: number; units: Array<{ key: string; status: number; body: Record<string, unknown> }> } }

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
    })
  }

  mark() { return this.writes.length }

  /** The ONE write sent since `mark`, answered. Fails on none, and on a second one inside the settle window. */
  async one(mark: number, what: string): Promise<Save> {
    await expect.poll(() => this.writes.length - mark, { timeout: 15_000, message: `${what}: no write was sent` }).toBeGreaterThanOrEqual(1)
    const request = this.writes[mark]
    const response = await request.response()
    // A second write for one commit (a re-send, a second cell) would arrive right behind the first.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(this.writes.length - mark, `${what}: ${this.writes.length - mark} writes for one commit — ${this.writes.slice(mark).map((w) => w.postData()).join(' ‖ ')}`).toBe(1)
    const body = request.postDataJSON() as Save['body']
    const answer = (await response?.json().catch(() => null)) as Save['answer']
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
