import { build } from 'esbuild'
await build({stdin:{contents:`
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProvenanceMark } from './apps/web/src/design-system/grid/renderers/provenanceMark.tsx';
import { describeCellSource } from './apps/web/src/design-system/grid/renderers/provenance.ts';
export const specimen = renderToStaticMarkup(h('div', {className:'nds-ag-wrap', 'data-lx6-specimen':'true'},
 h('strong', null, 'DS contract specimen · synthetic states · no catalogue write'),
 ...['inherited','pinned','ai','aiStale','outdated','formula','mapped','refused'].map(member => {
 const from = member === 'refused' ? 'German title exceeds 200 bytes for Amazon · DE.' : member === 'outdated' ? 'Italian · source' : 'German · shared';
 const source=describeCellSource({provenance:{member,from}});
 return h('div', {className:'ag-cell nds-ag-cell nds-cell-value '+(member==='outdated'?'nds-cell-is-outdated':''),title:source.tooltip},
 h(ProvenanceMark,{provenance:source.member,from:source.from}),h('span',{className:'nds-cell-value-text'},member+' · '+source.tooltip));
 })))`,resolveDir:process.cwd(),loader:'tsx'},outfile:'docs/audits/2026-09-12-language-axis/step6/specimen.mjs',bundle:true,packages:'external',format:'esm',platform:'node',jsx:'automatic'})
