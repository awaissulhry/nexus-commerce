/**
 * The dash's a11y rule, in a `.ts` module ON PURPOSE.
 *
 * `apps/web` vitest is `environment: 'node'` by deliberate decision and jsdom is not a devDependency
 * anywhere, so a rendered assertion on `EmptyValue` cannot exist in this repo. Extracting the rule
 * out of the component is the standing answer — but extracting it into `cells.tsx` was not enough:
 * a node test importing a `.tsx` fails at PARSE, before any test runs ("content contains invalid JS
 * syntax"). The rule has to leave the JSX file entirely to be testable at all.
 *
 * 🔴 What it defends. `<EmptyValue measuredZero />` used to render `aria-label={undefined}` — no
 * accessible name at all on an element whose only content is an em-dash — while the UNMEASURED case
 * was named "Not measured". A screen-reader user got a name for the value we know nothing about and
 * silence for the one we measured: the exact inversion of this primitive's purpose. Found by FE.1
 * (hub #313), latent not live — all 8 `zero: 'dash'` call sites pass a reason today.
 */
export declare function emptyValueA11y(measuredZero: boolean, title?: string): {
    title?: string;
    ariaLabel: string;
};
