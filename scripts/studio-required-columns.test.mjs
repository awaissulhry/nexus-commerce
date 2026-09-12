import test from 'node:test'
import assert from 'node:assert/strict'
import { compareRequiredColumns, requiredColumnKeys, sameRequiredSet } from './studio-required-columns.mjs'

const columns = keys => keys.map(key => ({ key, requiredBy: ['fixture'] }))
test('measures each coordinate without imposing another coordinate’s denominator', () => {
  for (const keys of [['name'], ['productType', 'brand', 'name', 'description', 'bulletPoints_1', 'supplier_declared_dg_hz_regulation', 'fabric_type', 'country_of_origin']]) {
    const reading = compareRequiredColumns(columns(keys), columns([...keys].reverse()))
    assert.equal(reading.ok, true)
    assert.equal(reading.declared.length, keys.length)
  }
})
test('a missing required declaration cannot produce a passing witness', () => {
  const reading = compareRequiredColumns(columns(['name', 'brand']), columns(['name', 'price']))
  assert.equal(reading.ok, false)
  assert.deepEqual(reading.missing, ['brand'])
  assert.deepEqual(reading.extra, ['price'])
})
test('absent, duplicate and empty measurements never certify required fit', () => {
  assert.throws(() => requiredColumnKeys(undefined))
  assert.throws(() => requiredColumnKeys(columns(['name', 'name'])))
  assert.equal(compareRequiredColumns([], []).ok, false)
  assert.equal(sameRequiredSet(['name'], ['name', 'brand']), false)
})
