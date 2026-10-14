import { test } from 'node:test'
import assert from 'node:assert/strict'
const B = await import('../fit-finder/xavia-fit-body.js')
const male = B.decodeBody(await import('../fit-finder/body/xavia-fit-body-male.js'))
const female = B.decodeBody(await import('../fit-finder/body/xavia-fit-body-female.js'))

test('both packed bodies decode completely and come from MakeHuman CC0 assets', () => {
  for (const body of [male, female]) {
    assert.match(body.meta.source, /MakeHuman.*CC0/)
    assert.equal(body.base.length, body.meta.vertices * 3)
    assert.equal(body.indices.length, body.meta.triangles * 3)
    assert.ok(body.indices.every(i => i < body.meta.vertices))
    assert.deepEqual(Object.keys(body.morphs).sort(), ['bustDecr', 'bustIncr', 'hipsDecr', 'hipsIncr', 'waistDecr', 'waistIncr', 'weightMinus', 'weightPlus'])
    assert.ok(body.top > 150 && body.top < 185, `height ${body.top}`)
  }
})

test('the mannequin takes the shopper\'s height, chest, waist and hips to within half a centimetre', () => {
  const cases = [
    [male, { height: 178, chest: 102.5, waist: 90 }, 80], [male, { height: 165, chest: 90, waist: 76 }, 60],
    [male, { height: 192, chest: 122, waist: 114, hips: 115 }, 118], [female, { height: 165, chest: 88, waist: 72 }, 58],
    [female, { height: 170, chest: 102, waist: 88, hips: 108 }, 80], [female, { height: 155, chest: 80, waist: 64, hips: 90 }, 48],
  ]
  for (const [body, values, weightKg] of cases) {
    const shape = B.shapeFor(body, { values, weightKg }), P = B.applyShape(body, shape)
    let top = 0
    for (let i = 1; i < P.length; i += 3) top = Math.max(top, P[i])
    assert.ok(Math.abs(top - values.height) < 0.5, `height ${top} for ${values.height}`)
    const got = B.measure(body, P, shape.scale)
    for (const m of ['chest', 'waist', 'hips']) if (values[m]) assert.ok(Math.abs(got[m] - values[m]) < 0.5, `${m} ${got[m].toFixed(1)} for ${values[m]}`)
  }
})

test('a heavier build at the same height adds weight everywhere (the weight morph), not only at the tape lines', () => {
  const light = B.applyShape(male, B.shapeFor(male, { values: { height: 178 }, weightKg: 62 }))
  const heavy = B.applyShape(male, B.shapeFor(male, { values: { height: 178 }, weightKg: 105 }))
  const a = B.measure(male, light, 178 / male.top), b = B.measure(male, heavy, 178 / male.top)
  for (const m of ['chest', 'waist', 'hips']) assert.ok(b[m] > a[m] + 3, `${m}: ${a[m].toFixed(1)} → ${b[m].toFixed(1)}`)
})

test('rings follow the torso only and normals are unit length', () => {
  const P = B.applyShape(female, { scale: 1, weights: {} })
  const r = B.ring(P, female.torso, female.meta.levels.waist)
  assert.equal(r.points.length, 72)
  assert.ok(r.circumference > 55 && r.circumference < 90, `waist ${r.circumference}`)
  assert.equal(B.ring(P, female.torso, 400), null, 'nothing above the head')
  const N = B.computeNormals(P, female.indices)
  for (let i = 0; i < N.length; i += 3 * 97) assert.ok(Math.abs(Math.hypot(N[i], N[i + 1], N[i + 2]) - 1) < 1e-4)
})
