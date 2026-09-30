/** The function catalogue, for the editor's autocomplete + help. */
export interface ExprFunctionDoc {
  name: string
  signature: string
  group: 'Logic' | 'Text' | 'Number' | 'Pricing' | 'Rules'
  summary: string
}

export const EXPR_FUNCTIONS: ExprFunctionDoc[] = [
  { name: 'if',        signature: 'if(condition, then, else?)', group: 'Logic',   summary: 'Pick one of two values. Only the taken branch is evaluated.' },
  { name: 'ifblank',   signature: 'ifblank(value, fallback)',    group: 'Logic',   summary: 'The value, or the fallback when it is empty. Short for if(isblank(x), y, x).' },
  { name: 'coalesce',  signature: 'coalesce(a, b, …)',          group: 'Logic',   summary: 'First value that is not empty.' },
  { name: 'isblank',   signature: 'isblank(value)',             group: 'Logic',   summary: 'True when empty. 0 and false are NOT empty.' },
  { name: 'notblank',  signature: 'notblank(value)',            group: 'Logic',   summary: 'The opposite of isblank.' },
  { name: 'contains',  signature: 'contains(text, part)',       group: 'Logic',   summary: 'Case-insensitive substring test.' },
  { name: 'startswith',signature: 'startswith(text, part)',     group: 'Logic',   summary: 'Case-insensitive prefix test.' },
  { name: 'endswith',  signature: 'endswith(text, part)',       group: 'Logic',   summary: 'Case-insensitive suffix test.' },
  { name: 'concat',    signature: 'concat(a, b, …)',            group: 'Text',    summary: 'Join values as text. `&` also joins text; `+` adds numeric values.' },
  { name: 'text',      signature: 'text(value)',                group: 'Text',    summary: 'Force a value to text.' },
  { name: 'upper',     signature: 'upper(text)',                group: 'Text',    summary: 'UPPERCASE.' },
  { name: 'lower',     signature: 'lower(text)',                group: 'Text',    summary: 'lowercase.' },
  { name: 'title',     signature: 'title(text)',                group: 'Text',    summary: 'Title Case.' },
  { name: 'trim',      signature: 'trim(text)',                 group: 'Text',    summary: 'Strip surrounding whitespace.' },
  { name: 'len',       signature: 'len(text)',                  group: 'Text',    summary: 'Character count.' },
  { name: 'left',      signature: 'left(text, n)',              group: 'Text',    summary: 'First n characters.' },
  { name: 'right',     signature: 'right(text, n)',             group: 'Text',    summary: 'Last n characters.' },
  { name: 'substr',    signature: 'substr(text, start, len?)',  group: 'Text',    summary: 'Slice from a 0-based position.' },
  { name: 'replace',   signature: 'replace(text, find, with)',  group: 'Text',    summary: 'Replace every literal occurrence.' },
  { name: 'split',     signature: 'split(text, sep, index?)',   group: 'Text',    summary: 'Split; with an index, take one part.' },
  { name: 'join',      signature: 'join(list, sep)',            group: 'Text',    summary: 'Join a list (e.g. bullet points).' },
  { name: 'countryname', signature: 'countryname(code, locale)', group: 'Text', summary: 'Translate a two-letter country code into its region name.' },
  { name: 'measure', signature: 'measure(value, unit, acceptedUnits?)', group: 'Number', summary: 'Build a value/unit pair. Accepted units are separated by |. Normalises unit spelling without converting amounts.' },
  { name: 'pad',       signature: 'pad(text, width, char?)',    group: 'Text',    summary: 'Left-pad, default "0".' },
  { name: 'number',    signature: 'number(value)',              group: 'Number',  summary: 'Parse to a number.' },
  { name: 'round',     signature: 'round(n, decimals?)',        group: 'Number',  summary: 'Round to decimals (default 0).' },
  { name: 'floor',     signature: 'floor(n)',                   group: 'Number',  summary: 'Round down.' },
  { name: 'ceil',      signature: 'ceil(n)',                    group: 'Number',  summary: 'Round up.' },
  { name: 'abs',       signature: 'abs(n)',                     group: 'Number',  summary: 'Absolute value.' },
  { name: 'min',       signature: 'min(a, b, …)',               group: 'Number',  summary: 'Smallest number.' },
  { name: 'max',       signature: 'max(a, b, …)',               group: 'Number',  summary: 'Largest number.' },
  { name: 'margin',    signature: 'margin(cost, pct)',          group: 'Pricing', summary: 'Sell price giving pct% gross margin: cost / (1 - pct/100).' },
  { name: 'markup',    signature: 'markup(cost, pct)',          group: 'Pricing', summary: 'Cost plus pct%: cost × (1 + pct/100).' },
  { name: 'discount',  signature: 'discount(price, pct)',       group: 'Pricing', summary: 'Price less pct%.' },
  { name: 'vat',       signature: 'vat(net, ratePct)',          group: 'Pricing', summary: 'Add VAT to a net price.' },
  { name: 'exvat',     signature: 'exvat(gross, ratePct)',      group: 'Pricing', summary: 'Strip VAT from a gross price.' },
  { name: 'rule',      signature: 'rule("name")',               group: 'Rules',   summary: 'Run a saved business rule by name.' },
]
