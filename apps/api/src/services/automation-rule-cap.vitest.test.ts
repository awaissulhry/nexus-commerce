/**
 * ADX.1 — regression test for the self-ratcheting daily cap.
 *
 * The bug: the cap counted EVERY AutomationRuleExecution row for the day, and on
 * rejection WROTE ANOTHER ONE. Once a rule hit its cap, every subsequent tick
 * appended a CAP_EXCEEDED row that raised the number the next tick compared
 * against, so the count could never fall back within a day. Measured on prod
 * 2026-08-04: 693,503 FAILED executions and 0 SUCCESS, ever; one cap-2 rule had
 * 2 real runs and 790 self-inflicted rejections in a single day.
 *
 * These tests pin the two properties that close it:
 *   1. a cap rejection writes NO execution row;
 *   2. the cap count excludes DAILY_CAP_EXCEEDED rows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const execCreate = vi.fn(async () => ({ id: 'exec-new' }))
const execCount = vi.fn(async () => 0)
const ruleUpdate = vi.fn(async () => ({}))
const ruleFindUnique = vi.fn(async () => RULE)
/** CAP — the write cap counts AdvertisingActionLog by ACTOR. */
const actionLogCount = vi.fn(async () => 0)
/** BB-9 — today's refusal counter: a rule that does not write is counted once a day. */
const refusalFind = vi.fn(async (): Promise<{ count: number } | null> => null)
const refusalUpsert = vi.fn(async () => ({}))

vi.mock('../db.js', () => ({
  default: {
    automationRuleExecution: {
      get count() { return execCount },
      get create() { return execCreate },
    },
    automationRule: {
      get update() { return ruleUpdate },
      get findUnique() { return ruleFindUnique },
    },
    advertisingActionLog: {
      get count() { return actionLogCount },
    },
    automationRefusalDaily: {
      get findUnique() { return refusalFind },
      get upsert() { return refusalUpsert },
    },
  },
}))

// BB-9 — a rule action on a campaign the bid brain owns becomes its input; null (the default here) runs it as before.
const brainInput = vi.fn(async (): Promise<unknown> => null)
vi.mock('./advertising/bid-brain/rule-directives.js', () => ({ ruleBrainInput: brainInput }))
const publish = vi.fn()

// ADX.2 — the Propose pipeline. genSuggestions is the artifact an operator actually reviews.
const genSuggestions = vi.fn(async () => 1)
vi.mock('./advertising/ads-suggestions.service.js', () => ({
  generateSuggestionsFromExecution: genSuggestions,
}))
vi.mock('./advertising/ads-rule-adapter.service.js', () => ({
  maybeTranslateAdsRule: () => null,
  // 1f — the run-time AUTO ceiling (ads-graduation.ts) reads it; without it the ceiling fails closed.
  BUILDER_SLUG_ACTIONS: {},
}))
vi.mock('./ads-execution-events.service.js', () => ({ publishAdsExecution: (...a: unknown[]) => publish(...a) }))

/** The suggestion call is fire-and-forget behind a dynamic import; let the microtasks drain. */
const flush = () => new Promise((r) => setTimeout(r, 0))

const RULE = {
  id: 'rule-1',
  name: 'Bid optimization (profit-native)',
  domain: 'advertising',
  trigger: 'SCHEDULE',
  conditions: [],
  actions: [{ type: 'log_only' }],
  enabled: true,
  dryRun: true,
  maxExecutionsPerDay: 2,
  maxValueCentsEur: null,
  maxDailyAdSpendCentsEur: null,
  scopeMarketplace: null,
}

const { evaluateRule, ACTION_HANDLERS } = await import('./automation-rule.service.js')

beforeEach(() => {
  execCreate.mockClear()
  execCount.mockClear()
  ruleUpdate.mockClear()
  ruleFindUnique.mockClear()
  genSuggestions.mockClear()
  actionLogCount.mockClear()
  actionLogCount.mockResolvedValue(0)
  refusalFind.mockReset()
  refusalFind.mockResolvedValue(null)
  refusalUpsert.mockClear()
  brainInput.mockReset()
  brainInput.mockResolvedValue(null)
  publish.mockClear()
})

/**
 * CAP — the write cap. It exists because the row cap is in the wrong unit for harm:
 * `Trim budget on weak ACOS` walked a campaign €100.00 → €1.00 in 39 Amazon writes in one day
 * while carrying a row cap of 10.
 *
 * The property that matters most is NOT that it stops writes — it is that it stops writes
 * WITHOUT going silent. `Reduce bids on ACOS spike` carries `maxValueCentsEur = 0`, which refuses
 * every action including its own `notify`, and it has been 100% inert in complete silence for
 * weeks. A cap that suppresses the report of itself is how that happens.
 */
describe('CAP — the write cap demotes, it does not silence', () => {
  const AUTO_RULE = { ...RULE, dryRun: false, autonomyLevel: 'AUTO', maxWritesPerDay: 5, maxExecutionsPerDay: null }

  it('under the write cap: an AUTO rule still acts', async () => {
    ruleFindUnique.mockResolvedValueOnce(AUTO_RULE)
    actionLogCount.mockResolvedValueOnce(4) // cap is 5

    const r = await evaluateRule({ ruleId: 'rule-1', context: { trigger: 'SCHEDULE', marketplace: 'IT' } })

    expect(r.status).not.toBe('DRY_RUN')
    expect(execCreate).toHaveBeenCalledTimes(1)
    expect(execCreate.mock.calls[0]?.[0]?.data?.dryRun).toBe(false)
  })

  it('at the write cap: demoted to dry-run, and it STILL RUNS and still records', async () => {
    ruleFindUnique.mockResolvedValueOnce(AUTO_RULE)
    actionLogCount.mockResolvedValueOnce(5) // at cap

    const r = await evaluateRule({ ruleId: 'rule-1', context: { trigger: 'SCHEDULE', marketplace: 'IT' } })

    // Demoted, NOT refused: the execution happened, so the rule can still report.
    expect(r.status).toBe('DRY_RUN')
    expect(execCreate).toHaveBeenCalledTimes(1)
    const data = execCreate.mock.calls[0]?.[0]?.data
    expect(data?.dryRun).toBe(true)
    // 🔴 Durable: unlike a row-cap refusal, which writes no row at all and survives only as a
    // 5-minute ring-buffer event, this leaves a record of WHY the write did not happen.
    expect(data?.errorMessage).toBe('WRITE_CAP_REACHED')
    // …and not as a cap refusal, or the row-cap counter would stop counting it as work.
    expect(data?.errorMessage).not.toBe('DAILY_CAP_EXCEEDED')
  })

  it('🔴 a write-capped AUTO rule still PROPOSES — being stopped is not a reason to go quiet', async () => {
    ruleFindUnique.mockResolvedValueOnce(AUTO_RULE)
    actionLogCount.mockResolvedValueOnce(99)

    await evaluateRule({
      ruleId: 'rule-1',
      context: { trigger: 'SCHEDULE', marketplace: 'IT', campaign: { id: 'camp-1', name: 'GALE|IT' } },
    })

    await flush()
    // levelProposes() is PROPOSE-only, so without the writeCapReached term this is 0 and the
    // operator gets a DRY_RUN row and nothing to approve.
    expect(genSuggestions).toHaveBeenCalledTimes(1)
  })

  it('the write cap counts by ACTOR, never by executionId', async () => {
    ruleFindUnique.mockResolvedValueOnce(AUTO_RULE)
    actionLogCount.mockResolvedValueOnce(0)

    await evaluateRule({ ruleId: 'rule-1', context: { trigger: 'SCHEDULE', marketplace: 'IT' } })

    expect(actionLogCount).toHaveBeenCalledTimes(1)
    const where = actionLogCount.mock.calls[0]?.[0]?.where
    // executionId is null on every rule write (97 rows in 60d vs 36,219 by actor), so an
    // executionId-keyed cap reads zero for every rule and never binds.
    expect(where?.userId).toBe('automation:rule-1')
    expect(where).not.toHaveProperty('executionId')
  })

  it('no write cap set: the action log is never queried', async () => {
    ruleFindUnique.mockResolvedValueOnce({ ...AUTO_RULE, maxWritesPerDay: null })

    await evaluateRule({ ruleId: 'rule-1', context: { trigger: 'SCHEDULE', marketplace: 'IT' } })

    expect(actionLogCount).not.toHaveBeenCalled()
  })

  it('a PROPOSE rule never consults the write cap — it cannot write in the first place', async () => {
    ruleFindUnique.mockResolvedValueOnce({ ...RULE, maxWritesPerDay: 1, maxExecutionsPerDay: null })

    await evaluateRule({ ruleId: 'rule-1', context: { trigger: 'SCHEDULE', marketplace: 'IT' } })

    expect(actionLogCount).not.toHaveBeenCalled()
  })
})

describe('daily cap — the ADX.1 ratchet', () => {
  it('at cap: returns CAP_EXCEEDED and writes NO execution row', async () => {
    execCount.mockResolvedValueOnce(2) // already at cap of 2

    const r = await evaluateRule({
      ruleId: 'rule-1',
      context: { trigger: 'SCHEDULE', marketplace: 'IT' },
    })

    expect(r.status).toBe('CAP_EXCEEDED')
    expect(r.errorMessage).toBe('DAILY_CAP_EXCEEDED')
    // THE REGRESSION: writing a row here is what fed the counter.
    expect(execCreate).not.toHaveBeenCalled()
    // …and therefore there is no execution id to hand back.
    expect(r.executionId).toBeUndefined()
  })

  /**
   * CAP (2026-08-14) — this test used to assert `where.NOT` equalled
   * `{ errorMessage: 'DAILY_CAP_EXCEEDED' }`, and it PASSED for ten days while the cap it
   * describes counted literally zero rows on production.
   *
   * 🔴 A shape assertion can never catch this defect. `NOT (f = v)` is a perfectly
   * well-formed predicate; what is wrong with it is its SQL semantics on a nullable column —
   * three-valued logic makes it NULL, not TRUE, when `f IS NULL`, so those rows are dropped.
   * The object looked exactly as intended and the query returned nothing.
   *
   * So the predicate is now evaluated against representative rows under SQL's own truth
   * table. The old form fails these; the new one passes. `prisma.count` is mocked, so this is
   * the closest a unit test can get to running the query — and it is close enough to have
   * caught the original bug, which the shape check was not.
   */
  it('the cap count excludes refusals but COUNTS successes — under SQL three-valued logic', async () => {
    execCount.mockResolvedValueOnce(0)

    await evaluateRule({
      ruleId: 'rule-1',
      context: { trigger: 'SCHEDULE', marketplace: 'IT' },
    })

    expect(execCount).toHaveBeenCalledTimes(1)
    const where = execCount.mock.calls[0]?.[0]?.where as Record<string, unknown> | undefined
    expect(where?.ruleId).toBe('rule-1')

    /** SQL semantics: a row is counted only when the predicate is TRUE. NULL is not TRUE. */
    const matches = (w: Record<string, unknown> | undefined, errorMessage: string | null): boolean => {
      const leaf = (clause: unknown): boolean | null => {
        const c = clause as Record<string, unknown>
        if ('errorMessage' in c) {
          const v = c.errorMessage
          // `{ f: null }` is Prisma's `f IS NULL`, and IS NULL is two-valued: it is the one
          // form that returns TRUE for a null column. That is why the OR needs it.
          if (v === null) return errorMessage === null
          if (typeof v === 'object' && v !== null && 'not' in (v as Record<string, unknown>)) {
            // `f <> 'x'` is NULL when f IS NULL — the entire bug, in one line.
            if (errorMessage === null) return null
            return errorMessage !== (v as { not: string }).not
          }
          // `f = 'x'` is likewise NULL, not FALSE, when f IS NULL.
          if (errorMessage === null) return null
          return errorMessage === v
        }
        return null
      }
      if (w && Array.isArray(w.OR)) return w.OR.some((c) => leaf(c) === true)
      if (w && w.NOT) {
        const inner = leaf(w.NOT)
        return inner === null ? false : !inner // NOT NULL is NULL, which is not TRUE
      }
      return false
    }

    // A successful or dry-run execution carries a NULL errorMessage. It MUST be counted —
    // this is the assertion the old clause failed on 956,629 production rows.
    expect(matches(where, null)).toBe(true)
    // A refusal must NOT be counted, or the ~693k historical rows keep every cap tripped.
    expect(matches(where, 'DAILY_CAP_EXCEEDED')).toBe(false)
    // Any other failure is real work and still counts.
    expect(matches(where, 'VALUE_CAP_EXCEEDED')).toBe(true)

    // And the bare form this replaced is provably wrong under the same evaluator.
    expect(matches({ NOT: { errorMessage: 'DAILY_CAP_EXCEEDED' } }, null)).toBe(false)
  })

  it('under cap: the rule executes and records exactly one row', async () => {
    execCount.mockResolvedValueOnce(1) // cap is 2

    const r = await evaluateRule({
      ruleId: 'rule-1',
      context: { trigger: 'SCHEDULE', marketplace: 'IT' },
    })

    expect(r.status).toBe('DRY_RUN')
    expect(execCreate).toHaveBeenCalledTimes(1)
  })

  it('repeated ticks at cap never accumulate rows — the loop cannot restart', async () => {
    execCount.mockResolvedValue(2)

    for (let i = 0; i < 25; i++) {
      const r = await evaluateRule({
        ruleId: 'rule-1',
        context: { trigger: 'SCHEDULE', marketplace: 'IT' },
      })
      expect(r.status).toBe('CAP_EXCEEDED')
    }
    // Pre-fix this produced 25 new rows, each raising the count that caused them.
    expect(execCreate).not.toHaveBeenCalled()
  })
})

describe('ADX.2 — a dry-run must produce a reviewable proposal', () => {
  it('an ordinary advertising rule in dry-run emits suggestions', async () => {
    // No control='manual' anywhere — which is true of all 51 rules on prod.
    execCount.mockResolvedValueOnce(0)

    const r = await evaluateRule({
      ruleId: 'rule-1',
      context: { trigger: 'SCHEDULE', marketplace: 'IT', campaign: { id: 'camp-1', name: 'GALE|IT' } },
    })

    expect(r.status).toBe('DRY_RUN')
    await flush()
    // THE REGRESSION: gated on actions[0].control === 'manual', this never fired in production.
    expect(genSuggestions).toHaveBeenCalledTimes(1)
    expect(genSuggestions.mock.calls[0]?.[0]).toMatchObject({ ruleId: 'rule-1' })
  })

  it('autonomy=SUGGEST (cron forceDryRun) still proposes — that is the whole point of the mode', async () => {
    execCount.mockResolvedValueOnce(0)
    ruleFindUnique.mockResolvedValueOnce({ ...RULE, dryRun: false })

    await evaluateRule({
      ruleId: 'rule-1',
      context: { trigger: 'SCHEDULE', marketplace: 'IT', campaign: { id: 'camp-1', name: 'GALE|IT' } },
      forceDryRun: true,
    })

    await flush()
    expect(genSuggestions).toHaveBeenCalledTimes(1)
  })

  it('the "test rule" endpoint does NOT pollute the queue', async () => {
    execCount.mockResolvedValueOnce(0)

    await evaluateRule({
      ruleId: 'rule-1',
      context: { trigger: 'SCHEDULE', marketplace: 'IT', campaign: { id: 'camp-1', name: 'GALE|IT' } },
      forceDryRun: true,
      isTestRun: true,
    })

    await flush()
    expect(genSuggestions).not.toHaveBeenCalled()
  })

  it('a live (non-dry-run) advertising rule acts instead of proposing', async () => {
    execCount.mockResolvedValueOnce(0)
    ruleFindUnique.mockResolvedValueOnce({ ...RULE, dryRun: false })

    const r = await evaluateRule({
      ruleId: 'rule-1',
      context: { trigger: 'SCHEDULE', marketplace: 'IT', campaign: { id: 'camp-1', name: 'GALE|IT' } },
    })

    expect(r.status).not.toBe('DRY_RUN')
    await flush()
    expect(genSuggestions).not.toHaveBeenCalled()
  })

  it('a non-advertising rule is untouched by this path', async () => {
    execCount.mockResolvedValueOnce(0)
    ruleFindUnique.mockResolvedValueOnce({ ...RULE, domain: 'replenishment' })

    await evaluateRule({ ruleId: 'rule-1', context: { trigger: 'SCHEDULE' } })

    await flush()
    expect(genSuggestions).not.toHaveBeenCalled()
  })

  it('a capped rule proposes nothing — no execution, no proposal', async () => {
    execCount.mockResolvedValueOnce(99)

    const r = await evaluateRule({
      ruleId: 'rule-1',
      context: { trigger: 'SCHEDULE', marketplace: 'IT', campaign: { id: 'camp-1', name: 'GALE|IT' } },
    })

    expect(r.status).toBe('CAP_EXCEEDED')
    await flush()
    expect(genSuggestions).not.toHaveBeenCalled()
  })
})

describe('BB-9 — a rule that does not write is refused once a day, not once per match', () => {
  const at = { ruleId: 'rule-1', context: { trigger: 'SOV_BID', marketplace: 'IT', adTarget: { id: 'k-7' } } }

  it("a PROPOSE rule's first refusal of the day is recorded and published; every later one that day is silent", async () => {
    execCount.mockResolvedValue(2) // at its cap of 2
    expect((await evaluateRule(at)).status).toBe('CAP_EXCEEDED')
    expect(refusalUpsert).toHaveBeenCalledTimes(1)
    expect((refusalUpsert.mock.calls[0] as unknown as [{ create: { reason: string; lastReason: string } }])[0].create).toMatchObject({ reason: 'DAILY_CAP_EXCEEDED', lastReason: expect.stringMatching(/It proposes and does not write, so it is counted once a day\.$/) })
    await flush()
    expect(publish).toHaveBeenCalledTimes(1)

    refusalFind.mockResolvedValue({ count: 1 })
    for (let i = 0; i < 3; i++) expect((await evaluateRule(at)).status).toBe('CAP_EXCEEDED')
    await flush()
    expect(refusalUpsert).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(execCreate).not.toHaveBeenCalled() // still no execution row (ADX.1)
    execCount.mockResolvedValue(0)
  })

  it('an AUTO rule still counts each refusal: there the count is the reach its cap takes away', async () => {
    ruleFindUnique.mockResolvedValue({ ...RULE, dryRun: false, autonomyLevel: 'AUTO' })
    execCount.mockResolvedValue(2)
    refusalFind.mockResolvedValue({ count: 5 })
    await evaluateRule(at)
    await evaluateRule(at)
    expect(refusalUpsert).toHaveBeenCalledTimes(2)
    expect(refusalFind).not.toHaveBeenCalled()
    ruleFindUnique.mockResolvedValue(RULE)
    execCount.mockResolvedValue(0)
  })
})

describe('BB-9 — the rule engine hands an owned campaign\'s bid action to the bid brain', () => {
  const handler = vi.fn(async () => ({ type: 'test_bid', ok: true, output: { newBidCents: 40 } }))
  const BID_RULE = { ...RULE, trigger: 'KEYWORD_HIGH_ACOS', actions: [{ type: 'test_bid' }], dryRun: false, autonomyLevel: 'AUTO', maxExecutionsPerDay: null }
  beforeEach(() => {
    ACTION_HANDLERS.test_bid = handler as never
    handler.mockClear()
    ruleFindUnique.mockResolvedValue(BID_RULE)
  })

  it('its input is recorded in place of the write; the handler is only offered as the dry run that says what the rule asks', async () => {
    brainInput.mockResolvedValueOnce({ type: 'test_bid', ok: true, output: { bidBrain: { directives: 1 } } })
    const r = await evaluateRule({ ruleId: 'rule-1', context: { trigger: 'KEYWORD_HIGH_ACOS', adTarget: { id: 'k-1' } } })
    expect(r.actionResults).toEqual([{ type: 'test_bid', ok: true, output: { bidBrain: { directives: 1 } } }])
    expect(handler).not.toHaveBeenCalled()
    const [action, , meta, dry] = brainInput.mock.calls[0] as unknown as [unknown, unknown, unknown, (a: unknown) => Promise<unknown>]
    expect(action).toEqual({ type: 'test_bid' })
    // The run's own dryRun (here the AUTO ceiling demotes the test rule to a dry run) — the input then writes nothing.
    expect(meta).toEqual({ ruleId: 'rule-1', trigger: 'KEYWORD_HIGH_ACOS', dryRun: r.status === 'DRY_RUN' })
    await dry({ type: 'test_bid' })
    expect(handler).toHaveBeenCalledWith({ type: 'test_bid' }, expect.anything(), { dryRun: true, ruleId: 'rule-1', preview: true })
    ruleFindUnique.mockResolvedValue(RULE)
  })

  it('any other campaign: the action runs as before; a failed input is a failed action, never a fall-through to the write', async () => {
    const r = await evaluateRule({ ruleId: 'rule-1', context: { trigger: 'KEYWORD_HIGH_ACOS', adTarget: { id: 'k-2' } } })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(r.actionResults[0]).toMatchObject({ ok: true, output: { newBidCents: 40 } })
    handler.mockClear()
    brainInput.mockRejectedValueOnce(new Error('database gone'))
    const failed = await evaluateRule({ ruleId: 'rule-1', context: { trigger: 'KEYWORD_HIGH_ACOS', adTarget: { id: 'k-3' } } })
    expect(failed.actionResults).toEqual([{ type: 'test_bid', ok: false, error: 'bid brain input: database gone' }])
    expect(handler).not.toHaveBeenCalled()
    ruleFindUnique.mockResolvedValue(RULE)
  })
})

