#!/usr/bin/env node
/**
 * ci-report — RULE: a Factory CI run (.github/workflows/factory-end-check.yml, factory-quick-check.yml) is green only
 * when every part it ran passed AND ran at least as many tests as its floor in .github/factory-test-floor.json. So a run
 * in which the suites were skipped (a syntax error that stops every file from loading, a set-up that never started, a
 * shard that never reported) can never pass.
 *
 *   record   after a part's command, in its job: reads the part's vitest JSON report or its log and writes
 *            <out>/<part>[-<n>-of-<m>].json = { part, shard, kind, exit, ran, passed, failed, skipped, todo, failures }.
 *            ran = passed + failed (a skipped or todo test did not run). Kinds: vitest (its JSON report), golden
 *            (golden-flow.mjs's "N step(s): …" line), browser (browser-golden-flow.mjs's "N stage(s): …" line), guards
 *            (run-guards.mjs's "X of Y factory guards passed"), exit (typecheck, migrate: only the exit code counts; its
 *            log, when given, names tsc's errors and Error lines).
 *   summary  in the summary job: reads every result under --results, adds up the shards of a part (each of 1..m exactly
 *            once, m the same in all), and checks every part the check expects (the floor file's section --check, only
 *            the --groups selected): a result exists, it exited 0, nothing failed, and ran >= its floor. Prints one
 *            table (also to the job summary), the failing tests, and this run's counts as floors. Exit 1 on a problem.
 *   affected the quick check's unit parts may run only the tests a push can affect (`vitest --changed <base>`; record
 *            --scope affected). A floor counts only in a full run: an affected part reports its count and fails only on a
 *            failed test. Instead the summary (--sources <n>: the changed factory source files) fails when n > 0 and the
 *            affected parts together ran no test at all: the import graph found nothing, so nothing was measured.
 *
 * Node built-ins only: the summary job installs nothing.
 *
 * Run:
 *   node scripts/factory/ci-report.mjs record --part <name> --kind <kind> --input <report or log> --exit-file <file>
 *        --out <dir> [--shard <n>/<m>] [--scope full|affected]
 *   node scripts/factory/ci-report.mjs summary --check endCheck|quickCheck --results <dir> [--groups all|fast,pg,…]
 *        [--floor .github/factory-test-floor.json] [--sources <n>] [--note <text>]
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const FLOOR_FILE = '.github/factory-test-floor.json'
const KINDS = ['vitest', 'golden', 'browser', 'guards', 'exit']
const MAX_FAILURES = 50
const PART = /^[a-z0-9][a-z0-9-]{0,62}$/

function parseOptions(argv) {
  const options = {}
  for (let at = 0; at < argv.length; at += 2) {
    const name = argv[at]
    const value = argv[at + 1]
    if (!name.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(name)}`)
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
    options[name.slice(2)] = value
  }
  return options
}

const readText = (file) => (file && existsSync(file) ? readFileSync(file, 'utf8') : undefined)
// picocolors (vitest) colours its output when CI is set, even into a pipe.
const plain = (text) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
const firstLine = (text) => (String(text ?? '').split('\n').find((line) => line.trim() !== '') ?? '').trim().slice(0, 300)
const repoPath = (file) => (file.startsWith(ROOT) ? file.slice(ROOT.length) : file)

function readExit(file) {
  const text = readText(file)?.trim()
  return text !== undefined && /^\d+$/.test(text) ? Number(text) : null
}

function fromVitest(text) {
  if (text === undefined) return { note: 'no vitest report (the command stopped before it wrote one)' }
  let report
  try {
    report = JSON.parse(text)
  } catch (error) {
    return { note: `the vitest report is not JSON (${error.message})` }
  }
  const files = report.testResults ?? []
  const failures = []
  for (const file of files) {
    const failed = (file.assertionResults ?? []).filter((test) => test.status === 'failed')
    for (const test of failed) failures.push(`${repoPath(file.name)} › ${test.fullName ?? test.title}`)
    // A file that failed with no failed test: it did not load, or a hook (beforeAll) failed.
    if (file.status === 'failed' && failed.length === 0) failures.push(`${repoPath(file.name)}: ${firstLine(file.message) || 'failed outside a test'}`)
  }
  return {
    passed: report.numPassedTests ?? 0,
    failed: report.numFailedTests ?? 0,
    skipped: report.numPendingTests ?? 0,
    todo: report.numTodoTests ?? 0,
    files: files.length,
    failedFiles: files.filter((file) => file.status === 'failed').length,
    failures,
  }
}

const lastMatch = (text, pattern) => [...text.matchAll(pattern)].at(-1)

function fromGolden(text) {
  if (text === undefined) return { note: 'no log' }
  const clean = plain(text)
  const failures = [...clean.matchAll(/^ {2}FAIL {2}(.+)$/gm)].map((match) => match[1].trim())
  const line = lastMatch(clean, /golden-flow: (\d+) step\(s\): (\d+) passed, (\d+) todo, (\d+) failed, (\d+) skipped/g)
  if (!line) return { note: 'the golden flow printed no step count (it stopped before its report)', failures }
  const [, , passed, todo, failed, skipped] = line.map(Number)
  return { passed, failed, skipped, todo, failures }
}

function fromBrowser(text) {
  if (text === undefined) return { note: 'no log' }
  const clean = plain(text)
  const failures = [...clean.matchAll(/^ {2}(failed|timedOut|interrupted|not run) +(.+)$/gm)].map((match) => `${match[2].split(' — ')[0].trim()} (${match[1]})`)
  if (/the production-refuses-a-fake test FAILED/.test(clean)) failures.push('the production-refuses-a-fake test (platform/gateway boot)')
  const line = lastMatch(clean, /browser-golden-flow: (\d+) stage\(s\): (\d+) passed, (\d+) failed, (\d+) skipped/g)
  if (!line) return { note: 'the browser flow printed no stage count (it stopped before the spec ended)', failures }
  const [, , passed, failed, skipped] = line.map(Number)
  return { passed, failed, skipped, todo: 0, failures }
}

function fromGuards(text) {
  if (text === undefined) return { note: 'no log' }
  const clean = plain(text)
  const failures = [...clean.matchAll(/^FAIL {2}(\S+)/gm)].map((match) => match[1])
  const line = lastMatch(clean, /run-guards: (\d+) of (\d+) factory guards passed/g)
  if (!line) return { note: 'run-guards printed no count', failures }
  const [, passed, total] = line.map(Number)
  return { passed, failed: total - passed, skipped: 0, todo: 0, failures }
}

// An exit-code part (typecheck, migrate): its log, when given, only names what failed (tsc's errors, an Error line).
function fromExit(text) {
  if (text === undefined) return {}
  const failures = plain(text)
    .split('\n')
    .filter((line) => /error TS\d+:/.test(line) || /^\s*(Error|[A-Za-z]+Error)\b[:\s]/.test(line))
    .map((line) => line.trim().slice(0, 300))
  return { failures }
}

function record(options) {
  const { part, kind, input, out } = options
  if (!PART.test(part ?? '')) throw new Error(`--part must be lower-case letters, digits and dashes, not ${JSON.stringify(part)}`)
  if (!KINDS.includes(kind)) throw new Error(`--kind must be one of ${KINDS.join(', ')}`)
  if (!out) throw new Error('--out is required')
  let shard = null
  if (options.shard !== undefined) {
    const match = /^(\d+)\/(\d+)$/.exec(options.shard)
    if (!match || Number(match[1]) < 1 || Number(match[1]) > Number(match[2])) throw new Error(`--shard must be <n>/<m> with 1 <= n <= m, not ${options.shard}`)
    shard = { n: Number(match[1]), m: Number(match[2]) }
  }
  const scope = options.scope ?? 'full'
  if (!['full', 'affected'].includes(scope)) throw new Error(`--scope must be full or affected, not ${JSON.stringify(scope)}`)
  const exit = readExit(options['exit-file'])
  const text = readText(input)
  let read = { vitest: fromVitest, golden: fromGolden, browser: fromBrowser, guards: fromGuards, exit: fromExit }[kind](text)
  // `vitest --changed` with no related test exits 0 without writing a report: that is 0 tests, not a lost report.
  if (kind === 'vitest' && scope === 'affected' && exit === 0 && text === undefined) read = { passed: 0, failed: 0, skipped: 0, todo: 0, files: 0, failedFiles: 0 }
  const counted = kind !== 'exit'
  const passed = read.passed ?? 0
  const failed = read.failed ?? 0
  const failures = read.failures ?? []
  const result = {
    part,
    shard,
    kind,
    scope,
    exit,
    ran: counted ? passed + failed : null,
    passed: counted ? passed : null,
    failed: counted ? failed : null,
    skipped: counted ? (read.skipped ?? 0) : null,
    todo: counted ? (read.todo ?? 0) : null,
    ...(read.files !== undefined ? { files: read.files, failedFiles: read.failedFiles } : {}),
    failures: failures.slice(0, MAX_FAILURES),
    moreFailures: Math.max(0, failures.length - MAX_FAILURES),
    note: read.note ?? (exit === null ? 'the command did not run to its end (no exit code)' : null),
  }
  mkdirSync(out, { recursive: true })
  const file = join(out, `${part}${shard ? `-${shard.n}-of-${shard.m}` : ''}.json`)
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`)
  const counts = counted ? `, ran ${result.ran} (${passed} passed, ${failed} failed, ${result.skipped} skipped, ${result.todo} todo)` : ''
  console.log(`ci-report: ${part}${shard ? ` ${shard.n}/${shard.m}` : ''}${scope === 'affected' ? ' (affected tests only)' : ''} — exit ${exit ?? 'none'}${counts}${result.note ? ` — ${result.note}` : ''}`)
  for (const failure of result.failures) console.log(`  FAILED  ${failure}`)
  if (result.moreFailures > 0) console.log(`  … and ${result.moreFailures} more`)
}

function resultFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return resultFiles(path)
    return name.endsWith('.json') ? [path] : []
  })
}

const number = (value) => (value === null || value === undefined ? '' : String(value))

function summary(options) {
  const checkName = options.check
  const floorFile = resolve(ROOT, options.floor ?? FLOOR_FILE)
  const floors = JSON.parse(readFileSync(floorFile, 'utf8'))
  const check = floors[checkName]
  if (!check || typeof check !== 'object') throw new Error(`${repoPath(floorFile)} has no section ${JSON.stringify(checkName)}`)
  const groups = (options.groups ?? 'all').split(',').map((group) => group.trim())
  const parts = Object.entries(check).filter(([name]) => !name.startsWith('$'))
  const selected = (spec) => groups.includes('all') || spec.group === undefined || groups.includes(spec.group)
  const expected = new Map(parts.filter(([, spec]) => selected(spec)))

  const byPart = new Map()
  const unreadable = []
  for (const file of resultFiles(resolve(options.results ?? 'results'))) {
    try {
      const result = JSON.parse(readFileSync(file, 'utf8'))
      if (!byPart.has(result.part)) byPart.set(result.part, [])
      byPart.get(result.part).push(result)
    } catch (error) {
      unreadable.push(`${file}: ${error.message}`)
    }
  }

  const rows = []
  const problems = []
  const measured = {}
  const names = [...expected.keys(), ...[...byPart.keys()].filter((name) => !expected.has(name)).sort()]
  for (const name of names) {
    const spec = expected.get(name) ?? check[name]
    const results = byPart.get(name) ?? []
    const why = []
    if (!spec) why.push(`no entry in ${FLOOR_FILE} (add the part and its floor)`)
    else if (!expected.has(name)) why.push(`ran, but its group ${spec.group} was not selected`)
    if (results.length === 0) why.push('no result: the job did not run, or stopped before it recorded one')
    const sharded = results.filter((result) => result.shard)
    if (sharded.length > 0) {
      const totals = new Set(sharded.map((result) => result.shard.m))
      const seen = sharded.map((result) => result.shard.n).sort((a, b) => a - b)
      const m = [...totals][0]
      if (sharded.length !== results.length) why.push('shard results mixed with an unsharded one')
      else if (totals.size !== 1) why.push(`the shards name different totals (${[...totals].join(', ')})`)
      else if (seen.join(',') !== Array.from({ length: m }, (_, at) => at + 1).join(',')) {
        const missing = Array.from({ length: m }, (_, at) => at + 1).filter((n) => !seen.includes(n))
        why.push(`expected shards 1..${m} once each; missing ${missing.join(', ') || 'none'}, reported ${seen.join(', ')}`)
      }
    }
    const counted = results.some((result) => result.ran !== null)
    const sum = (field) => (counted ? results.reduce((total, result) => total + (result[field] ?? 0), 0) : null)
    const affected = results.some((result) => result.scope === 'affected')
    const row = { name, ran: sum('ran'), passed: sum('passed'), failed: sum('failed'), skipped: sum('skipped'), todo: sum('todo'), floor: spec?.min ?? null, affected }
    const exits = results.map((result) => result.exit)
    if (exits.includes(null)) why.push('a command did not run to its end')
    const bad = exits.filter((exit) => exit !== null && exit !== 0)
    if (bad.length > 0) why.push(`exit ${[...new Set(bad)].join(', ')}`)
    if (row.failed) why.push(`${row.failed} failed`)
    // A floor counts in a full run only: an affected run runs the tests a change can reach, however few.
    if (spec?.min !== undefined && !affected && (row.ran ?? 0) < spec.min) why.push(`ran ${row.ran ?? 0} < floor ${spec.min}`)
    for (const result of results) if (result.note) why.push(result.shard ? `shard ${result.shard.n}: ${result.note}` : result.note)
    if (counted && !affected && why.length === 0) measured[name] = row.ran
    row.ok = why.length === 0
    row.why = why.join('; ')
    row.failures = results.flatMap((result) => [
      ...(result.failures ?? []).map((failure) => (result.shard ? `[${result.shard.n}/${result.shard.m}] ${failure}` : failure)),
      ...(result.moreFailures ? [`… and ${result.moreFailures} more${result.shard ? ` in shard ${result.shard.n}` : ''}`] : []),
    ])
    rows.push(row)
    if (!row.ok) problems.push(`${name}: ${row.why}`)
  }
  for (const line of unreadable) problems.push(`unreadable result ${line}`)
  // The affected run's one count rule: changed factory sources, yet not one related unit test ran anywhere.
  const affectedRows = rows.filter((row) => row.affected)
  const sources = Number(options.sources ?? 0)
  let zero = null
  if (affectedRows.length > 0) {
    const ran = affectedRows.reduce((total, row) => total + (row.ran ?? 0), 0)
    zero = { ran, parts: affectedRows.length, sources }
    if (sources > 0 && ran === 0) problems.push(`affected unit tests: ${sources} factory source file(s) changed, yet the ${affectedRows.length} affected part(s) ran no test at all (the import graph found nothing: could not measure)`)
  }

  const lines = []
  lines.push(`### Factory ${checkName === 'quickCheck' ? 'quick check' : 'end check'} — ${rows.filter((row) => row.ok).length} of ${rows.length} parts green (groups: ${groups.join(', ')})`)
  if (options.note) lines.push('', options.note)
  if (zero) lines.push('', `Affected unit run: ${zero.ran} test(s) ran in ${zero.parts} part(s) for ${zero.sources} changed factory source file(s); floors apply to a full run only${zero.sources > 0 && zero.ran === 0 ? ' — **FAIL: no related test ran**' : ''}.`)
  lines.push('')
  lines.push('| Part | Result | Ran | Passed | Failed | Skipped | Todo | Floor | Why |')
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---|')
  for (const row of rows) {
    lines.push(`| ${row.name} | ${row.ok ? 'pass' : '**FAIL**'} | ${number(row.ran)} | ${number(row.passed)} | ${number(row.failed)} | ${number(row.skipped)} | ${number(row.todo)} | ${row.affected && row.floor !== null ? `(${row.floor})` : number(row.floor)} | ${row.why.replace(/\|/g, '/')} |`)
  }
  const failing = rows.filter((row) => row.failures.length > 0)
  if (failing.length > 0) {
    lines.push('', '#### Failing tests')
    for (const row of failing) {
      lines.push('', `**${row.name}**`, '```')
      lines.push(...row.failures)
      lines.push('```')
    }
  }
  if (unreadable.length > 0) lines.push('', '#### Unreadable results', ...unreadable.map((line) => `- ${line}`))
  lines.push('', `This run's counts as floors (the green parts; raise a floor in ${FLOOR_FILE} by hand, never lower it to pass):`, '```json', JSON.stringify(measured), '```')
  const text = lines.join('\n')

  console.log('=== ci-report summary ===')
  console.log(text)
  console.log('=== end ci-report summary ===')
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
  if (problems.length > 0) {
    console.log(`\nci-report: ${problems.length} problem(s):`)
    for (const problem of problems) console.log(`  ${problem}`)
    process.exit(1)
  }
  console.log(`\nci-report: every part passed${zero ? ' (an affected unit run: its floors count in a full run only)' : ' and ran at least its floor'}`)
}

const [command, ...rest] = process.argv.slice(2)
try {
  if (command === 'record') record(parseOptions(rest))
  else if (command === 'summary') summary(parseOptions(rest))
  else throw new Error('the command is record or summary')
} catch (error) {
  console.error(`ci-report: ${error.message}`)
  process.exit(2)
}
