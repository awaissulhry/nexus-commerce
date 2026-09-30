/**
 * P3 guardrail 1 (2026-09-30) — the product-sheet COMMIT SWEEP.
 *
 * For every scope the seed builds (Shared, eBay · IT, Amazon · IT, Etsy) and every column the sheet contract serves as
 * editable, one value is committed by KEYBOARD, by MOUSE and by PASTE (where the editor takes a paste), each on a row the
 * sweep owns, and each commit must:
 *   · send exactly ONE `bulk-save`, one unit, one change — the cell's own field, target and content address, the value
 *     chosen, intent `set`, the scope's marketplace context and the version the GET gave the row;
 *   · be answered saved (200, `saved: 1, failed: 0`) and show on the cell;
 *   · be STORED: after the chunk, one read of the sheet API must hold every value it wrote.
 * The contract test cross-checks the API's columns with the grid's: a writable contract column the grid does not build, or
 * an editable grid column the contract does not name, fails.
 *
 * Columns are split into chunks of CHUNK (Playwright lists tests before any column is known); each chunk test reads the
 * contract and takes its slice. A slice past the end abstains, and a scope with more columns than the chunks hold FAILS.
 * Every commit is tried and every failure is reported at the end of its chunk. What the sweep cannot do is said by name:
 * a driver's `abstain` or `{ na }` arm, a pick's `skip`, a driver's `refusedOffline` (the exact write, then the API's own
 * refusal), and `KNOWN_DEFECTS` — defects this sweep found that are not fixed yet (drivers.ts; they may only shrink).
 *
 * Why this exists: the 2026-09-29 defects (Enter and Tab kept the old value, the chevron did nothing, the first typed key
 * was lost, an open list refused a typed value) all live between the key and the wire, where no test looked.
 */
import { expect, test, type Page } from '@playwright/test'
import { DRIVERS, NETWORK_STUBS, PATHS, editorOf, knownDefect, labelledCodes, pickFor, type EditorId, type KnownDefect, type Path } from './drivers'
import { focusCell, gridLabels, openSheet, readSheet, revealAllColumns, scopeOf, type ApiColumn, type ApiRow, type ScopeName, type SheetRead } from './grid'
import { sheetSeed } from './seed'
import { Wire } from './wire'

const SCOPES: ScopeName[] = ['master', 'EBAY', 'AMAZON', 'ETSY']
const CHUNK = 8
const CHUNKS = 10
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

const versionOf = (row: ApiRow, scope: ScopeName) => (scope === 'master' ? row.version : row.listing?.version ?? row.version)
const stripped = (value: unknown) => JSON.parse(JSON.stringify(value ?? null))

async function stubNetworkReads(page: Page) {
  for (const stub of NETWORK_STUBS) await page.route(stub.url, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stub.body) }))
}

for (const scopeName of SCOPES) {
  test.describe(`@sheet ${scopeName}`, () => {
    // One scope's chunks in order, in one worker: a repeated attribute is written position by position across chunks, and
    // two saves racing on one database can lose its serialization race (a 503 "busy" the sheet does not retry).
    test.describe.configure({ mode: 'default' })
    const scope = scopeOf(seed, scopeName)

    test(`@sheet ${scopeName} · the grid builds every writable contract column, and no editable column the contract lacks`, async ({ page }) => {
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
      expect(swept.length, `more columns than ${CHUNKS} chunks of ${CHUNK} hold — raise CHUNKS`).toBeLessThanOrEqual(CHUNK * CHUNKS)
      wire.assertLoopback()
    })

    for (let chunk = 0; chunk < CHUNKS; chunk++) {
      test(`@sheet ${scopeName} · chunk ${chunk + 1}/${CHUNKS} · keyboard, mouse, paste`, async ({ page }) => {
        const read = await readSheet(page, scope, seed.workspace)
        const mine = targets(read, scopeName).swept.slice(chunk * CHUNK, (chunk + 1) * CHUNK)
        test.skip(mine.length === 0, `abstain: this scope has fewer than ${chunk * CHUNK + 1} sweepable columns`)
        const wire = new Wire(page)
        await stubNetworkReads(page)
        await openSheet(page, scope)
        await revealAllColumns(page)
        const expected = new Map<string, { row: string; key: string; value: unknown; editor: EditorId }>()
        const versions = new Map(read.rows.map((r) => [r.id, versionOf(r, scopeName)]))
        const results: string[] = []
        const failures: string[] = []
        // A known defect is excused only while it still happens: if every commit it covers here passed, it is fixed.
        const knownSeen = new Map<KnownDefect, { passed: number; failed: number }>()
        const tally = (known: KnownDefect, passed: boolean) => {
          const t = knownSeen.get(known) ?? { passed: 0, failed: 0 }
          t[passed ? 'passed' : 'failed']++
          knownSeen.set(known, t)
        }

        for (const { column, editor, row } of mine) {
          let current: unknown = row.values[column.key]?.value ?? null
          const cell0 = row.values[column.key]
          const slot = (column as { slot?: { of: string; max: number } }).slot
          const heldSlots = !!slot && Array.from({ length: slot.max }, (_, i) => row.values[`${slot.of}_${i + 1}`]?.value).some((v) => v != null && v !== '')
          const labels = await gridLabels(page, column.key, labelledCodes(editor, column), column.shape === 'list')
          for (const [n, path] of PATHS.entries()) {
            const arm = DRIVERS[editor][path]
            const what = `${scopeName} · ${column.key} (${editor}, ${column.kind}${column.shape && column.shape !== 'scalar' ? `/${column.shape}` : ''}) · ${path} · row ${row.id}`
            if (typeof arm !== 'function') { results.push(`– ${what}: ${arm.na}`); continue }
            const pick = pickFor(editor, column, current, n, path as Path, { themes: seed.themes, categories: seed.categories[scopeName]?.choices, labels })
            if (pick.skip) { results.push(`– ${what}: ${pick.skip}`); continue }
            // Every commit is tried and every failure reported (a chunk that stops at its first red hides the rest).
            await test.step(what, async () => {
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
              // A number list's editor sends its items as typed text; the API stores numbers (the read-back checks that).
              const sent = column.kind === 'number' && Array.isArray(change.value) ? change.value.map((v) => (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v)) : change.value
              expect(stripped(sent), `${what}: value`).toEqual(stripped(pick.wire))
              expect(change.intent ?? 'set', `${what}: intent`).toBe('set')
              // The server says where the cell lands (`writeTarget`); on a channel scope a listing write is `channel`, and
              // a pinned shared text is too.
              if (scope.channel) expect(change.target, `${what}: target`).toBe(pinned || ['channel', 'channelListing'].includes(String(cell0.writeTarget)) ? 'channel' : 'master')
              else if (change.target !== undefined) expect(change.target, `${what}: target`).toBe('master')
              const address = change.contentAddress as { language?: string; coordinate?: { channel?: string; market?: string; accountId?: string } } | undefined
              if (address && scope.channel) {
                // A channel text is written at this listing's own language and coordinate.
                expect(address.language, `${what}: language`).toBe(scope.locale)
                expect(address.coordinate, `${what}: coordinate`).toEqual({ channel: scope.channel, market: scope.market, accountId: scope.connection })
              } else if (address) expect(address, `${what}: content address`).toEqual(cell0.contentAddress)
              if (scope.channel) {
                expect(unit.marketplaceContexts?.[0], `${what}: marketplace context`).toMatchObject({ channel: scope.channel, marketplace: scope.market, accountId: scope.connection, locale: scope.locale })
              }
              expect(unit.expectedVersion, `${what}: expectedVersion`).toBe(versions.get(row.id))
              const offline = DRIVERS[editor].refusedOffline
              if (offline) {
                // The write is exact; storing it needs the channel. The API must say so by name and keep the value.
                expect(save.answer, `${what}: answer`).toMatchObject({ saved: 0, failed: 1 })
                expect(JSON.stringify(save.answer.units[0]?.body), `${what}: the refusal names why`).toMatch(offline.answer)
                results.push(`  (${column.key}: refused offline, as expected — ${offline.reason})`)
              } else {
                expect(save.answer, `${what}: answer ${JSON.stringify(save.answer?.units?.[0] ?? save.answer).slice(0, 500)}`).toMatchObject({ saved: 1, failed: 0 })
                const next = save.answer.units[0]?.body?.currentVersion
                if (typeof next === 'number') versions.set(row.id, next)
                if (pick.shows) await expect(cell, `${what}: the cell shows it`).toContainText(pick.shows)
                current = pick.stored ?? pick.wire
                expected.set(`${row.id}|${column.key}`, { row: row.id, key: column.key, value: pick.stored ?? pick.wire, editor })
              }
              const known = knownDefect('commit', scopeName, column.key, editor, path, heldSlots)
              if (known) tally(known, true)
              results.push(`✓ ${what}`)
              } catch (error) {
                const known = knownDefect('commit', scopeName, column.key, editor, path, heldSlots)
                if (known) { tally(known, false); results.push(`! ${what}: KNOWN DEFECT — ${known.reason}`) }
                else {
                  const message = String(error instanceof Error ? error.message : error).split('\n').slice(0, 8).join(' | ')
                  failures.push(message.startsWith(scopeName) ? message : `${what}: ${message}`)
                  results.push(`✗ ${what}`)
                }
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
        }).filter((s) => {
          const known = knownDefect('stored', scopeName, s.key, s.editor)
          const same = JSON.stringify(s.got) === JSON.stringify(s.want)
          if (known) tally(known, same)
          if (known && !same) results.push(`! ${s.cell}: KNOWN DEFECT — ${known.reason}`)
          return !known
        })
        for (const [known, t] of knownSeen) {
          if (t.failed === 0) failures.push(`fixed? every commit KNOWN_DEFECTS excuses here passed (${t.passed}) — remove the entry in drivers.ts: ${known.reason.slice(0, 100)}…`)
        }
        const unstored = stored.filter((s) => JSON.stringify(s.got) !== JSON.stringify(s.want)).map(({ cell, got, want }) => ({ cell, got, want }))
        test.info().annotations.push({ type: 'commits', description: results.join('\n') })
        console.log(results.join('\n'))
        expect(failures, 'commits that failed').toEqual([])
        expect(unstored, 'read back from the API').toEqual([])
        wire.assertLoopback()
      })
    }
  })
}

test('@sheet SHOPIFY', () => {
  test.skip(true, 'Shopify cells open the Shopify value dialog, not a grid editor, and their field definitions come from a live Shopify read; the seed cannot serve them without one.')
})
