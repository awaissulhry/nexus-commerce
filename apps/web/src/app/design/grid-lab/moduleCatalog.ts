/**
 * The AG Grid Enterprise module catalogue — what the licence carries, what we register, and what
 * each unregistered module would actually give this product.
 *
 * WHY IT EXISTS: a study of our usage found we register 9 of the 40 enterprise modules. The other
 * 31 are not "missing" in the sense of broken — they are capability we hold and have never turned
 * on. Deciding which are worth turning on needs a list you can read and, where possible, see.
 *
 * EVERY `feature` STRING BELOW IS AG GRID'S OWN. They are lifted verbatim from the `@feature`
 * annotation on each module's declaration in `node_modules/ag-grid-enterprise/dist/types`, and
 * `gridOption` from the `@gridOption` annotation beside it. They are not paraphrased, so this file
 * does not drift into describing a feature as we imagine it rather than as it ships.
 *
 * `here` is the only editorial field: what the module would do on OUR surfaces. It names a real
 * surface or says plainly that nothing here needs it.
 *
 * SCOPE: enterprise modules only. We also register 18 COMMUNITY modules (pagination, CSV export,
 * the number editor, undo/redo, quick filter, grid state, the API modules…) which carry no licence
 * question and are therefore not part of this decision. Counting them here would misstate the ratio.
 *
 * Verified against ag-grid-enterprise 36.1.0 on 2026-08-31: 40 enterprise modules, 9 registered.
 */

export type ModuleStatus = 'registered' | 'available'

/** Where a demo of this module lives in the lab, when seeing it is what decides it. */
export type DemoKey =
  | 'filtering'
  | 'sidebar'
  | 'pivot'
  | 'accessories'
  | 'editing'
  | 'find'
  | 'charts'
  | 'export'

export interface GridModule {
  /** The exported symbol, so a decision turns straight into a line in `modules.ts`. */
  id: string
  /** AG Grid's own `@feature` label, verbatim. */
  feature: string
  /** AG Grid's own `@gridOption`, verbatim, where the module declares one. */
  gridOption?: string
  status: ModuleStatus
  group: string
  /** What it does, in a sentence an operator would recognise. */
  what: string
  /** What it would mean on our surfaces — or that nothing here needs it. */
  here: string
  demo?: DemoKey
}

export const MODULE_GROUPS = [
  'Row models',
  'Structure & grouping',
  'Filtering',
  'Accessories',
  'Editing',
  'Import & export',
  'Analysis & charts',
  'Selection & search',
] as const

export const GRID_MODULES: GridModule[] = [
  // ── Row models ───────────────────────────────────────────────────────────────────────────
  {
    id: 'ServerSideRowModelModule', feature: 'Server-Side Row Model', status: 'registered', group: 'Row models',
    what: 'The grid asks the server for one block of rows at a time, with sort and filter applied server-side.',
    here: 'How /products/next loads 300+ products without shipping them all to the browser.',
  },
  {
    id: 'ServerSideRowModelApiModule', feature: 'Server-Side Row Model', status: 'registered', group: 'Row models',
    what: 'The API surface for the above — refresh a block, purge the cache, drive the datasource by hand.',
    here: 'Used whenever a write has to make the products grid re-read a row.',
  },
  {
    id: 'ViewportRowModelModule', feature: 'Viewport Row Model', status: 'available', group: 'Row models',
    what: 'The server pushes only the rows currently on screen and streams updates to them as they change.',
    here: 'Built for live trading-style boards. Our data changes on a cron, not per second — the server-side model already covers us. Nothing here needs it.',
  },

  // ── Structure & grouping ─────────────────────────────────────────────────────────────────
  {
    id: 'TreeDataModule', feature: 'Tree Data', gridOption: 'treeData', status: 'registered', group: 'Structure & grouping',
    what: 'Rows carry an explicit parent path, so a hierarchy you already have is displayed as one.',
    here: 'Product families: a parent and its colour × size variations, on /products/next and the master sheet.',
  },
  {
    id: 'RowGroupingModule', feature: 'Row Grouping', status: 'registered', group: 'Structure & grouping',
    what: 'Group flat rows by a column value and roll them up under an expandable header.',
    here: 'Group rows in the ads console.',
  },
  {
    id: 'AggregationModule', feature: 'Aggregation', status: 'registered', group: 'Structure & grouping',
    what: 'Sums, averages and custom aggregations on a group row.',
    here: 'The totals on a family footer and on group rows.',
  },
  {
    id: 'MasterDetailModule', feature: 'Master Detail', gridOption: 'masterDetail', status: 'registered', group: 'Structure & grouping',
    what: 'A row expands to reveal a whole second grid or a custom panel underneath it.',
    here: 'The expandable detail rows nine DataGrid sites already use.',
  },
  {
    id: 'RowGroupingPanelModule', feature: 'Row Grouping -> Row Group Panel', status: 'available', group: 'Structure & grouping',
    what: 'A drop zone above the grid where an operator drags columns to group by them, and reorders the grouping live.',
    here: 'Would let someone group the ads console by campaign type, then by match type, without a developer adding a control. The strongest low-cost win in this list.',
    demo: 'pivot',
  },
  {
    id: 'RowGroupingEditModule', feature: 'Row Grouping -> Editing', status: 'available', group: 'Structure & grouping',
    what: 'Editing on a group row, applying the change down to the rows it contains.',
    here: 'Edit a family parent and have it flow to every variation — close to what the master sheet does by hand today.',
  },
  {
    id: 'GroupFilterModule', feature: 'Row Grouping -> Filtering', status: 'available', group: 'Structure & grouping',
    what: 'A filter that understands group hierarchy, letting you filter on the group column itself.',
    here: 'Filter a grouped ads view by group without flattening it first.',
    demo: 'filtering',
  },
  {
    id: 'RowNumbersModule', feature: 'Rows -> Row Numbers', gridOption: 'rowNumbers', status: 'available', group: 'Structure & grouping',
    what: 'A fixed leftmost column numbering the rows, like a spreadsheet.',
    here: 'On the master sheet, where an operator reading 251 rows has no way to say "row 84" to a colleague.',
    demo: 'accessories',
  },

  // ── Filtering ────────────────────────────────────────────────────────────────────────────
  {
    id: 'SetFilterModule', feature: 'Filtering -> Set Filter', status: 'available', group: 'Filtering',
    what: "Excel's checkbox filter: every distinct value in the column, searchable, tick what you want.",
    here: 'We hand-rolled this as a DS component (`GridSetFilter`) because the module was not registered. The native one adds search, select-all and grouped values for free.',
    demo: 'filtering',
  },
  {
    id: 'MultiFilterModule', feature: 'Filtering -> Multi Filter', status: 'available', group: 'Filtering',
    what: 'Two filter types stacked on one column — a checkbox list and a text match together.',
    here: 'Pick a brand from a list AND type a fragment, in one column menu.',
    demo: 'filtering',
  },
  {
    id: 'AdvancedFilterModule', feature: 'Filtering -> Advanced Filter', gridOption: 'enableAdvancedFilter', status: 'available', group: 'Filtering',
    what: 'A formula bar above the grid for expressions across columns: [Spend] > 500 AND [ACoS] > 0.3.',
    here: 'The ads console asks exactly these questions. Today each needs a bespoke filter control; this makes them typeable.',
    demo: 'filtering',
  },

  // ── Accessories ──────────────────────────────────────────────────────────────────────────
  {
    id: 'ColumnMenuModule', feature: 'Accessories -> Column Menu', status: 'registered', group: 'Accessories',
    what: 'The menu behind a column header: sort, pin, hide, filter.',
    here: 'Every grid we ship.',
  },
  {
    id: 'ContextMenuModule', feature: 'Accessories -> Context Menu', status: 'available', group: 'Accessories',
    what: 'Right-click on a cell for copy, export and any action you add.',
    here: 'Right-click a product to publish it, or a campaign to pause it, without a separate actions column.',
    demo: 'accessories',
  },
  {
    id: 'MenuModule', feature: 'Accessories -> Column Menu / Context Menu', status: 'available', group: 'Accessories',
    what: 'The bundle that carries both menus together.',
    here: 'Register this instead of the two separately if we take the context menu.',
  },
  {
    id: 'SideBarModule', feature: 'Accessories -> Side Bar', gridOption: 'sideBar', status: 'available', group: 'Accessories',
    what: 'The collapsible right-hand panel that hosts the tool panels below.',
    here: 'The shell our Customise dialog would live in if we ever wanted it docked rather than modal.',
    demo: 'sidebar',
  },
  {
    id: 'ColumnsToolPanelModule', feature: 'Accessories -> Columns Tool Panel', status: 'available', group: 'Accessories',
    what: 'A panel listing every column with tick-to-show, drag-to-reorder and drag-to-group.',
    here: 'Overlaps our own Customise dialog, which we built deliberately and which is shared across surfaces. Taking this would mean choosing between two answers to the same question.',
    demo: 'sidebar',
  },
  {
    id: 'FiltersToolPanelModule', feature: 'Accessories -> Filters Tool Panel', status: 'available', group: 'Accessories',
    what: 'Every column filter in one panel, so you can see and clear all active filters at once.',
    here: 'The ads console has many filters and no single place showing what is currently applied.',
    demo: 'sidebar',
  },
  {
    id: 'NewFiltersToolPanelModule', feature: 'Accessories -> New Filters Tool Panel', status: 'available', group: 'Accessories',
    what: "AG Grid's newer redesign of the filters panel.",
    here: 'Same job as the above; pick one, not both.',
    demo: 'sidebar',
  },
  {
    id: 'StatusBarModule', feature: 'Accessories -> Status Bar', gridOption: 'statusBar', status: 'available', group: 'Accessories',
    what: 'A bar under the grid showing row counts, selected count, and sum/avg/min/max of the selected cells.',
    here: 'We hand-built a footer strip for exactly this. The native one adds live aggregates over a selected range — select a column of spend and read its total.',
    demo: 'accessories',
  },
  {
    id: 'ToolbarModule', feature: 'Accessories -> Toolbar', gridOption: 'toolbar', status: 'available', group: 'Accessories',
    what: 'A configurable toolbar area above the grid, built from provided or custom items.',
    here: 'We already ship our own DS toolbar on every grid. Adopting this would replace a piece of the design system with AG chrome — the opposite of the direction we chose.',
  },
  {
    id: 'NotesModule', feature: 'Notes', gridOption: 'noteTrigger', status: 'available', group: 'Accessories',
    what: 'A comment attached to a cell, shown in a popup — spreadsheet cell notes.',
    here: 'On the master sheet: "left this blank because Amazon rejected the ASIN". Needs somewhere to store the note; AG only renders it.',
    demo: 'find',
  },

  // ── Editing ──────────────────────────────────────────────────────────────────────────────
  {
    id: 'CellSelectionModule', feature: 'Selection -> Cell Selection', gridOption: 'cellSelection', status: 'registered', group: 'Editing',
    what: 'Excel-style cell ranges and the fill handle.',
    here: 'The inventory editor and the master sheet.',
  },
  {
    id: 'ClipboardModule', feature: 'Import & Export -> Clipboard', status: 'registered', group: 'Editing',
    what: 'Copy and paste ranges between the grid and a real spreadsheet.',
    here: 'Pasting a block from Excel into the master sheet.',
  },
  {
    id: 'RichSelectModule', feature: 'Editing -> Rich Select Editor', status: 'available', group: 'Editing',
    what: 'A searchable dropdown editor with virtual scrolling, so a list of thousands stays usable.',
    here: 'We built a DS Listbox editor instead, which keeps the design system consistent. Worth revisiting only for a genuinely huge list — an Amazon browse-node picker, say.',
    demo: 'editing',
  },
  {
    id: 'BatchEditModule', feature: 'Batch Editing', status: 'available', group: 'Editing',
    what: 'Collect many cell edits and commit or cancel them as one unit, instead of saving each on its own.',
    here: 'A direct alternative to the master sheet\'s autosave-per-cell, which you chose deliberately. Relevant only if you ever want a "review my changes, then save" mode.',
    demo: 'editing',
  },
  {
    id: 'ColumnHeaderEditModule', feature: 'Columns -> Editable Header Name', status: 'available', group: 'Editing',
    what: 'Rename a column header in place by double-clicking it.',
    here: 'Our headers come from a schema; an operator renaming one would drift from the field it writes. Nothing here needs it.',
  },

  // ── Import & export ──────────────────────────────────────────────────────────────────────
  {
    id: 'ExcelExportModule', feature: 'Import & Export -> Excel', status: 'available', group: 'Import & export',
    what: 'Export to a real .xlsx with styling, types, formulas and multiple sheets — not a CSV.',
    here: 'We ship CSV export. A supplier or a colleague opening a CSV of Italian product data gets encoding problems and loses every number format. This is the most obviously useful module on the list.',
    demo: 'export',
  },

  // ── Analysis & charts ────────────────────────────────────────────────────────────────────
  {
    id: 'PivotModule', feature: 'Pivoting', gridOption: 'pivotMode', status: 'available', group: 'Analysis & charts',
    what: 'Turn column values into columns: spend by campaign type across months, computed in the grid.',
    here: 'Ads reporting builds these views as bespoke pages. Pivot mode would let an operator make one without a developer.',
    demo: 'pivot',
  },
  {
    id: 'ShowValuesAsModule', feature: 'Show Values As', status: 'available', group: 'Analysis & charts',
    what: 'Recast an aggregated value as a percentage of the row, of the column, of the total, or as a running total.',
    here: 'Only useful with pivot. "This campaign as a percentage of total spend" without a calculated field.',
    demo: 'pivot',
  },
  {
    id: 'IntegratedChartsModule', feature: 'Integrated Charts', status: 'available', group: 'Analysis & charts',
    what: 'Select a range of cells and turn it into a live chart that follows the data.',
    here: 'Chart a set of campaigns straight from the ads grid instead of navigating to a reporting page.',
    demo: 'charts',
  },
  {
    id: 'GridChartsModule', feature: 'Integrated Charts', status: 'available', group: 'Analysis & charts',
    what: 'The older name for the same capability.',
    here: 'Register one or the other, not both.',
  },
  {
    id: 'SparklinesModule', feature: 'Sparklines', status: 'available', group: 'Analysis & charts',
    what: 'A tiny inline chart inside a cell — a 30-day trend per row.',
    here: 'Spend or sales trend beside each campaign, and stock movement beside each product. High value per pixel on both consoles.',
    demo: 'charts',
  },
  {
    id: 'CalculatedColumnsModule', feature: 'Calculated Columns', status: 'available', group: 'Analysis & charts',
    what: 'A dialog where an operator defines a new column from an expression over existing ones, with column and function suggestions.',
    here: 'Someone could build "margin after fees" themselves rather than asking for a release. Powerful, and worth thinking about who is allowed to.',
    demo: 'editing',
  },
  {
    id: 'FormulaModule', feature: 'Formulas', status: 'available', group: 'Analysis & charts',
    what: 'Spreadsheet formulas inside cells, evaluated by the grid.',
    here: 'Turns the master sheet into something much closer to Excel. A large idea rather than a small feature — worth a separate conversation.',
    demo: 'editing',
  },

  // ── Selection & search ───────────────────────────────────────────────────────────────────
  {
    id: 'FindModule', feature: 'Find', gridOption: 'findSearchValue', status: 'available', group: 'Selection & search',
    what: 'Find across every cell with match highlighting and next/previous navigation, including rows not currently rendered.',
    here: 'Our quick filter HIDES non-matching rows. Find keeps them and walks you between hits — a different job, and the right one when you are checking rather than narrowing.',
    demo: 'find',
  },
  {
    id: 'RangeSelectionModule', feature: 'Selection -> Cell Selection', status: 'available', group: 'Selection & search',
    what: 'The previous name for cell selection.',
    here: 'Superseded by CellSelectionModule, which we already register. Nothing to decide.',
  },
  {
    id: 'AiToolkitModule', feature: 'AI Toolkit', status: 'available', group: 'Selection & search',
    what: "A schema builder that describes the grid's data and actions in a form an LLM tool call can consume.",
    here: 'Would let an assistant read and act on a grid directly. Interesting given the Ask AI button already in the console, but it is a project, not a switch.',
  },
]

export const REGISTERED = GRID_MODULES.filter((m) => m.status === 'registered')
export const AVAILABLE = GRID_MODULES.filter((m) => m.status === 'available')
