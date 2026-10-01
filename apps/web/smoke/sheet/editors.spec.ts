/**
 * P3 guardrail 1 (2026-09-30) — the product-sheet COMMIT SWEEP.
 *
 * For every scope the seed builds (Shared, eBay · IT, Amazon · IT, Etsy) and every column the sheet contract serves as
 * editable, one value is committed by KEYBOARD, by MOUSE and by PASTE (where the editor takes a paste), each on a row the
 * sweep owns, and each commit must:
 *   · send exactly ONE `bulk-save`, one unit, one change — the cell's own field, target and content address, the value
 *     chosen, intent `set`, the scope's marketplace context and the version the GET gave the row;
 *   · be answered saved (200, `saved: 1, failed: 0`) and show on the cell;
 *   · be STORED: after each gesture, the sheet API must hold its value before a later gesture overwrites it.
 *     A final chunk read also verifies that later edits did not overwrite another cell.
 * The contract test cross-checks the API's columns with the grid's: a writable contract column the grid does not build, or
 * an editable grid column the contract does not name, fails.
 *
 * Columns are split into chunks of about CHUNK (Playwright lists tests before any column is known); each chunk test reads
 * the contract and takes its chunk. A repeated attribute's positions stay in one chunk, so every chunk stands on its own
 * (`chunksOf`). A chunk past the end abstains, and a scope with more chunks than CHUNKS FAILS. CI deals the chunks over
 * separate parts (`SHEET_SWEEP_PART`), each on its own fresh database.
 * Every commit is tried and every failure is reported at the end of its chunk. What the sweep cannot do is said by name:
 * a driver's `abstain` or `{ na }` arm, a pick's `skip`, a driver's `refusedOffline` (the exact write, then the API's own
 * refusal). No failing commit or read-back is excused.
 *
 * Why this exists: the 2026-09-29 defects (Enter and Tab kept the old value, the chevron did nothing, the first typed key
 * was lost, an open list refused a typed value) all live between the key and the wire, where no test looked.
 */
import type { Page } from '@playwright/test'
import { expect, test } from './fixture'
import { DRIVERS, NETWORK_STUBS, PATHS, editorOf, labelledCodes, pickFor, type EditorId, type Path } from './drivers'
import { focusCell, gridLabels, openSheet, readSheet, revealAllColumns, scopeOf, type ApiColumn, type ApiRow, type ScopeName, type SheetRead } from './grid'
import { sheetSeed } from './seed'
import { Wire, assertSaved } from './wire'

const SCOPES: ScopeName[] = ['master', 'EBAY', 'AMAZON', 'ETSY']
const CHUNK = 8
const CHUNKS = 10
/**
 * CI part (2026-10-01): `SHEET_SWEEP_PART=k/n` declares only this part's chunks; unset (a local run), every chunk. The
 * scopes' chunks are dealt in turn — chunk 1 of every scope, then chunk 2 … — so a slow scope spreads over every part: in
 * three contiguous Playwright shards, Amazon's chunks (~6 min each on a CI runner) filled one shard past its time limit.
 */
const PART = (() => {
  const raw = process.env.SHEET_SWEEP_PART
  if (!raw) return null
  const [index, total] = (/^(\d+)\/(\d+)$/.exec(raw) ?? []).slice(1).map(Number)
  if (!(total >= 1 && index >= 1 && index <= total)) throw new Error(`SHEET_SWEEP_PART=${raw}: expected k/n with 1 ≤ k ≤ n`)
  return { index: index - 1, total }
})()
const inPart = (chunk: number, scope: number) => !PART || (chunk * SCOPES.length + scope) % PART.total === PART.index
/** Columns the grid builds itself, beside the contract's. */
const CLIENT_ONLY = [/^progress:/, /^__/, /^productMedia$/, /^slots:/]

const seed = sheetSeed()

interface Target { column: ApiColumn; editor: EditorId; row: ApiRow }

/** The columns this scope sweeps, in contract order, each with the row it owns. Deterministic, so every chunk agrees. */
function targets(read: SheetRead, scope: ScopeName): { swept: Target[]; skipped: string[] } {
  const variations = read.rows.filter((r) => !r.isParent)
  const parent = read.rows.find((r) => r.isParent)
  const swept: Target[] = []
  const skipped: string[] = []
  const columns = read.columns.filter((c) => c.editable && read.rows.some((r) => r.values?.[c.key]?.writable))
  // A repeated attribute's positions (Bullet 1…10, Material 1…3) share ONE row and are written in order: a later position
  // written while an earlier one is empty is stored at the first free position, as the list it is.
  const slotRow = new Map<string, number>()
  columns.forEach((column, i) => {
    const slot = (column as { slot?: { of: string; index: number } }).slot
    const index = slot ? slotRow.get(slot.of) ?? (slotRow.set(slot.of, i), i) : i
    const editor = editorOf(column, scope)
    const driver = DRIVERS[editor]
    if (driver.abstain) { skipped.push(`${column.key} (${editor}): ${driver.abstain}`); return }
    if (editor === 'ChannelCategoryEditor' && !seed.categories[scope]?.sweep) { skipped.push(`${column.key} (${editor}): ${seed.categories[scope]?.reason ?? 'no seeded taxonomy'}`); return }
    const own = variations[index]
    const row = own?.values?.[column.key]?.writable ? own : parent?.values?.[column.key]?.writable ? parent : variations.find((r) => r.values?.[column.key]?.writable)
    if (!row) { skipped.push(`${column.key}: no writable row`); return }
    swept.push({ column, editor, row })
  })
  return { swept, skipped }
}

/**
 * The scope's swept columns in chunks of about CHUNK, in contract order. A repeated attribute's positions share one row and
 * are written in order, so they stay in ONE chunk (a group longer than CHUNK is a chunk of its own): no chunk depends on
 * another chunk's writes, and a CI part can run it on a fresh database.
 */
function chunksOf(swept: Target[]): Target[][] {
  const units: Target[][] = []
  const groups = new Map<string, Target[]>()
  for (const target of swept) {
    const of = (target.column as { slot?: { of: string } }).slot?.of
    const group = of ? groups.get(of) : undefined
    if (group) { group.push(target); continue }
    const unit = [target]
    units.push(unit)
    if (of) groups.set(of, unit)
  }
  const chunks: Target[][] = []
  for (const unit of units) {
    const last = chunks.at(-1)
    if (last && last.length + unit.length <= CHUNK) last.push(...unit)
    else chunks.push([...unit])
  }
  return chunks
}

const versionOf = (row: ApiRow, scope: ScopeName) => (scope === 'master' ? row.version : row.listing?.version ?? row.version)
const stripped = (value: unknown) => JSON.parse(JSON.stringify(value ?? null))

async function stubNetworkReads(page: Page) {
  for (const stub of NETWORK_STUBS) await page.route(stub.url, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stub.body) }))
}

for (const [scopeIndex, scopeName] of SCOPES.entries()) {
  test.describe(`@sheet ${scopeName}`, () => {
    // One scope's chunks in order, in one worker: two saves racing on one database can lose its serialization race (a 503
    // "busy" the sheet does not retry).
    test.describe.configure({ mode: 'default' })
    const scope = scopeOf(seed, scopeName)

    if (inPart(0, scopeIndex)) test(`@sheet ${scopeName} · the grid builds every writable contract column, and no editable column the contract lacks`, async ({ page }) => {
      const wire = new Wire(page)
      await stubNetworkReads(page)
      const read = await readSheet(page, scope, seed.workspace)
      await openSheet(page, scope)
      const grid = await revealAllColumns(page)
      const contract = new Set(read.columns.map((c) => c.key))
      const writable = read.columns.filter((c) => c.editable && read.rows.some((r) => r.values?.[c.key]?.writable)).map((c) => c.key)
      expect(writable.filter((k) => !grid.includes(k)), 'writable in the contract, not on the grid').toEqual([])
      expect(grid.filter((k) => !contract.has(k) && !CLIENT_ONLY.some((re) => re.test(k))), 'on the grid, not in the contract').toEqual([])
      const { swept, skipped } = targets(read, scopeName)
      test.info().annotations.push({ type: 'columns', description: `${swept.length} swept, ${skipped.length} abstained` })
      for (const s of skipped) test.info().annotations.push({ type: 'abstained', description: s })
      expect(chunksOf(swept).length, `more chunks than ${CHUNKS} — raise CHUNKS`).toBeLessThanOrEqual(CHUNKS)
      wire.assertLoopback()
    })

    for (let chunk = 0; chunk < CHUNKS; chunk++) {
      if (!inPart(chunk, scopeIndex)) continue
      test(`@sheet ${scopeName} · chunk ${chunk + 1}/${CHUNKS} · keyboard, mouse, paste`, async ({ page }) => {
        const read = await readSheet(page, scope, seed.workspace)
        const mine = chunksOf(targets(read, scopeName).swept)[chunk] ?? []
        test.skip(mine.length === 0, `abstain: this scope's columns fill fewer than ${chunk + 1} chunks`)
        const wire = new Wire(page)
        await stubNetworkReads(page)
        await openSheet(page, scope)
        await revealAllColumns(page)
        const expected = new Map<string, { row: string; key: string; value: unknown; editor: EditorId }>()
        const versions = new Map(read.rows.map((r) => [r.id, versionOf(r, scopeName)]))
        const results: string[] = []
        const failures: string[] = []
        let attempted = 0
        for (const { column, editor, row } of mine) {
          let current: unknown = row.values[column.key]?.value ?? null
          const cell0 = row.values[column.key]
          const labels = await gridLabels(page, column.key, labelledCodes(editor, column), column.shape === 'list')
          for (const [n, path] of PATHS.entries()) {
            const arm = DRIVERS[editor][path]
            const what = `${scopeName} · ${column.key} (${editor}, ${column.kind}${column.shape && column.shape !== 'scalar' ? `/${column.shape}` : ''}) · ${path} · row ${row.id}`
            if (typeof arm !== 'function') { results.push(`– ${what}: ${arm.na}`); continue }
            const pick = pickFor(editor, column, current, n, path as Path, { themes: seed.themes, categories: seed.categories[scopeName]?.choices, labels })
            if (pick.skip) { results.push(`– ${what}: ${pick.skip}`); continue }
            // Every commit is tried and every failure reported (a chunk that stops at its first red hides the rest).
            await test.step(what, async () => {
              attempted++
              try {
              const cell = await focusCell(page, row.id, column.key)
              const mark = wire.mark()
              await arm({ page, cell, column, pick, scope: scopeName })
              await expect(page.locator('.ag-popup-editor'), `${what}: the editor stayed open`).toBeHidden()
              // A channel text that FOLLOWS the shared one asks first where the edit goes. Pin it on this listing: the
              // family's shared text stays as it is.
              const pin = page.getByRole('button', { name: /^Pin on / })
              await expect.poll(async () => wire.mark() > mark || await pin.isVisible(), { timeout: 10_000, message: `${what}: neither a write nor a question` }).toBe(true)
              const pinned = wire.mark() === mark
              if (pinned) { await pin.click(); results.push(`  (${column.key}: follows the shared text — pinned on the listing)`) }
              const save = await wire.one(mark, what)
              expect(save.status, `${what}: HTTP ${save.status} ${JSON.stringify(save.answer)}`).toBe(200)
              expect(save.body.units, `${what}: units`).toHaveLength(1)
              const [unit] = save.body.units
              expect(unit.changes, `${what}: changes`).toHaveLength(1)
              const [change] = unit.changes
              expect(change.id, `${what}: row`).toBe(row.id)
              expect(change.field, `${what}: field`).toBe(cell0.writeField ?? column.writeField ?? column.key)
              expect(stripped(change.value), `${what}: value`).toEqual(stripped(pick.wire))
              // The master writer omits the API's default set intent; reset must never be inferred here.
              expect(change.intent ?? 'set', `${what}: intent`).toBe('set')
              // The server says where the cell lands (`writeTarget`); on a channel scope a listing write is `channel`, and
              // a pinned shared text is too.
              if (scope.channel) expect(change.target, `${what}: target`).toBe(pinned || ['channel', 'channelListing'].includes(String(cell0.writeTarget)) ? 'channel' : 'master')
              else if (change.target !== undefined) expect(change.target, `${what}: target`).toBe('master')
              const address = change.contentAddress as { language?: string; coordinate?: { channel?: string; market?: string; accountId?: string } } | undefined
              if (cell0.contentAddress) expect(address, `${what}: required content address`).toBeDefined()
              if (address && scope.channel) {
                // A channel text is written at this listing's own language and coordinate.
                expect(address.language, `${what}: language`).toBe(scope.locale)
                expect(address.coordinate, `${what}: coordinate`).toEqual({ channel: scope.channel, market: scope.market, accountId: scope.connection })
              } else if (address) expect(address, `${what}: content address`).toEqual(cell0.contentAddress)
              if (scope.channel) {
                expect(unit.marketplaceContexts, `${what}: exactly one marketplace context`).toHaveLength(1)
                expect(unit.marketplaceContexts?.[0], `${what}: marketplace context`).toMatchObject({ channel: scope.channel, marketplace: scope.market, accountId: scope.connection, locale: scope.locale })
              }
              expect(unit.expectedVersion, `${what}: expectedVersion`).toBe(versions.get(row.id))
              expect(save.answer.units.map(answer => answer.key), `${what}: answer belongs to this unit`).toEqual([unit.key])
              const offline = DRIVERS[editor].refusedOffline
              if (offline) {
                // The write is exact; storing it needs the channel. The API must say so by name and keep the value.
                expect(save.answer, `${what}: answer`).toMatchObject({ saved: 0, failed: 1 })
                expect(JSON.stringify(save.answer.units[0]?.body), `${what}: the refusal names why`).toMatch(offline.answer)
                const afterRefusal = await readSheet(page, scope, seed.workspace)
                expect(stripped(afterRefusal.rows.find(savedRow => savedRow.id === row.id)?.values[column.key]?.value), `${what}: refusal kept the stored value`).toEqual(stripped(current))
                results.push(`  (${column.key}: refused offline, as expected — ${offline.reason})`)
              } else {
                assertSaved(save, what)
                const next = save.answer.units[0]?.body?.currentVersion
                if (typeof next === 'number') versions.set(row.id, next)
                if (pick.shows) await expect(cell, `${what}: the cell shows it`).toContainText(pick.shows)
                // Read every gesture before a later gesture overwrites it. End-of-chunk checks alone only proved paste.
                const persisted = await readSheet(page, scope, seed.workspace)
                expect(stripped(persisted.rows.find((savedRow) => savedRow.id === row.id)?.values[column.key]?.value), `${what}: persisted value`).toEqual(stripped(pick.stored ?? pick.wire))
                current = pick.stored ?? pick.wire
                expected.set(`${row.id}|${column.key}`, { row: row.id, key: column.key, value: pick.stored ?? pick.wire, editor })
              }
              results.push(`✓ ${what}`)
              } catch (error) {
                const message = String(error instanceof Error ? error.message : error).split('\n').slice(0, 8).join(' | ')
                failures.push(message.startsWith(scopeName) ? message : `${what}: ${message}`)
                results.push(`✗ ${what}`)
                // Close whatever is open, and take the row's state from the server before the next arm.
                for (const key of ['Escape', 'Escape']) await page.keyboard.press(key).catch(() => {})
                const cancel = page.getByRole('button', { name: 'Cancel', exact: true })
                if (await cancel.isVisible().catch(() => false)) await cancel.click().catch(() => {})
                const fresh = await readSheet(page, scope, seed.workspace)
                const now = fresh.rows.find((r) => r.id === row.id)
                if (now) { versions.set(row.id, versionOf(now, scopeName)); current = now.values[column.key]?.value ?? null }
                expected.delete(`${row.id}|${column.key}`)
              }
            })
          }
        }

        // Stored, not just painted: one read holds every value this chunk wrote.
        const after = await readSheet(page, scope, seed.workspace)
        const stored = [...expected.values()].map(({ row, key, value, editor }) => {
          const got = after.rows.find((r) => r.id === row)?.values?.[key]?.value
          return { cell: `${row} · ${key}`, key, editor, got: stripped(got), want: stripped(value) }
        })
        const unstored = stored.filter((s) => JSON.stringify(s.got) !== JSON.stringify(s.want)).map(({ cell, got, want }) => ({ cell, got, want }))
        test.info().annotations.push({ type: 'commits', description: results.join('\n') })
        console.log(results.join('\n'))
        expect(failures, 'commits that failed').toEqual([])
        expect(unstored, 'read back from the API').toEqual([])
        expect(wire.mark(), 'one write per attempted gesture over the whole chunk, including late writes').toBe(attempted)
        wire.assertLoopback()
      })
    }
  })
}

if (!PART || PART.index === 0) test('@sheet SHOPIFY', () => {
  test.skip(true, 'Shopify cells open the Shopify value dialog, not a grid editor, and their field definitions come from a live Shopify read; the seed cannot serve them without one.')
})
