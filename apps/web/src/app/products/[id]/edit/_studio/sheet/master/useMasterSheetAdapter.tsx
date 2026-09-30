'use client';
import { useSheetPreferences } from '../useSheetPreferences';
import { useSheetPublicationGuard } from '../useSheetPublicationGuard';
import { buildCompareTargets } from '../compareTargets';
import { channelLabel, languageLabel } from '../../scopes';
import { productSheetRowKey, filterProductSheetRows } from '../productSheetRows';
import { useSheetChips } from '../useSheetChips';
import { useSheetSaveStatus } from '../useSheetSaveStatus';
import { useSheetUndo } from '../useSheetUndo';
import { useSheetGridBindings } from '../useSheetGridBindings';
import { useProductSheetInteraction } from '../useProductSheetInteraction';
import { useSheetGeometry } from '../useSheetGeometry';
import type { ProductSheetModel } from '../productSheetModel';
import { formulaCandidates, formulaColumnId } from '../formulaColumns';
import { sheetEmptyState } from '../sheetGridStates';
import { formulaTransfer, type CellEditorContext } from '@/design-system/grid';
import { aiDraftContextOf, historyLoaderFor, inheritedContextOf } from '../cellEditorContext';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { Banner } from '@/design-system/components';
import { Button, InfoTip, Pill } from '@/design-system/primitives';
import { SheetTransfer } from '../../transfer/SheetTransfer';
import { FormulaBulkDialog } from '../FormulaBulkDialog';
import { FormulaHistoryDialog } from '../FormulaHistoryDialog';
import { ExpandButton, ExpandSlot, IdentityBand, BAND_WIDTH_FLOOR, useExpanded, ProvenanceMark, actionContextMenu, actionMenuItems, useActionConfirm, useActionPress, GridExportRefused, sheetPasteProcessor, writeGate, exprOf, isFormulaDraft, landOnCell, type FormulaCandidate, type ColDef, type ICellRendererParams, type PrefsBridgeOptions } from '@/design-system/grid';
import { getBackendUrl } from '@/lib/backend-url';
import { ClassificationDialog } from './ClassificationDialog';
import { SCOPE_PROGRESS_COLUMN, SHARED_PROGRESS_TIP, coordinateProgressValue, coordinateReadinessColumns, listingsHref, progressColumn, progressSheetColumn, refreshProgressItem, rowProgressValue, sheetFieldAction, studioFieldHref, withoutProgressColumns, type ColumnPresence } from '../progressColumns';
import { useStudioScope, useSaveReporter, useStudioRecord, useScopeReadiness, useReadinessRefresh, useViewChips, viewChipHasCell } from '../../contracts';
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
import { FamilySelectionVerbs } from './FamilySelectionBar';
import { useFamily } from './useFamily';
import { useCellFormulas } from '../../useCellFormulas';
import { HELD_EDIT_DROPPED, HELD_FOR_FORMULAS } from '../../formulaReadiness';
import { cellOf, editRefusalReason } from './columnRules';
import type { SheetColumn, StudioRow } from './types';
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
/** Progress columns — a coordinate column's key, from its readiness column id (`ready:AMAZON:IT:acc:it` → `progress:…`). */
/* A coordinate's progress column keeps ONE id whatever language is pressed (the trailing `:<language>` is dropped), so a
   layout that hides or pins it keeps doing so in every language. */
const progressKeyOf = (readyColId: string) => `progress:${readyColId.slice('ready:'.length).replace(/:[^:]+$/, '')}`;
const marketProgressTip = (label: string, language: string, computedAt: string | null) =>
    `Progress on ${label} in ${language}: filled ÷ every field ${label} applies, required and optional, from the readiness index${computedAt ? ` (computed ${new Date(computedAt).toLocaleString()})` : ''}. Red — a required field is empty. Yellow — only optional fields are empty. Green — nothing is empty. Grey — not computed yet, which is not a score. Completeness, not publish readiness.`;

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
    return (<IdentityBand expand={expander} role={role} image={d.imageUrl} photoCount={d.imageInherited ? undefined : d.photoCount} noImage={!d.imageUrl} imageMark={d.imageInherited ? (<ProvenanceMark provenance="inherited" from="the family's picture — this variation has none of its own"/>) : null} sku={d.sku} secondary={line} secondaryTitle={line ?? undefined} menuItems={p.rowMenuRef?.current(d)} menuLabel={`Actions for ${d.sku}`}/>);
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
    /* TOOLBAR REBUILD (2026-09-27) — the channel · market bars are read again after every confirmed save (the server
       rebuilds the index inside the write), on Reload and on "Refresh progress". A burst of saves asks once. */
    const refreshReadiness = useReadinessRefresh();
    const readinessTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (readinessTimer.current) clearTimeout(readinessTimer.current); }, []);
    const refreshReadinessSoon = useCallback(() => {
        if (readinessTimer.current) clearTimeout(readinessTimer.current);
        readinessTimer.current = setTimeout(() => { readinessTimer.current = null; refreshReadiness(); }, 800);
    }, [refreshReadiness]);
    const readinessRef = useRef(readinessQuery);
    readinessRef.current = readinessQuery;
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
        if (ok) {
            setLastSavedAt(savedAt);
            refreshReadinessSoon();
        }
    }, [refreshReadinessSoon]);
    /* The family read (`useFamily`, below) is refreshed after an accepted theme save — the family bar and "Add child" read
       the axes from it. A ref, because that read is created after this hook. */
    const reloadFamilyRef = useRef<() => void>(() => undefined);
    const { sheet: loadedSheet, loading, switching, error, contractProblems, reload, refresh, writer, tracker, conflicts, bindGrid } = useMasterSheet({
        productId, market, locale, locales: languageScope.locales, onWriteStart, onWriteEnd, onSettled,
        onVariationThemeSaved: () => reloadFamilyRef.current(),
        /* R-VT-15 — the server's refusal sentence, said the moment it arrives, through the ONE DS
           toast provider this route mounts (`_studio/StudioClient.tsx`; the root layout's is the old
           library's — `reference_ds_toast_two_providers`). `announceRefusals` is the shared
           implementation in `useProductSheetInteraction`, so both scopes and both moments (fresh
           refusal, and returning to a marked cell) say it one way. */
        onRefused: announceRefusals,
    });
    const sheet = useReferenceNames(loadedSheet, 'MASTER', market);
    useSheetPublicationGuard(writer, tracker, getGridApi);
    const formulaRowIds = useMemo(() => (sheet?.rows ?? []).map((r) => r.id), [sheet]);
    /* P0 — the studio read's rows already say which cells hold a formula. Not a legacy read (it carries none) and not the
       previous language's sheet, which stays on screen while the next one loads. */
    const formulaSeedRows = useMemo(() => sheet?.meta.source === 'studio' && sheet.scope.locale === locale ? sheet.rows.map(row => ({ rowId: row.id, values: row.values })) : undefined, [sheet, locale]);
    const formulas = useCellFormulas({ writeFacts: (rowId, fieldKey) => sheet?.rows.find(row => row.id === rowId)?.values[fieldKey], productId, market, locale, columnKeys: sheet?.columns.map(column => column.key), rowIds: formulaRowIds, seedRows: formulaSeedRows, onSettled: refresh, onValueSaved: (rowId, fieldKey, value) => {
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
    /* Option A (2026-09-26) — the cell editor's AI draft, history and "follows" context. Assigned below, once the AI layer
       and the drawer scope exist; read through this ref so the wiring stays one stable object. */
    const editorContextLive = useRef<(row: StudioRow, key: string) => CellEditorContext | null>(() => null);
    const formulaWiring = useMemo(() => ({
        candidatesFor: (row: StudioRow, fieldKey?: string) => formulaLive.current.candidatesFor(row, fieldKey),
        preview: (rowId: string, fieldKey: string, expr: string, signal?: AbortSignal) => formulaLive.current.formulas.preview(rowId, fieldKey, expr, signal),
        functions: () => formulaLive.current.formulas.functions,
        replaceFormula: (rowId: string, fieldKey: string, value: unknown) => formulaLive.current.formulas.replace(rowId, fieldKey, value),
        unavailableReason: (rowId: string | undefined, fieldKey: string) => formulaLive.current.formulas.unavailableFor(rowId, fieldKey),
        retry: () => formulaLive.current.formulas.reload(),
        sourceLabel: (fieldKey?: string) => formulaLive.current.formulas.sourceLabelFor(fieldKey),
        exprFor: (rowId: string, fieldKey: string) => formulaLive.current.formulas.exprFor(rowId, fieldKey),
        errorFor: (rowId: string, fieldKey: string) => formulaLive.current.formulas.errorFor(rowId, fieldKey),
        colIdOfRef: (name: string, fieldKey?: string) => formulaLive.current.colIdOfRef(name, fieldKey),
        contextFor: (row: StudioRow, key: string) => editorContextLive.current(row, key),
    }), []);
    const formulaClipboard = useMemo(() => formulaTransfer<StudioRow>({
        exprFor: (row, key) => formulaWiring.exprFor(row.id, key),
    }), [formulaWiring]);
    const familyQuery = useFamily(productId);
    reloadFamilyRef.current = familyQuery.reload;
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
    const onFamilyChanged = useCallback(() => { familyQuery.reload(); reload(); refreshReadinessSoon(); }, [familyQuery, reload, refreshReadinessSoon]);
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
    const { pending, refused, retryable, refusedRowIds, offline, saving } = useSheetSaveStatus(writer, tracker, rows, sheet?.columns);
    /* ⌘Z undoes a whole operation (a fill, a paste) in one step and one save, and still works after the sheet re-reads. */
    const undo = useSheetUndo(writer, getGridApi);
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
            refreshReadiness();
            return;
        }
        if (!(await reloadConfirm.ask(impact)))
            return;
        reporter.cleared(sheet?.rows.map(row => row.id) ?? [...refusedRowIds]);
        writer.discard();
        reload();
        refreshReadiness();
    }, [writer, refused, refusedRowIds, sheet, reporter, reload, reloadConfirm, refreshReadiness]);
    /** "Refresh progress": the rows' own bars (a quiet re-read — edits in flight stay) and the channel · market bars. */
    const refreshProgress = useCallback(() => { refresh(); refreshReadiness(); }, [refresh, refreshReadiness]);
    const progressMenu = useCallback(() => {
        const q = readinessRef.current;
        return [refreshProgressItem(refreshProgress, q.status === 'ready' ? q.at : null, q.status === 'ready' ? q.refreshError : q.status === 'error' ? q.message : null)];
    }, [refreshProgress]);
    const mediaEditor = useProductMediaEditor(refresh, locale);
    const mediaClipboard = useMemo(() => mediaGridTransfer(formulaClipboard, mediaEditor.actions), [formulaClipboard, mediaEditor.actions]);
    /* Progress columns (2026-09-26) — members of the column model (Customise, views, locks), built by `progressColumns`
       below. The per-market ones follow the readiness index for the pressed language. */
    const coordinateColumns = useMemo(() => coordinateReadinessColumns(readinessMatrix, locale), [readinessMatrix, locale]);
    const progressSpecs = useMemo<SheetColumn[]>(() => (sheet ? [
        progressSheetColumn<SheetColumn>(SCOPE_PROGRESS_COLUMN, 'Shared product', SHARED_PROGRESS_TIP),
        ...coordinateColumns.map((c) => progressSheetColumn<SheetColumn>(progressKeyOf(c.colId), c.label, marketProgressTip(c.label, languageLabel(c.language), c.computedAt))),
    ] : []), [sheet, coordinateColumns]);
    const schemaColumns = useMemo(() => [...progressSpecs, ...withProductMediaColumn(sheet?.columns ?? []).filter((c) => !RESERVED_COLUMN_IDS.includes(c.key as never))], [sheet, progressSpecs]);
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
        viewCtx,
        serverViews: sheet?.views,
        identityColumn: IDENTITY_COLUMN,
        prefsBridge,
        activeChip: chipBar.active,
        /* TOOLBAR REBUILD (2026-09-27) — one layout and one remembered view for the shared product, on every market. */
        layoutSurface: 'product-edit:layout:master',
        legacyLayoutSurface: `product-edit:layout:master:${market.toUpperCase()}`,
        productType: sheet ? sheet.family.productType ?? null : undefined,
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
    const attributeColumns = useMemo(() => (sheet ? buildSheetColumns('master', { columns: withoutProgressColumns(schemaColumns).filter(column => column.key !== PRODUCT_MEDIA_COLUMN), tracker, locale, market, reservedColumnIds: RESERVED_COLUMN_IDS, isChipCell, draftFor: aiLayer.draftFor, formula: formulaWiring }, rowsRef) : []), [sheet, schemaColumns, tracker, locale, market, isChipCell, aiLayer.draftFor, formulaWiring]);
    const identityColumns = useMemo<ColDef<StudioRow>[]>(() => [], []);
    /* Progress columns (2026-09-26) — what the card's actions call. Read through refs: the column set is built before
       the grid exists, and a card is opened long after either is current. */
    const presenceRef = useRef<(field: string) => ColumnPresence>(() => 'absent');
    const goToFieldRef = useRef<(productId: string, field: string) => void>(() => undefined);
    presenceRef.current = (field) => {
        const col = getGridApi()?.getColumn(field);
        return !col ? 'absent' : col.isVisible() ? 'visible' : 'hidden';
    };
    goToFieldRef.current = (productId, field) => {
        const api = getGridApi();
        if (!api) return;
        // The engine's landing: open the family, scroll the row to the middle, put the cursor in the cell, mark it.
        // The sheet's own reveal keeps the column clear of an open record panel.
        landOnCell(api, { rowId: productId, colId: field, reveal: (colId) => revealCell(colId, 'reveal'), root: document.querySelector('.nds-grid-sheet') ?? undefined });
    };
    /**
     * The PROGRESS COLUMNS (2026-09-26) — they replace the "Readiness · <label>" columns and the grey bar in the Product
     * cell. One for the shared product (this sheet's own rows, measured live), then one per channel · market the
     * readiness index has rows for in the pressed language (the same read the scope chips use — one request, one
     * authority). Built by the ONE builder both scopes use (`../progressColumns`).
     */
    const progressColumns = useMemo<ColDef<StudioRow>[]>(() => {
        if (!sheet) return [];
        const subjectOf = (p: ICellRendererParams) => (p.data as StudioRow | undefined)?.sku ?? null;
        const own = progressColumn<StudioRow>({
            colId: SCOPE_PROGRESS_COLUMN,
            headerName: 'Shared product',
            headerTooltip: SHARED_PROGRESS_TIP,
            value: (row) => rowProgressValue(row),
            menu: progressMenu,
            cell: {
                scopeLabel: 'Shared product',
                subjectOf,
                actionFor: (field, label) => sheetFieldAction(presenceRef.current(field), label, 'Not a column on this sheet'),
                onGoTo: (field, p) => { const row = p.data as StudioRow | undefined; if (row) goToFieldRef.current(row.id, field); },
                footerLink: () => ({ label: 'All products for the shared product', href: listingsHref({ channel: null, language: locale }) }),
            },
        });
        const perMarket = coordinateColumns.map((c) => progressColumn<StudioRow>({
            colId: progressKeyOf(c.colId),
            headerName: c.label,
            headerTooltip: marketProgressTip(c.label, languageLabel(c.language), c.computedAt),
            value: (row) => coordinateProgressValue(c.byProduct[row.id], c.missingByProduct[row.id] ?? [], c.optionalByProduct[row.id] ?? []),
            menu: progressMenu,
            cell: {
                scopeLabel: c.label,
                subjectOf,
                // A channel field is edited in its own scope: the link opens that scope at this row and field.
                actionFor: (field, _label, p) => {
                    const row = p.data as StudioRow | undefined;
                    if (!row || !c.channel) return { kind: 'none', text: 'Edit it on the shared product.' };
                    return { kind: 'link', label: `Open in ${c.label}`, href: studioFieldHref(window.location, {
                        scope: c.channel, market: c.market, locale: c.language, accountId: c.accountId, aliasId: c.aliasId,
                        rowId: `${c.aliasId ?? 'primary'}:${row.id}`, field }) };
                },
                onGoTo: () => undefined,
                footerLink: () => ({ label: `All products for ${c.label}`, href: listingsHref({ channel: c.channel, market: c.market, language: c.language }) }),
            },
        }));
        return [own, ...perMarket];
    }, [sheet, coordinateColumns, locale, progressMenu]);
    const columnDefs = useMemo(() => {
        const rank = new Map(orderColumnKeys(schemaColumns, viewCtx).map((k, i) => [k, i]));
        const ordered = attributeColumns
            .map((c, i) => ({ c, r: rankOfColumn(c, rank), i }))
            .sort((a, b) => a.r - b.r || a.i - b.i)
            .map((x) => x.c);
        return [...identityColumns, ...progressColumns, productMediaColumn<StudioRow>(mediaEditor.open, mediaEditor.actions), ...ordered];
    }, [identityColumns, attributeColumns, progressColumns, schemaColumns, viewCtx, mediaEditor.open, mediaEditor.actions]);
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
        /* P0 — a cell whose formula state is not known yet keeps the edit and applies it once it is (the formula path if
           the cell turns out to hold one). Never refused: the refusal lost every paste made while formulas loaded. */
        if (!formulas.knownFor(e.data.id, colId!)) {
            const rowId = e.data.id;
            tracker.set(rowId, colId!, 'saving', HELD_FOR_FORMULAS);
            formulas.whenKnown(rowId, colId!, () => {
                if (tracker.get(rowId, colId!)?.reason === HELD_FOR_FORMULAS)
                    latestValueChanged.current(e);
            }, (reason) => tracker.set(rowId, colId!, 'refused', reason ?? HELD_EDIT_DROPPED));
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
        undo.record({ rowId: e.data.id, colId: colId!, before: e.oldValue, after: e.newValue }, e.source);
        writer.set(e.data.id, colId!, e.newValue, { row: e.data });
    }, [writer, formulas, onWriteStart, onWriteEnd, reload, undo.record]);
    /* A held edit re-enters through the LATEST handler, which sees the formula state that released it. */
    const latestValueChanged = useRef(onCellValueChanged);
    latestValueChanged.current = onCellValueChanged;
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
    const { preferences, columnDialog, openCustomise, openNewView } = useSheetPreferences({ scope: 'master', sheetColumns, getGridApi, bandWidthRef, bandDerivedRef, revealCell });
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
    editorContextLive.current = (row, key) => ({
        aiDraft: aiDraftContextOf(aiLayer.drafts.drafts.find(d => d.productId === row.id && d.columnKey === key && d.status === 'pending'),
            { approve: ids => aiLayer.drafts.approve(ids), reject: ids => aiLayer.drafts.reject(ids), onApplied: reload }),
        history: historyLoaderFor(row, key, drawerScope),
        // A content cell can name its OWN row as the source (it falls back to the shared record): say "the parent".
        inherited: inheritedContextOf(row.values[key], from => from === row.id ? null : skuById[from]),
    });
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
        loading, switching, unavailable: !!error,
        errorLabel: 'shared product information',
        errorMessage: error,
        backendMissing: false, retry: reload,
        columns: sheetColumns,
        toolbar: {
            pendingWrite: pending > 0 || saving,
            visible: visibleRows.length,
            total: rows.length,
            selected: selected,
            /* SHEET-VIEWS (2026-09-26): the selection verbs live in the toolbar while rows are selected. */
            selectionActions: <FamilySelectionVerbs rows={selectedRows} actions={famActions} onDone={onFamilyChanged}/>,
            onClearSelection: clearSelection,
            descriptor: familySummary.role !== '—' ? (<span className="nds-cell-muted"> · {familySummary.role} · {familySummary.detail}</span>) : null,
            search: search,
            onSearch: setSearch,
            onCustomise: openCustomise,
            onNewView: openNewView,
            onExport: () => { setTransferIntent('export'); setImportOpen(true); },
            exportCounts: { view: sheetColumns.visibleAttributeKeys().length, all: sheetColumns.orderedKeys.length },
            exportDisabled: !sheet || loading || !has('products.export'),
            exportPurpose: "workbook",
            onImport: () => { setTransferIntent('import'); setImportOpen(true); },
            importDisabled: !sheet || loading || !has('products.import'),
            onReload: onReload,
            loading: loading,
            unavailable: !!error,
            overflow: [{ id: 'classification', label: 'Classification…', disabled: loading || !!error || !canEdit, description: !canEdit ? 'You do not have permission to change product classification.' : 'Choose the product family and categories.', onSelect: () => setClassificationOpen(true) }, ...familyVerbs.items, { id: 'formula-history', label: 'Formula history…', onSelect: () => setFormulaHistoryOpen(true) }, { id: 'refresh-progress', label: progressMenu()[0].name, description: 'Read the progress bars again — the shared product and every channel · market', onSelect: refreshProgress }, { id: 'bulk-formula', label: 'Apply formula to selected products…', disabled: !selected || !formulas.ready || !canEdit, onSelect: () => setBulkFormulaRows(selectedRows.map(row => ({ id: row.id, label: row.sku ?? row.id })).sort((a, b) => Number(a.id === productId) - Number(b.id === productId))) }],
            status: [
                ...(switching ? [{ tone: 'info' as const, label: 'Loading languages…', detail: 'The sheet keeps the languages it shows until the new ones arrive; editing resumes then.' }] : []),
                ...(staleTypes.length > 0 || (sheet?.meta.schemaMissing.length ?? 0) > 0 ? [{
                    tone: 'warning' as const,
                    label: (sheet?.meta.schemaMissing.length ?? 0) > 0 ? 'Setup incomplete' : 'Cached requirements',
                    detail: sheet && sheet.meta.schemaMissing.length > 0
                        ? `Attribute setup is incomplete: ${sheet.meta.schemaMissing.join(', ')}. Choose a product family in Classification; channel requirements use their selected category.`
                        : `Length caps and lists come from a schema last fetched ${staleTypes.map((t) => `${t.productType} ${t.fetchedAt.slice(0, 10)}`).join(', ')}.`,
                }] : []),
                ...familyVerbs.status,
                ...(readinessQuery.status === 'error' ? [{ tone: 'warning' as const, label: 'Progress unavailable', detail: `The channel · market progress bars could not be read: ${readinessQuery.message} Choose ⋯ → Refresh progress to try again.` }]
                    : readinessQuery.status === 'ready' && readinessQuery.refreshError ? [{ tone: 'warning' as const, label: 'Progress not refreshed', detail: `The bars show the last good reading. The refresh failed: ${readinessQuery.refreshError} Choose ⋯ → Refresh progress to try again.` }] : []),
            ],
        },
        toolbarExtra: <></>,
        status: {
            rows: visibleRows.length,
            /* The selection is counted ONCE, on the toolbar ("Selected N rows"), not again here. */
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
            retryable,
            onRetry: () => { writer.retryFailed(); },
            lastSavedAt: lastSavedAt,
        }, footerBefore: <>
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
            // One operation (fill, paste, range delete) = one undo step and one save; ⌘Z is the sheet's own (`useSheetUndo`).
            ...undo.gridProps,
            processDataFromClipboard: processDataFromClipboard,
            loading: loading,
            columnDialog: columnDialog,
            initialState: sheetColumns.initialState,
            onCellDoubleClicked: onCellDoubleClicked,
            onCellKeyDown: (event: Parameters<typeof onCellKeyDown>[0]) => { if (!undo.onKeyDown(event.event)) onCellKeyDown(event); },
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
    {sheet && (<SheetTransfer open={importOpen} intent={transferIntent} onClose={() => setImportOpen(false)} productId={productId} market={market} locale={locale} selectedIds={selectedRows.map(row => row.id)} visibleFields={sheetColumns.visibleAttributeKeys().flatMap(key => { const c = sheet.columns.find(c => c.key === key); return c ? [c.slot?.of ?? c.key] : []; })} onReference={() => onExport('view')} onApplied={() => { formulas.reload(); reload(); familyQuery.reload(); }}/>)}
        {familyProductPicker.element}</>,
    };
}
