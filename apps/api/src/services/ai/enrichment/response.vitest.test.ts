/**
 * PES.8 — the model-response path, exercised without a model.
 *
 * Under hub ruling #13 live generation is held indefinitely, so these are the only tests this path
 * will get before the first real run. They are written for that: each one is a rule that decides
 * whether something a model wrote is put in front of an operator, and most of them are refusals.
 */
import { describe, expect, it } from 'vitest'

import type { CellAddress } from './cell-key.js'
import type { CellConstraint } from './constraints.js'
import { draftsFromResponse } from './response.js'

const col = (over: Partial<CellConstraint> = {}): CellConstraint => ({
  columnKey: 'item_name',
  writeField: 'name',
  label: 'Title',
  kind: 'text',
  requiredBy: [],
  ...over,
})

const run = (
  fields: Record<string, unknown>,
  constraints: CellConstraint[],
  current: Record<string, unknown> = {},
) =>
  draftsFromResponse({
    fields,
    constraints,
    productId: 'p1',
    addressFor: (writeField): CellAddress => ({
      channel: null,
      marketplace: null,
      aliasId: null,
      locale: null,
      writeField,
    }),
    currentValue: (address) =>
      address.writeField in current
        ? { found: true, value: current[address.writeField] }
        : { found: true, value: null },
    promptHash: () => 'hash',
  })

describe('draftsFromResponse', () => {
  it('turns a well-formed answer into a pending draft with its provenance', () => {
    const out = run(
      { item_name: { value: 'A better title', confidence: 'high', reason: 'from the description' } },
      [col({ maxLength: 200, capFrom: 'Amazon · IT' })],
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      productId: 'p1',
      cellKey: 'master:name',
      columnKey: 'item_name',
      draftValue: 'A better title',
      status: 'pending',
      confidence: 'high',
      rationale: 'from the description',
      violations: null,
    })
    expect(out[0].capsUsed).toMatchObject({ maxLength: 200, capFrom: 'Amazon · IT' })
  })

  it('accepts a bare value, not just the documented envelope', () => {
    // A model that answers the question in the wrong shape has still answered it.
    const out = run({ item_name: 'A better title' }, [col()])
    expect(out).toHaveLength(1)
    expect(out[0].draftValue).toBe('A better title')
    expect(out[0].confidence).toBe('medium')
  })

  it('DROPS a field nobody asked for', () => {
    // The model volunteering a cell outside the operator's selection is the scope creep the
    // review flow exists to prevent — and it would carry no caps, having never been shown any.
    const out = run(
      {
        item_name: { value: 'ok' },
        product_tax_code: { value: 'A_GEN_TAX', confidence: 'high' },
      },
      [col()],
    )
    expect(out.map((d) => d.columnKey)).toEqual(['item_name'])
  })

  it('DROPS a low-confidence answer, as the prompt promises', () => {
    const out = run({ item_name: { value: 'a guess', confidence: 'low' } }, [col()])
    expect(out).toEqual([])
  })

  it('DROPS empty and null answers', () => {
    const out = run(
      { item_name: { value: '' }, description: { value: null } },
      [col(), col({ columnKey: 'description', writeField: 'description' })],
    )
    expect(out).toEqual([])
  })

  it('KEEPS an over-cap value as `failed`, and does NOT trim it to fit', () => {
    // The rule this whole lane turns on: a trimmed value is copy the model did not write and
    // nobody reviewed. It is kept, marked, and shown with its reason.
    const long = 'x'.repeat(260)
    const out = run({ item_name: { value: long, confidence: 'high' } }, [
      col({ maxLength: 200, capFrom: 'Amazon · IT' }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].status).toBe('failed')
    expect(out[0].draftValue).toBe(long)
    expect(String(out[0].draftValue)).toHaveLength(260)
    expect(out[0].violations).toHaveLength(1)
  })

  it('catches a value that fits the character cap but busts the BYTE cap', () => {
    // 150 accented characters, 300 UTF-8 bytes. The failure the existing generator cannot see.
    const out = run({ item_name: { value: 'à'.repeat(150) } }, [col({ maxLength: 200, maxBytes: 200 })])
    expect(out[0].status).toBe('failed')
    expect((out[0].violations as Array<{ kind: string }>)[0].kind).toBe('over_max_bytes')
  })

  it('keeps an off-list value offerable, but flagged', () => {
    // A published enum is routinely behind what the channel accepts, so this warns, never blocks.
    const out = run({ material: { value: 'Cordura' } }, [
      col({ columnKey: 'material', writeField: 'attr_material', kind: 'select', options: ['Leather'], mode: 'strict' }),
    ])
    expect(out[0].status).toBe('pending')
    expect((out[0].violations as Array<{ severity: string }>)[0].severity).toBe('warn')
  })

  it('DROPS a proposal identical to what the cell already holds', () => {
    const out = run({ item_name: { value: 'Same title' } }, [col()], { name: 'Same title' })
    expect(out).toEqual([])
  })

  it('still offers an over-cap value even when it matches the current cell', () => {
    // The no-op check must not swallow a violation: the operator needs to see that what is
    // already in the cell breaks the channel's cap.
    const long = 'x'.repeat(260)
    const out = run({ item_name: { value: long } }, [col({ maxLength: 200 })], { name: long })
    expect(out).toHaveLength(1)
    expect(out[0].status).toBe('failed')
  })

  it('records the base value as the diff\'s left-hand side', () => {
    const out = run({ item_name: { value: 'new' } }, [col()], { name: 'old' })
    expect(out[0]).toMatchObject({ baseValue: 'old', baseSource: 'stored' })
  })

  it('handles a list value member-wise', () => {
    const out = run({ bullet_point: { value: ['one', 'x'.repeat(800)] } }, [
      col({ columnKey: 'bullet_point', writeField: 'bulletPoints', maxLength: 700 }),
    ])
    expect(out[0].status).toBe('failed')
    expect((out[0].violations as Array<{ message: string }>)[0].message).toContain('item 2')
  })

  it('survives junk without throwing', () => {
    expect(run({}, [col()])).toEqual([])
    expect(run({ item_name: undefined as unknown as object }, [col()])).toEqual([])
    expect(run({ item_name: { value: { nested: true } } }, [col()])[0].status).toBe('failed')
  })

  it('truncates only the RATIONALE, never the value', () => {
    // The reason is telemetry and has a column limit; the value is the thing under review.
    const out = run({ item_name: { value: 'fine', reason: 'r'.repeat(900) } }, [col()])
    expect((out[0].rationale ?? '').length).toBe(400)
    expect(out[0].draftValue).toBe('fine')
  })
})
