'use client';
import { useSheetPreferences } from '../useSheetPreferences';
import { buildCompareTargets } from '../compareTargets';
import { channelLabel, languageLabel } from '../../scopes';
import { productSheetRowKey, filterProductSheetRows } from '../productSheetRows';
import { useSheetChips } from '../useSheetChips';
import { useSheetSaveStatus } from '../useSheetSaveStatus';
import { useSheetGridBindings } from '../useSheetGridBindings';
import { useProductSheetInteraction } from '../useProductSheetInteraction';
import { useSheetGeometry } from '../useSheetGeometry';
import type { ProductSheetModel } from '../productSheetModel';
import { formulaCandidates, formulaColumnId } from '../formulaColumns';
import { sheetEmptyState } from '../sheetGridStates';
import { formulaTransfer } from '@/design-system/grid';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { Banner } from '@/design-system/components';
import { Button, InfoTip, Pill } from '@/design-system/primitives';
import { ProductTransferDrawer } from '../../import/ProductTransferDrawer';
import { FormulaBulkDialog } from '../FormulaBulkDialog';
import { FormulaHistoryDialog } from '../FormulaHistoryDialog';
import { ExpandButton, ExpandSlot, IdentityBand, BAND_WIDTH_FLOOR, useExpanded, CompletenessPill, ProvenanceMark, ReadinessCell, ScopeReadinessCell, actionContextMenu, actionMenuItems, useActionConfirm, useActionPress, GridExportRefused, sheetPasteProcessor, writeGate, exprOf, isFormulaDraft, type FormulaCandidate, type ColDef, type ICellRendererParams, type PrefsBridgeOptions, type ReadinessValue, type ScopeReadinessValue, type ScopeReadinessState, type ValueGetterParams } from '@/design-system/grid';
import { getBackendUrl } from '@/lib/backend-url';
import { ClassificationDialog } from './ClassificationDialog';
import { useStudioScope, useSaveReporter, useStudioRecord, useScopeReadiness, useViewChips, viewChipHasCell } from '../../contracts';
import { type RecordWriteRequest, type RecordWriteResult, type SheetRow as DrawerSheetRow } from '../../drawer';
import { AiDraftReview, useAiDraftLayer } from '../../ai';
import { buildSheetColumns } from '../buildSheetColumns';
import { ProductRoleChip } from '../ProductRoleChip';
import { identitySecondary, secondaryPlan, type SecondaryPlan } from './identitySecondary';
import type { MenuItemDef } from '@/design-system/components';
import { reloadImpact } from './reloadGuard';
import { familySummaryOf, useFamilyVerbs } from './FamilyBar';
import type { NewVariationDraft } from './addVariation';
import { useFamilyProductPicker } from './FamilyProductPicker';
import { familyActions } from './familyActions';
import { familyOps } from './familyOps';
import { FamilySelectionBar } from './FamilySelectionBar';
import { useFamily } from './useFamily';
import { useCellFormulas } from '../../useCellFormulas';
import { cellOf, editRefusalReason } from './columnRules';
import type { RowReadiness, SheetColumn, StudioRow } from './types';
import { useMasterSheet } from './useMasterSheet';
import { mediaGridTransfer } from '../../media/mediaGridTransfer';
import { productMediaColumn, useProductMediaEditor, withProductMediaColumn, PRODUCT_MEDIA_COLUMN } from '../../media/productMediaColumn';
import { useReferenceNames } from '../useReferenceNames';
import { referenceSearchText } from '../referenceLabels';
import { flaggedColumnKeys, IDENTITY_COLUMN, orderColumnKeys, rankOfColumn, RESERVED_COLUMN_IDS } from '../views';
import { useLanguageChips } from '../useLanguageChips';
import { useSheetColumns } from '../useSheetColumns';
import { exportGridCsv } from '@/design-system/grid/export/exportGrid';
import type { SheetExportMode } from '../sheetExport';
/**
 * LX.FIN (R-LX-22) — the master sheet's per-coordinate readiness COLUMN SET, derived from the
 * readiness index and nothing else. Pure, exported and tested node-only (apps/web vitest has no DOM).
 *
 * 🔴 What this replaces, and why the replacement is not a refactor. Until now the per-coordinate
 * columns were built from `sheet.coordinates` + `row.readinessByCoordinate`, in the ROW vocabulary,
 * and measured on 2026-09-13 the live studio payload carries NEITHER key: the branch only ever ran on
 * the retired `adaptLegacySheet` 404 fallback. LX.15 says these columns are "either fed from
 * `ReadinessIndex` or deleted — not left dead"; R-LX-22 rules that they are fed, in the SCOPE
 * vocabulary (`readinessMeta(state, 'scope')`), because a coordinate's readiness is a scope fact.
 * No converter between the two vocabularies exists or is needed (PES.0 hub ruling #3): the index is
 * keyed `(productId, coordinateKey, language)`, so a per-row cell is a LOOKUP, not a mapping.
 *
 * One column per CHANNEL coordinate the index has rows for **in the pressed language** — the shared
 * coordinate is excluded because the sheet's own `ready:scope` column already answers for it, in the
 * row vocabulary. A product with no row for a coordinate is absent from `byProduct` and its cell says
 * `Not computed`, never a score (R-LX-9).
 */
export interface CoordinateReadinessColumn {
  colId: string
  label: string
  language: string
  computedAt: string | null
  byProduct: Readonly<Record<string, { state: ScopeReadinessState; pct: number | null; note?: string }>>
}

export function coordinateReadinessColumns(
  matrix: ReadonlyArray<{ channel: string | null; market: string | null; accountId: string | null; aliasId: string | null; coordinateKey: string; language: string; label: string; computedAt: string | null; byProduct?: Record<string, { state: ScopeReadinessState; pct: number | null; note?: string }> }> | undefined,
  language: string | null | undefined,
): CoordinateReadinessColumn[] {
  if (!matrix?.length || !language) return []
  const wanted = language.toLowerCase()
  return matrix
    .filter(entry => !!entry.channel && entry.language?.toLowerCase() === wanted)
    .map(entry => ({
      colId: `ready:${[entry.channel, entry.market, entry.accountId, entry.aliasId].filter(Boolean).join(':')}:${entry.language}`,
      label: entry.label,
      language: entry.language,
      computedAt: entry.computedAt,
      byProduct: entry.byProduct ?? {},
    }))
}

export interface MasterSheetProps {
    productId: string;
    market: string;
    locale: string;
    variationAxes?: string[];
}
function ProductCell(p: ICellRendererParams<StudioRow> & {
    secondaryRef?: {
        current: SecondaryPlan;
    };
    rowMenuRef?: {
        current: (row: StudioRow) => MenuItemDef[];
    };
}) {
    const expanded = useExpanded(p.node);
    const d = p.data;
    if (!d)
        return null;
    const parent = d.isParent;
    const expander = parent && d.childCount > 0 ? (<ExpandButton expanded={expanded} onToggle={() => p.node.setExpanded(!expanded)} labels={['Expand children', 'Collapse children']}/>) : (<ExpandSlot />);
    const role = <ProductRoleChip product={d}/>;
    const line = p.secondaryRef ? identitySecondary(d, p.secondaryRef.current) : d.name;
    return (<IdentityBand expand={expander} role={role} image={d.imageUrl} photoCount={d.imageInherited ? undefined : d.photoCount} noImage={!d.imageUrl} imageMark={d.imageInherited ? (<ProvenanceMark provenance="inherited" from="the family's picture — this variation has none of its own"/>) : null} sku={d.sku} secondary={line} secondaryTitle={line ?? undefined} menuItems={p.rowMenuRef?.current(d)} menuLabel={`Actions for ${d.sku}`} trailing={<CompletenessPill pct={d.completeness.overall.pct} tip={`${d.completeness.overall.pct}% — filled ÷ applicable master attributes`}/>}/>);
}
interface SheetPageState {
    search: string;
}
const NO_VARIATION_AXES: readonly string[] = [];
export function useMasterSheetAdapter({ productId, market, locale, variationAxes = NO_VARIATION_AXES as string[] }: MasterSheetProps): ProductSheetModel<StudioRow, SheetPageState, DrawerSheetRow> {
    const { apiRef, gridReady, getGridApi, bindGridApi, releaseGrid, search, setSearch, showRefusedOnly, setShowRefusedOnly, lastSavedAt, setLastSavedAt, lastDataCell, refusalReason, onCellFocused, onCellDoubleClicked, onCellKeyDown, onSelectionChanged, clearSelection, rowSelection, selectedRows, setSelectedRows, announceRefusals } = useProductSheetInteraction<StudioRow>('master');
    const languageScope = useStudioScope();
    /* LX.FIN (R-LX-22) — the same readiness read the scope chips use; no second request. */
    const readinessQuery = useScopeReadiness();
    const readinessMatrix = readinessQuery.status === 'ready' ? readinessQuery.matrix : undefined;
    const reporter = useSaveReporter();
    const record = useStudioRecord();
    const columnByKeyRef = useRef<Map<string, SheetColumn>>(new Map());
    const onWriteStart = useCallback((id: string, rowId: string) => reporter.pending(id, rowId), [reporter]);
    const onWriteEnd = useCallback((id: string, ok: boolean, msg?: string, rowId?: string) => reporter.resolved(id, ok, msg, rowId), [reporter]);
    const onSettled = useCallback(({ ok, savedAt }: {
        rowId: string;
        ok: boolean;
        savedAt: string;
    }) => {
        if (ok)
            setLastSavedAt(savedAt);
    }, []);
    const { sheet: loadedSheet, loading, error, contractProblems, reload, refresh, writer, tracker, conflicts, bindGrid } = useMasterSheet({
        productId, market, locale, locales: languageScope.locales, onWriteStart, onWriteEnd, onSettled,
        /* R-VT-15 — the server's refusal sentence, said the moment it arrives, through the ONE DS
           toast provider this route mounts (`_studio/StudioClient.tsx`; the root layout's is the old
           library's — `reference_ds_toast_two_providers`). `announceRefusals` is the shared
           implementation in `useProductSheetInteraction`, so both scopes and both moments (fresh
           refusal, and returning to a marked cell) say it one way. */
        onRefused: announceRefusals,
    });
    const sheet = useReferenceNames(loadedSheet, 'MASTER', market);
    const formulaRowIds = useMemo(() => (sheet?.rows ?? []).map((r) => r.id), [sheet]);
    const formulas = useCellFormulas({ writeFacts: (rowId, fieldKey) => sheet?.rows.find(row => row.id === rowId)?.values[fieldKey], productId, market, locale, columnKeys: sheet?.columns.map(column => column.key), rowIds: formulaRowIds, onSettled: refresh, onValueSaved: (rowId, fieldKey, value) => {
            const node = getGridApi()?.getRowNode(rowId);
            if (!node?.data)
                return;
            const cell = node.data.values?.[fieldKey];
            if (cell)
                node.data.values = { ...node.data.values, [fieldKey]: { ...cell, value } };
            getGridApi()?.refreshCells({ rowNodes: [node], columns: [fieldKey], force: true });
        } });
    const candidatesFor = useCallback((row: StudioRow, fieldKey?: string): FormulaCandidate[] => {
        const cols = formulaCandidates(sheet?.columns ?? [], row.values, fieldKey, locale ?? '');
        const fns = formulas.functions.map((f) => ({
            name: f.name,
            kind: 'function' as const,
            label: f.signature,
            group: 'Functions',
        }));
        return [...cols, ...fns];
    }, [sheet, formulas.functions, locale]);
    const colIdOfRef = useCallback((name: string, fieldKey?: string): string | null => formulaColumnId(sheet?.columns ?? [], name, fieldKey, locale), [sheet, locale]);
    const formulaLive = useRef({ candidatesFor, formulas, colIdOfRef });
    formulaLive.current = { candidatesFor, formulas, colIdOfRef };
    const formulaWiring = useMemo(() => ({
        candidatesFor: (row: StudioRow, fieldKey?: string) => formulaLive.current.candidatesFor(row, fieldKey),
        preview: (rowId: string, fieldKey: string, expr: string, signal?: AbortSignal) => formulaLive.current.formulas.preview(rowId, fieldKey, expr, signal),
        functions: () => formulaLive.current.formulas.functions,
        replaceFormula: (rowId: string, fieldKey: string, value: unknown) => formulaLive.current.formulas.replace(rowId, fieldKey, value),
        unavailableReason: () => formulaLive.current.formulas.loadError ?? (formulaLive.current.formulas.ready ? null : 'Loading formulas…'),
        retry: () => formulaLive.current.formulas.reload(),
        sourceLabel: (fieldKey?: string) => formulaLive.current.formulas.sourceLabelFor(fieldKey),
        exprFor: (rowId: string, fieldKey: string) => formulaLive.current.formulas.exprFor(rowId, fieldKey),
        errorFor: (rowId: string, fieldKey: string) => formulaLive.current.formulas.errorFor(rowId, fieldKey),
        colIdOfRef: (name: string, fieldKey?: string) => formulaLive.current.colIdOfRef(name, fieldKey),
    }), []);
    const formulaClipboard = useMemo(() => formulaTransfer<StudioRow>({
        exprFor: (row, key) => formulaWiring.exprFor(row.id, key),
    }), [formulaWiring]);
    const familyQuery = useFamily(productId);
    const familySummary = familySummaryOf(familyQuery.family, familyQuery.loading);
    const { has, status: authStatus } = useAuth();
    const [newVariation, setNewVariation] = useState<NewVariationDraft | null>(null);
    const familyProductPicker = useFamilyProductPicker(productId);
    const canPim = has('pim.manage');
    const canSync = has('channels.sync');
    const canEdit = has('products.edit');
    const famActions = useMemo(() => familyActions({
        family: familyQuery.family,
        ops: familyOps,
        can: (p) => (p === 'pim.manage' ? canPim : p === 'channels.sync' ? canSync : p === 'products.edit' ? canEdit : has(p)),
        authStatus,
        pickProduct: familyProductPicker.pick,
        pending: newVariation ? { newVariation } : undefined,
        openRecord: (rowId) => record.open(rowId, lastDataCell.current ?? undefined),
        openRecordId: record.rowId,
    }), [familyQuery.family, canPim, canSync, canEdit, authStatus, newVariation, record, familyProductPicker.pick]);
    const onFamilyChangedRef = useRef<() => void>(() => { });
    const rowPress = useActionPress<StudioRow>(() => onFamilyChangedRef.current());
    const rowMenuRef = useRef<(row: StudioRow) => MenuItemDef[]>(() => []);
    rowMenuRef.current = useMemo(() => actionMenuItems<StudioRow>({
        actions: famActions,
        onSelect: (action, rows) => void rowPress.press(action, rows),
        isRecord: (r) => !!r?.id,
    }), [famActions, rowPress.press]);
    const getContextMenuItems = useMemo(() => actionContextMenu<StudioRow>({
        actions: famActions,
        onSelect: (action, rows) => void rowPress.press(action, rows),
        isRecord: (r) => !!r?.id,
    }), [famActions, rowPress.press]);
    const contextMenuRef = useRef(getContextMenuItems);
    contextMenuRef.current = getContextMenuItems;
    const stableContextMenu = useCallback<typeof getContextMenuItems>((p) => contextMenuRef.current(p), []);
    const onFamilyChanged = useCallback(() => { familyQuery.reload(); reload(); }, [familyQuery, reload]);
    onFamilyChangedRef.current = onFamilyChanged;
    const [classificationOpen, setClassificationOpen] = useState(false);
    const [formulaHistoryOpen, setFormulaHistoryOpen] = useState(false);
    const [bulkFormulaRows, setBulkFormulaRows] = useState<Array<{
        id: string;
        label: string;
    }> | null>(null);
    const selected = selectedRows.length;
    useEffect(() => {
        if (!gridReady)
            return;
        getGridApi()?.refreshCells({ force: true });
    }, [formulas.exprFor, formulas.errorFor, gridReady]);
    const rows = useMemo(() => sheet?.rows ?? [], [sheet]);
    const { pending, refused, refusedRowIds, offline, saving } = useSheetSaveStatus(writer, tracker, rows, sheet?.columns);
    refusalReason.current = (key, row) => {
        if (key === PRODUCT_MEDIA_COLUMN)
            return null;
        const column = columnByKeyRef.current.get(key);
        return column ? editRefusalReason(column, row) : null;
    };
    const { bandWidth, bandWidthRef, bandDerivedRef, revealCell, replayReveal, remeasureSoon } = useSheetGeometry({ scope: 'master', rows, getGridApi, gridReady, recordId: record.rowId });
    const rowsRef = useRef<StudioRow[]>(rows);
    rowsRef.current = rows;
    const reloadConfirm = useActionConfirm();
    const onReload = useCallback(async () => {
        const impact = reloadImpact({ pending: writer.pending, refused, unknown: writer.unknownCount });
        if (!impact) {
            reload();
            return;
        }
        if (!(await reloadConfirm.ask(impact)))
            return;
        reporter.cleared(sheet?.rows.map(row => row.id) ?? [...refusedRowIds]);
        writer.discard();
        reload();
    }, [writer, refused, refusedRowIds, sheet, reporter, reload, reloadConfirm]);
    const mediaEditor = useProductMediaEditor(refresh, locale);
    const mediaClipboard = useMemo(() => mediaGridTransfer(formulaClipboard, mediaEditor.actions), [formulaClipboard, mediaEditor.actions]);
    const schemaColumns = useMemo(() => withProductMediaColumn(sheet?.columns ?? []).filter((c) => !RESERVED_COLUMN_IDS.includes(c.key as never)), [sheet]);
    const viewCtx = useMemo(() => ({
        variationAxes: sheet?.family.variationAxes?.length ? sheet.family.variationAxes : variationAxes,
        locale,
        flaggedKeys: flaggedColumnKeys(sheet?.rows),
    }), [sheet, locale, variationAxes]);
    columnByKeyRef.current = useMemo(() => new Map(schemaColumns.map((c) => [c.key, c])), [schemaColumns]);
    const allColumnKeys = useMemo(() => schemaColumns.map((c) => c.key), [schemaColumns]);
    const customisableColumns = schemaColumns;
    const prefsBridge = useMemo<PrefsBridgeOptions>(() => ({
        columns: [
            { key: 'product', locked: true },
            ...allColumnKeys.map((k) => ({ key: k })),
        ],
        treeColumnKey: 'product',
    }), [allColumnKeys]);
    const chipBar = useViewChips();
    const sheetColumns = useSheetColumns<StudioRow, SheetPageState>({
        apiRef,
        gridReady,
        columns: schemaColumns,
        languages: { selected: languageScope.locales, available: languageScope.options.locales.map(language => language.code), set: languageScope.setLocales },
        viewCtx,
        serverViews: sheet?.views,
        identityColumn: IDENTITY_COLUMN,
        prefsBridge,
        activeChip: chipBar.active,
        setChip: chipBar.setActive,
        layoutSurface: `product-edit:layout:master:${market.toUpperCase()}`,
        grid: {
            surface: 'product-edit:master',
            viewsSurface: 'product-edit:views:master',
            baseUrl: getBackendUrl(),
            omitScroll: record.colKey != null,
            getPageState: () => ({ search }),
            applyPageState: (pg) => setSearch(pg.search ?? ''),
        },
    });
    const { onGridReady, onGridPreDestroyed } = useSheetGridBindings({ apiRef, sheetColumns, bindGridApi, releaseGrid, bindWriter: bindGrid, clearRows: () => setSelectedRows([]) });
    const scopeRows = useMemo(() => {
        const afterRefused = showRefusedOnly && refusedRowIds.size ? filterProductSheetRows(rows, row => refusedRowIds.has(productSheetRowKey(row))) : rows;
        const query = search.trim().toLowerCase();
        return query ? filterProductSheetRows(afterRefused, row => (row.sku + ' ' + (row.name ?? '')).toLowerCase().includes(query) || Object.entries(row.values).some(([key, cell]) => referenceSearchText(cell?.value, columnByKeyRef.current.get(key)?.optionLabels).includes(query))) : afterRefused;
    }, [rows, search, showRefusedOnly, refusedRowIds, schemaColumns]);
    useSheetChips(sheet ? scopeRows : null, schemaColumns, { scope: 'master' });
    const productIds = useMemo(() => rows.map((r) => r.id), [rows]);
    const contentAiChip = useLanguageChips(sheet ? scopeRows : null, schemaColumns, false);
    const aiLayer = useAiDraftLayer({ productIds, channel: null, marketplace: market, locale, locales: languageScope.locales, columnKeys: allColumnKeys }, contentAiChip);
    const skuById = useMemo(() => Object.fromEntries(rows.map((r) => [r.id, r.sku])), [rows]);
    const activeChip = chipBar.active;
    const chipCellsRef = useRef(activeChip?.cells ?? null);
    chipCellsRef.current = activeChip?.cells ?? null;
    const isChipCell = useCallback((rowId: string, colId: string) => (chipCellsRef.current ? viewChipHasCell(chipCellsRef.current, rowId, colId) : false), []);
    useEffect(() => {
        const api = getGridApi();
        if (api && !api.isDestroyed())
            api.refreshCells({ force: true });
    }, [activeChip]);
    const visibleRows = useMemo(() => activeChip ? filterProductSheetRows(scopeRows, row => (activeChip.cells.byRow[productSheetRowKey(row)]?.length ?? 0) > 0) : scopeRows, [scopeRows, activeChip]);
    const attributeColumns = useMemo(() => (sheet ? buildSheetColumns('master', { columns: schemaColumns.filter(column => column.key !== PRODUCT_MEDIA_COLUMN), tracker, locale, market, reservedColumnIds: RESERVED_COLUMN_IDS, isChipCell, draftFor: aiLayer.draftFor, formula: formulaWiring }, rowsRef) : []), [sheet, schemaColumns, tracker, locale, market, isChipCell, aiLayer.draftFor, formulaWiring]);
    const identityColumns = useMemo<ColDef<StudioRow>[]>(() => [], []);
    const readinessColumns = useMemo<ColDef<StudioRow>[]>(() => {
        const toValue = (r: RowReadiness | undefined): ReadinessValue | null => r ? { state: r.state, issues: r.issues.map((i) => i.message), ref: r.ref } : null;
        const rowValue = (row: StudioRow | undefined): ReadinessValue | null => {
            if (!row)
                return null;
            const edits = (sheet?.columns ?? []).map(col => tracker.get(row.id, col.key)).filter(Boolean);
            const failures = edits.filter(edit => edit?.state === 'refused' || edit?.state === 'unknown');
            if (failures.length)
                return { state: 'errors', issues: [...new Set(failures.map(edit => edit?.reason || 'An edit has not been saved.'))] };
            if (edits.some(edit => edit?.state === 'saving'))
                return null;
            return toValue(row.readiness);
        };
        const readinessText = (v: ReadinessValue | null | undefined): string => {
            if (!v)
                return '';
            const state = v.state ? v.state.charAt(0).toUpperCase() + v.state.slice(1) : '';
            const n = v.issues?.length ?? 0;
            return n > 0 ? `${state} · ${n}` : state;
        };
        /**
         * LX.FIN (R-LX-22) — the per-coordinate columns, fed from `ReadinessIndex` through the readiness
         * contract this frame already reads for the scope chips. ONE request, one authority: the chip
         * above the sheet and the column inside it cannot disagree about a coordinate.
         *
         * They render `ScopeReadinessCell` (the DS's scope-vocabulary cell) and NOT `ReadinessCell`,
         * which is hard-wired to the row vocabulary — pointing the row cell at a scope state would print
         * `Blocked` through the wrong table and come out as an unrecognised state on exactly the rows an
         * operator most needs to see. Measured on GALE-JACKET on 2026-09-13: eBay·IT·xaviaracing·it is
         * `blocked` as a COORDINATE while its 21 rows are 1 × `ready` (the parent) + 20 × `blocked`, so a
         * column fed with the coordinate summary would have painted the one ready row red.
         */
        const coordinateColumns = coordinateReadinessColumns(readinessMatrix, locale);
        if (coordinateColumns.length) {
            return coordinateColumns.map((c) => ({
                colId: c.colId,
                headerName: `Readiness · ${c.label}`,
                width: 170,
                sortable: false,
                editable: false,
                cellClass: 'nds-ag-cell nds-cell-is-locked',
                headerTooltip: `Scope readiness for ${c.label} in ${languageLabel(c.language)}, from the readiness index${c.computedAt ? ` (computed ${new Date(c.computedAt).toLocaleString()})` : ''}. A row with no index entry reads “Not computed”, which is not a score. This is the SCOPE vocabulary, not the row vocabulary the Readiness column uses, and neither is publication eligibility.`,
                valueGetter: (p: ValueGetterParams<StudioRow>): ScopeReadinessValue | null => (p.data ? c.byProduct[p.data.id] ?? { state: 'notComputed', pct: null } : null),
                valueFormatter: (p) => { const v = p.value as ScopeReadinessValue | null; return v ? `${v.state}${v.pct === null ? '' : ` · ${v.pct}%`}` : ''; },
                cellRenderer: ScopeReadinessCell,
            }));
        }
        if (!sheet)
            return [];
        return [
            {
                colId: 'ready:scope',
                headerName: 'Readiness',
                width: 170,
                sortable: false,
                editable: false,
                cellClass: 'nds-ag-cell nds-cell-is-locked',
                headerTooltip: `Saved Information against ${sheet.scope.label}; unsaved errors take priority. This is not publication eligibility.`,
                valueGetter: (p: ValueGetterParams<StudioRow>): ReadinessValue | null => rowValue(p.data),
                valueFormatter: (p) => readinessText(p.value as ReadinessValue | null),
                cellRenderer: ReadinessCell,
            },
        ];
    }, [sheet, tracker, pending, refused, offline, readinessMatrix, locale]);
    const columnDefs = useMemo(() => {
        const rank = new Map(orderColumnKeys(schemaColumns, viewCtx).map((k, i) => [k, i]));
        const ordered = attributeColumns
            .map((c, i) => ({ c, r: rankOfColumn(c, rank), i }))
            .sort((a, b) => a.r - b.r || a.i - b.i)
            .map((x) => x.c);
        return [...identityColumns, productMediaColumn<StudioRow>(mediaEditor.open, mediaEditor.actions), ...ordered, ...readinessColumns];
    }, [identityColumns, attributeColumns, readinessColumns, schemaColumns, viewCtx, mediaEditor.open, mediaEditor.actions]);
    const getRowId = useCallback((p: {
        data: StudioRow;
    }) => p.data.id, []);
    const getDataPath = useCallback((d: StudioRow) => (d.parentId ? [d.parentId, d.id] : [d.id]), []);
    const secondaryRef = useRef<SecondaryPlan>({ mode: 'none', axisKeys: [] });
    secondaryRef.current = useMemo(() => secondaryPlan(rows, schemaColumns), [rows, schemaColumns]);
    const autoGroupColumnDef = useMemo<ColDef<StudioRow>>(() => ({
        headerName: 'Product', colId: 'product', width: bandWidth, minWidth: BAND_WIDTH_FLOOR,
        pinned: 'left',
        lockPinned: true,
        lockPosition: 'left',
        cellRenderer: ProductCell, cellClass: 'nds-ag-cell', suppressHeaderMenuButton: true,
        cellRendererParams: { secondaryRef, rowMenuRef },
        headerTooltip: 'Family — a parent and its children',
    }), [bandWidth]);
    const defaultColDef = useMemo<ColDef<StudioRow>>(() => ({ sortable: true, resizable: true }), []);
    const processDataFromClipboard = useMemo(() => sheetPasteProcessor<StudioRow>(customisableColumns.map((c) => ({ colId: c.key, headerName: c.label }))), [customisableColumns]);
    const onCellValueChanged = useCallback((e: {
        data: StudioRow;
        colDef: {
            colId?: string;
        };
        oldValue?: unknown;
        newValue: unknown;
        source?: string;
    }) => {
        const colId = e.colDef.colId;
        if (!writeGate({ colId, source: e.source, selfInflicted: false, oldValue: e.oldValue, newValue: e.newValue }).write)
            return;
        if (!formulas.ready) {
            const reason = formulas.loadError ?? 'Formulas are still loading. Retry this edit once they are ready.';
            tracker.set(e.data.id, colId!, 'refused', reason);
            const writeId = `${e.data.id}:${colId}:${Date.now()}`;
            onWriteStart(writeId, e.data.id);
            onWriteEnd(writeId, false, reason, e.data.id);
            return;
        }
        const typed = typeof e.newValue === 'string' ? e.newValue : null;
        if ((typed !== null && isFormulaDraft(typed)) || formulas.exprFor(e.data.id, colId!)) {
            const prev = cellOf(e.data, colId!);
            if (prev) {
                e.data.values = { ...e.data.values, [colId!]: { ...prev, value: e.oldValue } };
                const node = getGridApi()?.getRowNode(e.data.id);
                if (node)
                    getGridApi()?.refreshCells({ force: true, rowNodes: [node], columns: [colId!] });
            }
            const writeId = `${e.data.id}:${colId}:${Date.now()}`;
            onWriteStart(writeId, e.data.id);
            tracker.set(e.data.id, colId!, 'saving');
            void (typed !== null && isFormulaDraft(typed) ? formulas.save(e.data.id, colId!, exprOf(typed)) : formulas.replace(e.data.id, colId!, e.newValue))
                .then((r) => {
                onWriteEnd(writeId, r.ok, r.error, e.data.id);
                tracker.set(e.data.id, colId!, r.ok ? 'saved' : 'refused', r.error);
                if (!r.ok) {
                    const cell = cellOf(e.data, colId!);
                    if (cell) {
                        e.data.values = { ...e.data.values, [colId!]: { ...cell, value: e.newValue } };
                        const n = getGridApi()?.getRowNode(e.data.id);
                        if (n)
                            getGridApi()?.refreshCells({ force: true, rowNodes: [n], columns: [colId!] });
                    }
                }
            })
                .catch((err: unknown) => {
                const reason = err instanceof Error ? err.message : String(err);
                onWriteEnd(writeId, false, reason, e.data.id);
                tracker.set(e.data.id, colId!, 'unknown', `Could not reach the server — ${reason}. Refresh to see whether this saved.`);
            });
            return;
        }
        writer.set(e.data.id, colId!, e.newValue, { row: e.data });
    }, [writer, formulas, onWriteStart, onWriteEnd, reload]);
    const [importOpen, setImportOpen] = useState(false);
    const [transferIntent, setTransferIntent] = useState<'import' | 'export'>('import');
    const familyVerbs = useFamilyVerbs({
        family: familyQuery.family,
        actions: famActions,
        error: familyQuery.error,
        onRetry: familyQuery.reload,
        onDone: onFamilyChanged,
        onCollectVariation: setNewVariation,
    });
    const { preferences, columnDialog, openCustomise } = useSheetPreferences({ scope: 'master', sheetColumns, getGridApi, bandWidthRef, bandDerivedRef, revealCell });
    const [exportNote, setExportNote] = useState<string | null>(null);
    const onExport = useCallback((mode: SheetExportMode) => {
        const api = getGridApi();
        if (!api || api.isDestroyed() || !sheet)
            return;
        try {
            const r = exportGridCsv<StudioRow>(api, `${sheet.family.sku}-${market}-table`, {
                columns: mode === 'all' ? sheetColumns.orderedKeys : 'displayed',
                leading: [{ colId: '__sku', header: 'SKU', value: row => row.sku }],
                narrowed: search.trim().length > 0,
            });
            setExportNote(`${r.rows} rows · ${r.columns} columns → ${r.fileName} · reference table`);
        }
        catch (e) {
            setExportNote(e instanceof GridExportRefused ? e.message : 'Could not build the file.');
        }
    }, [sheet, market, search, sheetColumns]);
    const resolveRow = useCallback((rowId: string) => {
        const row = rowsRef.current.find((r) => r.id === rowId);
        return row ? ({ ...row, listings: {} } as unknown as DrawerSheetRow) : null;
    }, []);
    const drawerScope = useMemo(() => ({ kind: 'master' as const, marketplace: market, locale, label: sheet?.scope.label ?? `Master · ${market}` }), [market, locale, sheet]);
    const onDrawerWrite = useCallback(async (req: RecordWriteRequest): Promise<RecordWriteResult> => {
        const row = rowsRef.current.find((r) => r.id === req.rowId);
        if (!row)
            return { state: 'refused', message: 'That row is no longer on the sheet — reload it.' };
        const column = (sheet?.columns ?? []).find((c) => c.writeField === req.writeField || c.key === req.writeField);
        if (!column)
            return { state: 'refused', message: `No column on this sheet writes “${req.writeField}”.` };
        writer.set(req.rowId, column.key, req.value, { row, intent: req.intent });
        return { state: 'pending' };
    }, [sheet, writer]);
    /**
     * LX.13 — every language of the field (source first) + every coordinate carrying it, from the ONE
     * builder both hosts use (`sheet/compareTargets.ts`). Master used to offer a single target —
     * itself — so the pane could only answer "no other scopes are wired to compare against".
     *
     * Languages come from the scope authority (`Marketplace.languages`, LX.2) through
     * `languageScope.options.locales`; the source is its `primaryLanguage`. Coordinates are the ones
     * this family is LISTED on, which the master sheet read does not carry — that inventory arrives
     * with the per-coordinate readiness columns (LX.15, deferred to VT.2's file), so master offers
     * the language rows today and the coordinate rows land with it.
     */
    const compareTargets = useMemo(() => sheet ? buildCompareTargets({
        scope: drawerScope,
        languages: languageScope.options.locales.map(language => language.code),
        primaryLanguage: languageScope.primaryLanguage,
        coordinates: [],
        labels: { channel: channelLabel, language: languageLabel },
        masterLabel: sheet.scope.label ?? 'Shared',
        masterMarket: market,
    }) : [], [sheet, drawerScope, languageScope.options.locales, languageScope.primaryLanguage, market]);
    const staleTypes = sheet?.meta.schemaAge.filter((a) => Date.now() - new Date(a.fetchedAt).getTime() > 7 * 864e5) ?? [];
    const emptyState = sheetEmptyState(rows.length, () => {
        setSearch('');
        chipBar.setActive(null);
        setShowRefusedOnly(false);
        getGridApi()?.setFilterModel(null);
    }, onReload);
    return {
        scope: 'master',
        loading, unavailable: !!error,
        errorLabel: 'shared product information',
        errorMessage: error,
        backendMissing: false, retry: reload,
        columns: sheetColumns,
        toolbar: {
            pendingWrite: pending > 0 || saving,
            visible: visibleRows.length,
            total: rows.length,
            selected: selected,
            descriptor: familySummary.role !== '—' ? (<span className="nds-cell-muted"> · {familySummary.role} · {familySummary.detail}</span>) : null,
            search: search,
            onSearch: setSearch,
            onCustomise: openCustomise,
            onExport: () => { setTransferIntent('export'); setImportOpen(true); },
            exportCounts: { view: sheetColumns.visibleAttributeKeys().length, all: sheetColumns.orderedKeys.length },
            exportDisabled: !sheet || loading || !has('products.export'),
            exportPurpose: "workbook",
            onImport: () => { setTransferIntent('import'); setImportOpen(true); },
            importDisabled: !sheet || loading || !has('products.import'),
            onReload: onReload,
            loading: loading,
            unavailable: !!error,
            overflow: [{ id: 'classification', label: 'Classification…', disabled: loading || !!error || !canEdit, description: !canEdit ? 'You do not have permission to change product classification.' : 'Choose the product family and categories.', onSelect: () => setClassificationOpen(true) }, ...familyVerbs.items, { id: 'formula-history', label: 'Formula history…', onSelect: () => setFormulaHistoryOpen(true) }, { id: 'bulk-formula', label: 'Apply formula to selected products…', disabled: !selected || !formulas.ready || !canEdit, onSelect: () => setBulkFormulaRows(selectedRows.map(row => ({ id: row.id, label: row.sku ?? row.id })).sort((a, b) => Number(a.id === productId) - Number(b.id === productId))) }],
            status: [
                ...(staleTypes.length > 0 || (sheet?.meta.schemaMissing.length ?? 0) > 0 ? [{
                    tone: 'warning' as const,
                    label: (sheet?.meta.schemaMissing.length ?? 0) > 0 ? 'Setup incomplete' : 'Cached requirements',
                    detail: sheet && sheet.meta.schemaMissing.length > 0
                        ? `Attribute setup is incomplete: ${sheet.meta.schemaMissing.join(', ')}. Choose a product family in Classification; channel requirements use their selected category.`
                        : `Length caps and lists come from a schema last fetched ${staleTypes.map((t) => `${t.productType} ${t.fetchedAt.slice(0, 10)}`).join(', ')}.`,
                }] : []),
                ...familyVerbs.status,
            ],
        },
        toolbarExtra: <></>,
        status: {
            rows: visibleRows.length,
            selected: selected,
            pending: pending,
            refused: refused,
            saving: saving,
            lastSavedAt: lastSavedAt,
        }, footerNote: {
            layoutRecovery: sheetColumns.loadError ? { retry: sheetColumns.reloadSavedPreferences } : null,
            offline: offline,
            refused: refused,
            showRefusedOnly: showRefusedOnly,
            onToggleRefused: () => setShowRefusedOnly((v) => !v),
            lastSavedAt: lastSavedAt,
        }, footerBefore: <><FamilySelectionBar rows={selectedRows} actions={famActions} onClear={clearSelection} onDone={onFamilyChanged}/>
        {rowPress.problem && <div className="nds-grid-footstrip" role="alert"><span className="nds-cell-stock-out">{rowPress.problem}</span></div>}
        {rowPress.confirmElement}
        {familyVerbs.dialogs}
        {reloadConfirm.element}</>, footerExtra: <>{exportNote && <span className="nds-cell-muted">{exportNote}</span>}
    {sheet?.meta.source === 'legacy' && (<InfoTip tip="The studio sheet route is not deployed yet, so this is the catalogue read adapted to the same shape. Cell values and versions are real; the layer each value came from is INFERRED here rather than stated by the server.">
                <Pill tone="neutral" size="sm">adapted read</Pill>
              </InfoTip>)}
    {conflicts.length > 0 && (<Button size="sm" variant="link" onClick={reload}>
                {conflicts.length} {conflicts.length === 1 ? 'row' : 'rows'} changed elsewhere — refresh
              </Button>)}</>,
        notice: <>{contractProblems.length > 0 && <Banner tone="warning" title="The sheet read did not match its contract">{contractProblems.join(" · ")}</Banner>}</>,
        grid: {
            noRowsOverlayComponentParams: emptyState,
            ...mediaClipboard,
            getContextMenuItems: stableContextMenu,
            flatTree: true,
            groupDefaultExpanded: -1,
            tooltipShowDelay: 300,
            rowData: loading ? [] : visibleRows,
            onFirstDataRendered: remeasureSoon,
            onRowDataUpdated: remeasureSoon,
            onDisplayedColumnsChanged: replayReveal,
            onColumnResized: replayReveal,
            columnDefs: columnDefs,
            defaultColDef: defaultColDef,
            autoGroupColumnDef: autoGroupColumnDef,
            getRowId: getRowId,
            getDataPath: getDataPath,
            rowSelection: rowSelection,
            onSelectionChanged: onSelectionChanged,
            onGridReady: onGridReady,
            onGridPreDestroyed: onGridPreDestroyed,
            onCellValueChanged: onCellValueChanged,
            processDataFromClipboard: processDataFromClipboard,
            loading: loading,
            columnDialog: columnDialog,
            initialState: sheetColumns.initialState,
            onCellDoubleClicked: onCellDoubleClicked,
            onCellKeyDown: onCellKeyDown,
            onCellFocused: onCellFocused,
        },
        gridOverlay: null,
        drawer: {
            resolveRow: resolveRow,
            columns: sheet?.columns ?? [],
            scope: drawerScope,
            compareTargets: compareTargets,
            loading: loading,
            error: error,
            onWrite: onDrawerWrite,
            onRevealCell: revealCell,
            formulas: formulas,
        },
        preferences: preferences,
        before: <>{mediaEditor.element}
    {formulaHistoryOpen && <FormulaHistoryDialog familyProductId={productId} coordinate={{ scope: 'master', market, locale }} onClose={() => setFormulaHistoryOpen(false)} onApplied={() => { formulas.reload(); refresh(); }}/>}
    {bulkFormulaRows && <FormulaBulkDialog rows={bulkFormulaRows} columns={sheet?.columns ?? []} coordinate={{ scope: 'master', market, locale }} functions={formulas.functions} preview={formulas.preview} candidatesFor={(id, fieldKey) => { const row = rowsRef.current.find(row => row.id === id); return row ? candidatesFor(row, fieldKey) : []; }} onClose={() => setBulkFormulaRows(null)} onApplied={() => { formulas.reload(); refresh(); }}/>}</>, afterGrid: <>{chipBar.activeId === 'ai-drafts' && <AiDraftReview drafts={aiLayer.drafts} skuById={skuById} onApplied={reload}/>}</>, beforePreferences: <>
        <ClassificationDialog productId={productId} open={classificationOpen} onClose={() => setClassificationOpen(false)} onChanged={onFamilyChanged}/>
    {sheet && (<ProductTransferDrawer open={importOpen} intent={transferIntent} onClose={() => setImportOpen(false)} productId={productId} market={market} locale={locale} selectedIds={selectedRows.map(row => row.id)} visibleFields={sheetColumns.visibleAttributeKeys().flatMap(key => { const c = sheet.columns.find(c => c.key === key); return c ? [c.slot?.of ?? c.key] : []; })} onReference={() => onExport('view')} onApplied={() => { formulas.reload(); reload(); familyQuery.reload(); }}/>)}
        {familyProductPicker.element}</>,
    };
}
