/**
 * IO.1 — where the drawer's data comes from, behind one interface.
 *
 * Two implementations: the FIXTURE one (today, because PES.5's endpoint has not shipped) and the
 * LIVE one (written now, unused until it answers). Both satisfy the same interface, so the drawer
 * has no branch in it for "are we dark" — the only difference an operator ever sees is the banner
 * `isFixture` produces and the Apply button `fixtureBlockedReason` refuses.
 *
 * 🔴 The live one is written NOW, against the ratified contract, rather than left as a TODO. A
 * transport written later is a transport written against whatever the endpoint happens to do, and
 * D15.13/D15.14 exist precisely so both halves could be built to one agreed text instead. When
 * PES.5 answers, this is a one-line swap in `ImportDrawer` and the fixture file is deleted.
 *
 * Not pure — it holds `fetch` — so nothing here decides anything. Every judgement is in
 * `diffModel.ts`, which a node test can reach.
 */
import { getBackendUrl } from '@/lib/backend-url'

import type { BlankCellMode, ImportDiff, ImportJob } from './contract'
import { verifyImportDiff } from './contract'
import { fixtureDiffFor, fixtureJob, type FixtureDiff } from './fixture'

export interface ImportTransport {
  /**
   * 🔴 A transport that cannot write SAYS SO AT REST (ruled #535).
   *
   * This is on the transport, not on the payload, and that placement is the whole fix. The fixture
   * flag rides on a diff — so a banner driven by it can only appear once a diff exists, which is
   * after the operator has chosen a file and waited for a parse. PES.2 caught it on their screen:
   * the drawer opened saying "Nothing is written until you have seen the diff and applied it",
   * which is equally true of a LIVE import, and the operator learned nothing could apply only
   * afterwards. Announcing a dead end after someone has committed effort to it is the worst
   * possible ordering.
   *
   * `null` on a live transport. A sentence on any transport that cannot reach a server.
   */
  readonly darkNote: string | null
  /** Upload and DIFF. Never writes — D15.4's dry-run-by-default is the endpoint's contract, not a flag. */
  diff(input: { file: File; blankCells: BlankCellMode; signal: AbortSignal }): Promise<ImportDiff>
  /**
   * Apply the STORED diff the operator saw (D15.15).
   *
   * 🔴 Takes a `jobId` and nothing else — no file, no blank-cell mode. That is the ruling, and the
   * signature is the enforcement: the mode is baked into the stored diff at preview time, so there
   * is no parameter here through which it could be swapped between what was shown and what is
   * written. A signature that still accepted them would leave that door open for the next caller.
   */
  apply(input: { jobId: string; signal: AbortSignal }): Promise<ImportJob>
  poll(input: { jobId: string; signal: AbortSignal }): Promise<ImportJob>
  revert(input: { jobId: string; signal: AbortSignal }): Promise<ImportJob>
}

/** Thrown when the response does not match the agreed shape. Carries the problems for rendering. */
export class ImportContractError extends Error {
  constructor(readonly problems: string[]) {
    super(`The import response does not match the agreed contract: ${problems.join('; ')}`)
    this.name = 'ImportContractError'
  }
}

/** The endpoint has not shipped. A different sentence from "the request failed" — PES.4's split. */
export class ImportNotShipped extends Error {
  constructor(status: number) {
    super(`The import endpoint is not deployed yet (HTTP ${status}).`)
    this.name = 'ImportNotShipped'
  }
}

async function readJson(res: Response): Promise<unknown> {
  if (res.status === 404 || res.status === 501) throw new ImportNotShipped(res.status)
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error
    throw new Error(message || `The server refused the request (HTTP ${res.status}).`)
  }
  return body
}

/**
 * The live transport, against PES.5's routes as D15.13/D15.14 name them.
 *
 * 🔴 Every diff response goes through `verifyImportDiff` before the drawer sees it. A hand-mirrored
 * contract across an app boundary fails by looking EMPTY, not by throwing — and an empty diff reads
 * as "nothing changes", which is the one message that makes an operator relax. So the parse is the
 * gate, and a drift is a rendered problem rather than a blank grid.
 */
export function liveTransport(productId: string, scope: ImportDiff['scope']): ImportTransport {
  const base = `${getBackendUrl()}/api/products/${productId}/import`

  return {
    // A live transport reaches a real endpoint, so it has nothing to announce.
    darkNote: null,
    async diff({ file, blankCells, signal }) {
      /*
       * 🔴 Every field rides the FORM, not the query string — measured against the route, which
       * reads its coordinate out of the multipart parts (`parts.market`, `parts.scope`,
       * `parts.channel`, `parts.blankCells`) and never looks at `request.query`.
       *
       * I had them on the query first and the route answered `400 market is required` while the URL
       * plainly carried `?market=IT`. Worth keeping: an endpoint saying a parameter is missing is
       * saying it is missing FROM WHERE IT LOOKS, which is not the same as absent.
       *
       * `market`, not `marketplace` — the route rejects the latter by name, and its own error text
       * explains why: the RESPONSE's `scope.marketplace` is a different thing, the resolved
       * coordinate. Same word, two meanings, opposite directions.
       *
       * The CSV itself is parsed SERVER-side beside the exporter (D15.16), so the label-row/key-row
       * convention lives in one implementation rather than two that must agree forever.
       */
      const form = new FormData()
      form.append('file', file)
      form.append('blankCells', blankCells)
      form.append('scope', scope.kind)
      if (scope.marketplace) form.append('market', scope.marketplace)
      if (scope.channel) form.append('channel', scope.channel)
      const res = await fetch(`${base}/diff`, {
        method: 'POST',
        credentials: 'include',
        body: form,
        signal,
        cache: 'no-store',
      })
      const body = await readJson(res)
      const problems = verifyImportDiff(body)
      if (problems.length > 0) throw new ImportContractError(problems)
      return body as ImportDiff
    },

    async apply({ jobId, signal }) {
      /*
       * No body, NO QUERY — the stored job carries everything (D15.15, settled #600).
       *
       * The `?market=` workaround that lived here is gone with PES.5's 08:22:17 landing: the job
       * now stores the market as its own fact rather than inferring it from a cell, so a master
       * scope (whose `marketplace` is legitimately null) no longer falls through to the query and
       * the `400 unknown_market` path does not exist. That path was not a cosmetic bug — it threw
       * AFTER marking the job `running`, which stranded a preview permanently, and I left one such
       * row behind proving it.
       */
      const res = await fetch(`${base}/jobs/${jobId}/apply`, { method: 'POST', credentials: 'include', signal })
      return (await readJson(res)) as ImportJob
    },

    async poll({ jobId, signal }) {
      const res = await fetch(`${base}/jobs/${jobId}`, { credentials: 'include', signal, cache: 'no-store' })
      return (await readJson(res)) as ImportJob
    },

    async revert({ jobId, signal }) {
      const res = await fetch(`${base}/jobs/${jobId}/revert`, { method: 'POST', credentials: 'include', signal })
      return (await readJson(res)) as ImportJob
    },
  }
}

/**
 * The fixture transport. Answers instantly, writes nothing, and flags everything it returns.
 *
 * `apply` and `revert` deliberately THROW rather than returning a plausible job. The drawer already
 * refuses to offer Apply over fixture data (`fixtureBlockedReason`), so reaching these is a bug in
 * this lane — and a fixture that answered "applied 412 changes" would let that bug ship looking
 * correct. Failing loudly is the only honest thing a fake write can do.
 */
/**
 * The sentence a dark drawer opens with (#535).
 *
 * Retained for the FIXTURE transport only. The live drawer no longer shows it: PES.5's route
 * conformed at 07:53:04 and the mount is live, so this now describes the lab and the test suite
 * rather than production.
 */
export const DARK_NOTE =
  'Preview only — this drawer is running on built-in fixture data, so nothing here can write.'

export function fixtureTransport(scopeKind: 'master' | 'channel'): ImportTransport {
  const refuse = (verb: string): never => {
    throw new Error(
      `The import drawer tried to ${verb} against fixture data. Nothing was written — but this path should be unreachable while PES.5's endpoint is unshipped, so this is a defect in the drawer's own guard, not a server problem.`,
    )
  }
  return {
    darkNote: DARK_NOTE,
    async diff({ blankCells }): Promise<FixtureDiff> {
      const base = fixtureDiffFor(scopeKind)
      // The echo is the SERVER's statement of what it applied, so the fixture echoes what it was
      // asked — a fixture that always echoed `ignore` would make `blankModeDisagreement`
      // permanently silent and the drawer's loudest guard untestable on screen.
      return { ...base, blankCells }
    },
    async apply() { return refuse('apply') },
    async poll() { return fixtureJob() },
    async revert() { return refuse('revert') },
  }
}
