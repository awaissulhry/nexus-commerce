/** Proof that the two-character escape in a template literal is byte-identical to the raw NUL the file held. */
import { readFileSync } from 'node:fs'

const NUL = String.fromCharCode(0)
const oldSrc = readFileSync('/private/tmp/claude-501/-Users-awais-nexus-commerce/fe338857-0952-445e-a37c-e26d3d200fc5/scratchpad/value-map.bak', 'utf8')
const newSrc = readFileSync('apps/api/src/services/pim/value-map.service.ts', 'utf8')

// 1. The ONLY difference between the two files is the escape. Nothing else moved.
const normalised = newSrc.split('\\0').join(NUL)
console.log('files identical once the escape is read back as U+0000:', normalised === oldSrc)
console.log('length delta (4 NULs became 4 two-char escapes):', newSrc.length - oldSrc.length)

// 2. The KEY FUNCTIONS produce byte-identical output. Both forms evaluated side by side.
const rawKey = (a: string, b: string) => a + NUL + b
const escKey = (a: string, b: string) => `${a}\0${b}`
const cases: Array<[string, string]> = [['color', 'Nero'], ['', ''], [`a${NUL}b`, 'c'], ['size', 'XXS']]
let same = true
for (const [a, b] of cases) {
  const r = rawKey(a, b)
  const e = escKey(a, b)
  if (r !== e || Buffer.compare(Buffer.from(r, 'utf8'), Buffer.from(e, 'utf8')) !== 0) same = false
}
console.log('key output byte-identical on', cases.length, 'cases:', same)
console.log('one sample, hex:', Buffer.from(escKey('color', 'Nero'), 'utf8').toString('hex'))

// 3. POSITIVE CONTROL — the comparison above must be capable of failing.
const wrong = (a: string, b: string) => `${a}|${b}`
console.log('control: a different separator IS detected as different:', wrong('color', 'Nero') !== escKey('color', 'Nero'))

// 4. The collision-proof property the separator exists for survives.
console.log('control: ("a","b c") and ("a b","c") stay DISTINCT keys:',
  escKey('a', 'b c') !== escKey('a b', 'c'))
