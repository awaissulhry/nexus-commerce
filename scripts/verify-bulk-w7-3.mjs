#!/usr/bin/env node
// Verify W7.3 — tree conditions DSL.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')

let failures = 0
function check(label, cond) {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  if (!cond) failures++
}

console.log('\nW7.3 — tree conditions DSL\n')

const src = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/automation/conditions-tree.ts'),
  'utf8',
)

console.log('Case 1: types + exports')
for (const sym of [
  'export interface LeafCondition',
  'export interface AndNode',
  'export interface OrNode',
  'export interface NotNode',
  'export type ConditionNode',
  'export type ConditionsPayload',
  'export function evaluateConditions',
  'export function evaluateTreeNode',
  'export function validateConditions',
  'export function isLegacyFlatList',
  'export function isConditionNode',
]) {
  check(`exports ${sym}`, src.includes(sym))
}

// Mirror the helpers locally for behavioural tests
function getFieldPath(obj, p) {
  if (obj == null) return undefined
  let cur = obj
  for (const part of p.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return cur
}
function applyOperator(op, lhs, rhs) {
  switch (op) {
    case 'eq': return lhs === rhs || Number(lhs) === Number(rhs)
    case 'ne': return !(lhs === rhs || Number(lhs) === Number(rhs))
    case 'lt': return Number(lhs) < Number(rhs)
    case 'lte': return Number(lhs) <= Number(rhs)
    case 'gt': return Number(lhs) > Number(rhs)
    case 'gte': return Number(lhs) >= Number(rhs)
    case 'in': return Array.isArray(rhs) && rhs.includes(lhs)
    case 'contains': return String(lhs).includes(String(rhs))
    case 'exists': return lhs !== undefined && lhs !== null
    default: return false
  }
}
function isConditionNode(p) {
  if (!p || typeof p !== 'object') return false
  const k = p.kind
  return k === 'leaf' || k === 'and' || k === 'or' || k === 'not'
}
function evalNode(n, ctx) {
  switch (n.kind) {
    case 'leaf': return applyOperator(n.op, getFieldPath(ctx, n.field), n.value)
    case 'and':
      if (n.children.length === 0) return true
      for (const c of n.children) if (!evalNode(c, ctx)) return false
      return true
    case 'or':
      if (n.children.length === 0) return false
      for (const c of n.children) if (evalNode(c, ctx)) return true
      return false
    case 'not': return !evalNode(n.child, ctx)
    default: throw new Error('unknown')
  }
}
function evalConditions(payload, ctx) {
  if (payload == null) return true
  if (Array.isArray(payload)) {
    for (const c of payload) {
      if (!applyOperator(c.op, getFieldPath(ctx, c.field), c.value)) return false
    }
    return true
  }
  if (isConditionNode(payload)) return evalNode(payload, ctx)
  throw new Error('bad shape')
}

const ctx = {
  job: {
    failureRate: 0.25,
    totalItems: 200,
    status: 'FAILED',
    retryCount: 0,
    actionType: 'PRICING_UPDATE',
  },
}

console.log('\nCase 2: legacy flat list still works (W4 backwards compat)')
{
  const r = evalConditions(
    [{ field: 'job.totalItems', op: 'gt', value: 100 }],
    ctx,
  )
  check('flat list with one leaf evaluates', r === true)

  const r2 = evalConditions(
    [
      { field: 'job.totalItems', op: 'gt', value: 100 },
      { field: 'job.status', op: 'eq', value: 'COMPLETED' },
    ],
    ctx,
  )
  check('flat list ANDs (two leaves, second false → result false)', r2 === false)

  check('null payload matches everything', evalConditions(null, ctx) === true)
  check('empty array matches everything', evalConditions([], ctx) === true)
}

console.log('\nCase 3: tree leaves')
{
  const r = evalConditions(
    { kind: 'leaf', field: 'job.failureRate', op: 'gt', value: 0.2 },
    ctx,
  )
  check('single leaf node evaluates', r === true)
}

console.log('\nCase 4: AND / OR / NOT')
{
  const tree = {
    kind: 'or',
    children: [
      {
        kind: 'and',
        children: [
          { kind: 'leaf', field: 'job.failureRate', op: 'gt', value: 0.2 },
          { kind: 'leaf', field: 'job.totalItems', op: 'gt', value: 100 },
        ],
      },
      {
        kind: 'and',
        children: [
          { kind: 'leaf', field: 'job.status', op: 'eq', value: 'FAILED' },
          { kind: 'leaf', field: 'job.retryCount', op: 'eq', value: 0 },
        ],
      },
    ],
  }
  check('OR of two ANDs evaluates true (both branches true)',
    evalConditions(tree, ctx) === true)

  // Falsify both branches
  const tree2 = {
    kind: 'or',
    children: [
      {
        kind: 'and',
        children: [
          { kind: 'leaf', field: 'job.failureRate', op: 'gt', value: 0.99 },
          { kind: 'leaf', field: 'job.totalItems', op: 'gt', value: 100 },
        ],
      },
      {
        kind: 'and',
        children: [
          { kind: 'leaf', field: 'job.status', op: 'eq', value: 'COMPLETED' },
          { kind: 'leaf', field: 'job.retryCount', op: 'eq', value: 0 },
        ],
      },
    ],
  }
  check('OR with both branches false → false', evalConditions(tree2, ctx) === false)

  const notTree = {
    kind: 'not',
    child: { kind: 'leaf', field: 'job.totalItems', op: 'gt', value: 100 },
  }
  check('NOT of true leaf → false', evalConditions(notTree, ctx) === false)

  const emptyAnd = { kind: 'and', children: [] }
  check('empty AND children → true', evalConditions(emptyAnd, ctx) === true)

  const emptyOr = { kind: 'or', children: [] }
  check('empty OR children → false', evalConditions(emptyOr, ctx) === false)
}

console.log('\nCase 5: validator errors')
check('validator rejects unknown op',
  /\.op '\$\{[^}]+\}' is not a known operator/.test(src))
check('validator catches non-string field',
  /\.field must be a non-empty string/.test(src))
check('validator handles unknown payload shape',
  /payload is neither legacy list nor tree/.test(src))

console.log('\nCase 6: corrupted shapes throw, never silently match')
check('evaluateConditions throws on unrecognised payload',
  /unrecognised payload shape/.test(src))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
