// Inline the DS's own auxiliary types into each component's emitted contract.
//
// The converter resolves a component's props structurally but leaves referenced
// named types as bare names — so `Tabs.d.ts` says `items: TabItem[]` and never
// says what a TabItem is. The design agent reads only that file, so a dangling
// name is a hole in the contract it codes against.
//
// There is no config knob for auxiliary declarations (cfg.dtsPropsFor supplies a
// props BODY only, and lib/dts.mjs always returns an empty prelude), so we inline
// the shapes structurally instead. This reads the shapes out of the DS source
// every run rather than freezing them into config by hand, so a type that gains a
// field is picked up by the next sync.
//
// Usage (two-pass — needs an emitted bundle to read the bodies from):
//   node .ds-sync/package-build.mjs … --out ./ds-bundle
//   node .design-sync/ds-pkg/gen-dts-props.mjs            # patches config
//   node .ds-sync/package-build.mjs … --out ./ds-bundle   # applies it
import { readFileSync, readdirSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const dsRoot = join(repo, 'apps/web/src/design-system');
const bundle = join(repo, 'ds-bundle/components');
const configPath = join(repo, '.design-sync/config.json');

// Types that resolve on their own: TS lib globals, DOM interfaces, React namespace.
const GLOBAL = new Set(['Set', 'Map', 'Array', 'Date', 'Promise', 'Record', 'Partial', 'Readonly',
  'Omit', 'Pick', 'Exclude', 'Extract', 'File', 'FileList', 'Blob', 'Error', 'Event', 'RegExp',
  'React', 'JSX', 'T']);
const isDomGlobal = (n) => /^(HTML[A-Za-z]*Element|SVG[A-Za-z]*Element|Element|Node|Document|Window|DataTransfer|AbortSignal)$/.test(n);
// Names that live in the React namespace and must be qualified to resolve.
const REACT_NS = /^(ReactNode|ReactElement|CSSProperties|Ref|RefObject|MouseEvent|KeyboardEvent|ChangeEvent|FormEvent|FocusEvent|DragEvent|ComponentType|ElementType|[A-Za-z]*HTMLAttributes|HTMLProps|PropsWithChildren)$/;

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(d, e.name)) : /\.tsx?$/.test(e.name) ? [join(d, e.name)] : []);

// ── 1. harvest every exported interface/type in the DS source ────────────
const decls = new Map();
for (const f of walk(dsRoot)) {
  const src = readFileSync(f, 'utf8');
  const rx = /export\s+(interface|type)\s+([A-Z][A-Za-z0-9]*)\s*(<[^{=]*>)?\s*(\{|=)/g;
  let m;
  while ((m = rx.exec(src))) {
    const [, kind, name] = m;
    let text;
    if (m[4] === '{') {
      let d = 0, i = src.indexOf('{', m.index), j = i;
      for (; j < src.length; j++) {
        if (src[j] === '{') d++;
        else if (src[j] === '}' && --d === 0) break;
      }
      text = src.slice(i, j + 1);
    } else {
      // `type X = …` — union or alias. A blank-line heuristic swallows the next
      // declaration (union members are separated by blank-ish lines in this repo),
      // so consume balanced and stop at the first top-level line that opens a new
      // declaration. Union continuation lines start with `|` and are kept.
      const rest = src.slice(src.indexOf('=', m.index) + 1);
      const OPENS = /^\s*(export|const|let|var|function|interface|type|class)\b/;
      let d = 0, end = rest.length;
      for (let k = 0; k < rest.length; k++) {
        const ch = rest[k];
        if ('{(['.includes(ch)) d++;
        else if ('})]'.includes(ch)) d--;
        else if (ch === '\n' && d <= 0) {
          const after = rest.slice(k + 1);
          if (OPENS.test(after) || /^\s*$/.test(after)) { end = k; break; }
        }
      }
      text = rest.slice(0, end).trim().replace(/;$/, '');
    }
    if (!decls.has(name)) decls.set(name, text);
  }
}

// Prefix a React-namespace name once — `React.React.ReactNode` otherwise.
const qualify = (s, ref) => s.replace(new RegExp(`(?<!React\\.)(?<![A-Za-z0-9_.])${ref}\\b`, 'g'), `React.${ref}`);
// Substituting a generic name leaves its argument list behind (`Column<T>` ->
// `{…}<T>`), so consume the args with the name. A union expanded into an array
// position also needs parenthesising: `A | B[]` means `A | (B[])`, not `(A|B)[]`.
const hasTopLevelUnion = (t) => {
  let d = 0;
  for (const ch of t) {
    if ('{(['.includes(ch)) d++;
    else if ('})]'.includes(ch)) d--;
    else if (ch === '|' && d === 0) return true;
  }
  return false;
};
const substitute = (s, ref, inline) => {
  // A flattened alias can carry a trailing member separator; inside parens or an
  // array suffix that is a syntax error, so strip it before splicing.
  const clean = inline.trim().replace(/;+$/, '');
  const safe = hasTopLevelUnion(clean) ? `(${clean})` : clean;
  return s.replace(new RegExp(`(?<![A-Za-z0-9_.])${ref}\\s*<[^<>]*>`, 'g'), safe)
          .replace(new RegExp(`(?<![A-Za-z0-9_.])${ref}\\b`, 'g'), safe);
};

// ── 2. flatten a declaration into a single-line inline type literal ──────
const flatten = (name, depth = 0, seen = new Set()) => {
  if (depth > 3 || seen.has(name) || !decls.has(name)) return null;
  const next = new Set(seen).add(name);
  let t = decls.get(name)
    .replace(/\/\*\*[\s\S]*?\*\//g, ' ')   // block/JSDoc comments
    .replace(/\/\/[^\n]*/g, ' ')            // line comments
    .replace(/\s+/g, ' ')
    .trim();
  // property separators: newlines became spaces, so re-insert `;` between members
  t = t.replace(/([A-Za-z0-9_\]\)'"|}])\s+([A-Za-z_][A-Za-z0-9_]*\??\s*:)/g, '$1; $2');
  // resolve nested named refs
  for (const ref of new Set(t.match(/\b[A-Z][A-Za-z0-9]*\b/g) ?? [])) {
    if (GLOBAL.has(ref) || isDomGlobal(ref)) continue;
    if (REACT_NS.test(ref)) { t = qualify(t, ref); continue; }
    const inner = flatten(ref, depth + 1, next);
    if (inner) t = substitute(t, ref, inner);
  }
  return t.replace(/;\s*}/g, ' }').replace(/\s+/g, ' ');
};

// ── 3. rewrite each emitted props body ───────────────────────────────────
const out = {};
for (const group of readdirSync(bundle)) {
  for (const name of readdirSync(join(bundle, group))) {
    const p = join(bundle, group, name, `${name}.d.ts`);
    if (!existsSync(p)) continue;
    const txt = readFileSync(p, 'utf8');
    const m = txt.match(new RegExp(`export interface ${name}Props(<[^>]*>)?\\s*\\{\\n([\\s\\S]*?)\\n\\}`));
    if (!m) continue;
    const generic = !!m[1];
    let body = m[2];
    const declaredHere = new Set([...txt.matchAll(/(?:interface|type)\s+([A-Z][A-Za-z0-9]*)/g)].map((x) => x[1]));
    let changed = false;
    for (const ref of new Set(body.match(/\b[A-Z][A-Za-z0-9]*\b/g) ?? [])) {
      if (declaredHere.has(ref) || GLOBAL.has(ref) || isDomGlobal(ref)) continue;
      if (REACT_NS.test(ref)) { body = qualify(body, ref); changed = true; continue; }
      const inline = flatten(ref);
      if (inline) { body = substitute(body, ref, inline); changed = true; }
    }
    // A generic props interface loses its <T> under cfg.dtsPropsFor (lib/dts.mjs
    // returns generics:''), so a surviving bare T would dangle — widen it.
    if (generic && /\bT\b/.test(body)) { body = body.replace(/\bT\b/g, 'any'); changed = true; }
    if (changed) out[name] = body;
  }
}

const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
cfg.dtsPropsFor = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
const tmp = configPath + '.tmp';
writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
renameSync(tmp, configPath);   // atomic — parallel preview agents read this file
console.error(`gen-dts-props: inlined auxiliary types into ${Object.keys(out).length} contract(s)`);
