'use client';
import { describeValueSource } from './cellDetailsSource';
import { reviewCopy } from './reviewCopy';
import { classifyProvenance } from '@/design-system/grid/renderers/provenance';
import { useSheetPreferences } from '../useSheetPreferences';
import { useSheetPublicationGuard } from '../useSheetPublicationGuard';
import { productSheetRowKey, filterProductSheetRows } from '../productSheetRows';
import { useSheetChips } from '../useSheetChips';
import { useSheetSaveStatus } from '../useSheetSaveStatus';
import { useSheetGridBindings } from '../useSheetGridBindings';
import { useProductSheetInteraction } from '../useProductSheetInteraction';
import { useSheetGeometry } from '../useSheetGeometry';
import type { ProductSheetModel } from '../productSheetModel';
import { formulaCandidates, formulaColumnId } from '../formulaColumns';
import { columnLanguages } from '../languages';
import { ShopifySheetReview } from '../../shopify/ShopifySheetReview';
import { recoverSheetRow } from '../sheetRecovery';
import { useShopifyDraftCell } from '../../shopify/ShopifyDraftCell';
import { shopifyGridTransfer } from '../../shopify/shopifyGridTransfer';
import { withShopifyColumns } from '../../shopify/unlinkedInformationColumns';
import { channelScopeUrl } from './useChannelSheet';
import { reloadImpact } from '../master/reloadGuard';
import { ProductRoleChip } from '../ProductRoleChip';
import { formulaTransfer, type CellEditorContext } from '@/design-system/grid';
import { historyLoaderFor, inheritedContextOf } from '../cellEditorContext';
import { SchemaStatus } from './SchemaStatus';
import { rulesStatus } from './rulesStatus';
import { channelLabel, languageLabel } from '../../scopes';
import { buildCompareTargets } from '../compareTargets';
import { sheetEmptyState } from '../sheetGridStates';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { mediaGridTransfer } from '../../media/mediaGridTransfer';
import { useProductMediaEditor, withProductMediaColumn } from '../../media/productMediaColumn';
import { isSlotListKey } from '@/design-system/grid/editors/slotList';
import { expandSlotListKeys, queuePendingEdit, revertPendingEdit, slotFanOut, slotListKeyOfSlot, slotListRefusal, withSlotListColumns } from '../slotListColumns';
import { CellSaveTracker, IdentityBand, ProvenanceMark, SheetWriter, bandColSpan, landOnCell, type ColDef, type ICellRendererParams, type SheetWriteRequest, type ValueGetterParams, exprOf, isFormulaDraft, composeCellTooltip, longTextTooltipLine, shapeTooltipLine, type FormulaCandidate, type FormulaWiring } from '@/design-system/grid';
import { SkuTag } from '@/design-system/grid';
import { Button } from '@/design-system/primitives';
import { Banner, EmptyState, Modal, useToast, type MenuItemDef } from '@/design-system/components';
import { refusalWords } from '@/design-system/grid/editors/refusalWords';
import { AliasBandCell, BandExpander } from './AliasBandCell';
import { SCOPE_PROGRESS_COLUMN, isProgressColumn, listingsHref, progressColumn, progressSheetColumn, refreshProgressItem, rowProgressValue, sheetFieldAction, type ColumnPresence } from '../progressColumns';
import { resetSourceLabel } from './value-source';
import { AliasPublishControl } from './AliasPublishControl';
import { useCellFormulas } from '../../useCellFormulas';
import { useActionConfirm } from '@/design-system/grid/actions/ActionConfirm';
import { wholeListWriteField } from './provenance';
import { rowProgressUnscorable, channelWriteIdentity, channelWriteGate, dataPathFor, withMappingRun, distinctVariantCount, isCellEditable, offersCascade, orderRows, rowIdOf, summariseAlias, withRowIdentity, cellHoverNote, crossChannelColumnCount, variantRowsOf } from './rows';
import { aliasMark, cascadeIntent, cascadeOf, type CascadeIntent } from './provenance';
import { studioAccountAccess } from '../../accountScope';
import type { AliasGroup as PreflightAlias } from './types';
import { mappingHref } from '@/app/channels/mapping/_shared/navigation';
import type { GetContextMenuItemsParams } from '@/design-system/grid';
import { addListingAlias, commitChannelRow, useChannelSheet, type CreatedListing } from './useChannelSheet';
import { connectAccountSentence, coordinateListingState, DRAFT_CHIP_LABEL, draftChipDetail, draftStartedMessage, notListedSentence } from '../../draftListing';
import { useReadinessRefresh, useSaveReporter, useStudioRecord, useStudioScope, useViewChips } from '../../contracts';
import type { CompareTarget } from '../../drawer/types';
import { useAuth } from '@/lib/auth/AuthProvider';
import { SheetTransfer } from '../../transfer/SheetTransfer';
import { readinessMeta } from '@/design-system/grid/renderers/readiness';
import { getBackendUrl } from '@/lib/backend-url';
import { useLiveRead } from '../../live-read/useLiveRead';
import { channelSurfaceKey } from './persistence';
import { exportGridCsv, GridExportRefused } from '@/design-system/grid/export/exportGrid';
import { useLanguageChips } from '../useLanguageChips';
import { useSheetColumns } from '../useSheetColumns';
import type { SheetExportMode } from '../sheetExport';
import type { SheetColumn as StudioSheetColumn } from '../master/types';
import type { PrefsBridgeOptions } from '@/design-system/grid/columns/columnPrefs';
import { FormulaBulkDialog } from '../FormulaBulkDialog';
import { FormulaHistoryDialog } from '../FormulaHistoryDialog';
import { actionContextMenu, actionMenuItems } from '@/design-system/grid/actions/menuAdapters';
import { useActionPress } from '@/design-system/grid/actions/useActionPress';
import { useReferenceNames } from '../useReferenceNames';
import { referenceSearchText, referenceTooltip } from '../referenceLabels';
import { RESERVED_COLUMN_IDS } from '../views';
import { flaggedColumnKeys } from '../flaggedColumns';
import { CHANNEL_VERB_PERMISSION, channelActions, type PermissionState } from './channelActions';
import { aliasKeyOf, type ChannelScopeChannel, type ChannelSheetRow, type SheetColumn, type StudioCellValue } from './types';
import './channel-sheet.css';
import { channelValidation } from '../master/channelColumns';
import { buildSheetColumns } from '../buildSheetColumns';
export interface ChannelSheetProps {
    shopifySchema?: import('@nexus/shared/shopify-linked-products').ShopifyStoreSchema | null;
    accountId?: string;
    productId: string;
    channel: ChannelScopeChannel;
    marketplace: string;
    locale?: string;
}
const DRAWER_READ_ONLY = 'Edit channel values in the sheet — the drawer is read-only on a channel scope.';
/** The server's `schemaMissing` entry for a Shopify scope built without the store's field list. */
const SHOPIFY_FIELDS_UNREAD = 'SHOPIFY:*';
export function useChannelSheetAdapter({ productId, channel, marketplace, locale, accountId, shopifySchema }: ChannelSheetProps): ProductSheetModel<ChannelSheetRow, null, ChannelSheetRow> {
    const record = useStudioRecord();
    const { apiRef, gridReady, getGridApi, bindGridApi, releaseGrid, search, setSearch, showRefusedOnly, setShowRefusedOnly, lastSavedAt, setLastSavedAt, lastDataCell, refusalReason, onCellFocused, onCellDoubleClicked, onCellKeyDown, onSelectionChanged, rowSelection, selectedRows: selected, setSelectedRows: setSelected, announceRefusals } = useProductSheetInteraction<ChannelSheetRow>('channel');
    const { toast } = useToast();
    const languageScope = useStudioScope();
    const { accounts, destination, setListing, registerScopeChangeGuard } = languageScope;
    const alternateAccount = !studioAccountAccess(accounts, accountId).supportsPrimaryTools;
    const { data: loadedData, loading, error, backendMissing, reload, refresh } = useChannelSheet({
        productId,
        locales: languageScope.locales,
        schemaRevision: shopifySchema?.revision,
        channel,
        marketplace,
        locale,
        accountId,
    });
    const selectedAlias = destination.status === 'ready' ? destination.data.aliasKey : null;
    const selectedData = useMemo(() => !loadedData || selectedAlias === null ? loadedData : {
        ...loadedData, rows: loadedData.rows.filter(row => (row.aliasId ?? '') === selectedAlias),
        aliases: loadedData.aliases.filter(alias => (alias.id ?? '') === selectedAlias),
    }, [loadedData, selectedAlias]);
    const shopifyData = useMemo(() => withShopifyColumns(selectedData, shopifySchema), [selectedData, shopifySchema]);
    const data = useReferenceNames(shopifyData, channel, marketplace, accountId);
    const refreshRef = useRef(refresh);
    refreshRef.current = refresh;
    /* TOOLBAR REBUILD (2026-09-27) — the scope's readiness (the Editing menu's percentages) is read again after every
       confirmed save, on Reload and on "Refresh progress". A burst of saves asks once. */
    const refreshReadiness = useReadinessRefresh();
    const readinessTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (readinessTimer.current) clearTimeout(readinessTimer.current); }, []);
    const refreshReadinessSoonRef = useRef(() => { });
    refreshReadinessSoonRef.current = () => {
        if (readinessTimer.current) clearTimeout(readinessTimer.current);
        readinessTimer.current = setTimeout(() => { readinessTimer.current = null; refreshReadiness(); }, 800);
    };
    /* When the rows (and so this scope's progress bars) were last read — "Refresh progress · read 12:04". */
    const [progressReadAt, setProgressReadAt] = useState<number | null>(null);
    useEffect(() => { if (data) setProgressReadAt(Date.now()); }, [data]);
    const progressReadAtRef = useRef(progressReadAt);
    progressReadAtRef.current = progressReadAt;
    const [tracker] = useState(() => new CellSaveTracker());
    const activeCellsRef = useRef<{
        byRow: Record<string, string[]>;
    } | null>(null);
    const reporter = useSaveReporter();
    const reporterRef = useRef(reporter);
    reporterRef.current = reporter;
    const writeSeq = useRef(0);
    const writeInstanceId = useId();
    const [requirementsOpen, setRequirementsOpen] = useState(false);
    const [formulaHistoryOpen, setFormulaHistoryOpen] = useState(false);
    const [bulkFormulaRows, setBulkFormulaRows] = useState<Array<{
        id: string;
        label: string;
        rowId: string;
        aliasKey: string;
    }> | null>(null);
    const [transferIntent, setTransferIntent] = useState<'import' | 'export'>('import');
    const [transferOpen, setTransferOpen] = useState(false);
    const [cellDetails, setCellDetails] = useState<{
        title: string;
        value: string;
        notes: string;
        rowId: string;
        colKey: string;
        action?: {
            label: string;
            description: string;
            run: () => void;
        };
    } | null>(null);
    const surfaceKey = channelSurfaceKey(channel, marketplace);
    const [exportNote, setExportNote] = useState<string | null>(null);
    const rows = useMemo(() => (data ? orderRows(withRowIdentity(data.rows, data.aliases)) : []), [data]);
    // Read live (Owner, 2026-09-26) — one ⋯ item and its drawer; everything else lives in _studio/live-read.
    const liveRead = useLiveRead({ productId, channel, channelLabel: data?.scope.label ?? channel, marketplace, accountId, aliasKey: selectedAlias, rows });
    const channelRefusal = (key: string, row: ChannelSheetRow): string | null => {
        const col = data?.columns.find(column => column.key === key);
        if (!col)
            return null;
        const cell = row.values?.[key];
        if (isCellEditable(cell))
            return null;
        return cell?.writeBlockedReason || refusalWords(col.label || col.key, { kind: cell?.writable === false ? 'channel-not-writable' : col.editable === false ? 'column-read-only' : 'cell-locked' });
    };
    /* Step 4.3 #3 — a locked bullets cell says why: the first locked position's own reason. */
    refusalReason.current = (key, row) => isSlotListKey(key) ? slotListRefusal(key, row, data?.columns ?? [], channelRefusal) : channelRefusal(key, row);
    const { bandWidth, bandWidthRef, bandDerivedRef, revealCell } = useSheetGeometry({ scope: 'channel', rows, getGridApi, gridReady, recordId: record.rowId });
    const dataRef = useRef(data);
    dataRef.current = data;
    const rowsRef = useRef(rows);
    rowsRef.current = rows;
    /* Create path, step 6 — a save that STARTED this coordinate's draft (parent + variants) has its listings adopted
       into the rows in place (`commitChannelRow` → `adoptCreatedListings`), so the next save on any row of the family
       carries the real version. The epoch makes the header and chip read those rows again at once, and the toast
       says what happened: a draft, and nothing sent. */
    const [listingEpoch, setListingEpoch] = useState(0);
    const toastRef = useRef(toast);
    toastRef.current = toast;
    const onListingsCreatedRef = useRef<(created: CreatedListing[]) => void>(() => { });
    onListingsCreatedRef.current = (created) => {
        setListingEpoch((n) => n + 1);
        const family = dataRef.current?.family;
        if (family)
            toastRef.current(draftStartedMessage({ rootSku: family.sku, familyId: family.id, channel, market: marketplace, created }), 'success');
    };
    const formulaRowIds = useMemo(() => rows.map(r => r.rowId), [rows]);
    const formulaRowScopes = useMemo(() => Object.fromEntries(rows.map(r => [r.rowId, { productId: r.id, aliasKey: r.aliasId ?? '' }])), [rows]);
    const formulas = useCellFormulas({
        writeFacts: (rowId, fieldKey) => rows.find(row => row.rowId === rowId)?.values[fieldKey],
        productId,
        scope: 'channel',
        channel,
        marketplace,
        market: marketplace,
        locale: data?.scope.locale ?? locale ?? '',
        rowIds: formulaRowIds,
        columnKeys: data?.columns.map(column => column.key),
        rowScopes: formulaRowScopes,
        channelConnectionId: data?.scope.connectionId ?? accountId,
        onSettled: () => { void refresh(() => !tracker.hasUnconfirmedChanges && (getGridApi()?.getEditingCells().length ?? 0) === 0); },
        onValueSaved: (rowId, fieldKey, value) => {
            const node = getGridApi()?.getRowNode(rowId);
            if (!node?.data)
                return;
            const cell = node.data.values?.[fieldKey];
            if (cell)
                node.data.values = { ...node.data.values, [fieldKey]: { ...cell, value } };
            getGridApi()?.refreshCells({ rowNodes: [node], columns: [fieldKey], force: true });
        },
    });
    const candidatesFor = useCallback((row: ChannelSheetRow, fieldKey?: string): FormulaCandidate[] => {
        const cols = formulaCandidates(dataRef.current?.columns ?? [], row.values, fieldKey, locale ?? '');
        const fns = formulas.functions.map((f) => ({
            name: f.name,
            kind: 'function' as const,
            label: f.name,
            group: 'Functions',
        }));
        return [...cols, ...fns];
    }, [formulas, locale]);
    const colIdOfRef = useCallback((name: string, fieldKey?: string) => formulaColumnId(dataRef.current?.columns ?? [], name, fieldKey, dataRef.current?.scope.locale ?? ''), []);
    const formulaLive = useRef({ candidatesFor, colIdOfRef, formulas, alternateAccount });
    formulaLive.current = { candidatesFor, colIdOfRef, formulas, alternateAccount };
    /* Option A (2026-09-26) — the cell editor's history and "follows" context (this scope has no AI draft layer). Assigned
       once the scope is known; read through this ref so the wiring stays one stable object. */
    const editorContextLive = useRef<(row: ChannelSheetRow, key: string) => CellEditorContext | null>(() => null);
    useEffect(() => {
        const api = getGridApi();
        if (!api || api.isDestroyed())
            return;
        api.refreshCells({ force: true });
    }, [formulas.exprFor, formulas.errorFor]);
    const refusedReasonFor = useCallback((productId: string, fieldKey: string) => formulaLive.current.formulas.errorFor(productId, fieldKey), []);
    const formulaWiring = useMemo<FormulaWiring<ChannelSheetRow>>(() => ({
        canEditRow: () => true,
        candidatesFor: (row, fieldKey) => formulaLive.current.candidatesFor(row, fieldKey),
        preview: (rowId, fieldKey, expr, signal) => formulaLive.current.formulas.preview(rowId, fieldKey, expr, signal),
        functions: () => formulaLive.current.formulas.functions,
        replaceFormula: (rowId: string, fieldKey: string, value: unknown) => formulaLive.current.formulas.replace(rowId, fieldKey, value),
        unavailableReason: () => formulaLive.current.formulas.loadError ?? (formulaLive.current.formulas.ready ? null : 'Loading formulas…'),
        retry: () => formulaLive.current.formulas.reload(),
        sourceLabel: fieldKey => formulaLive.current.formulas.sourceLabelFor(fieldKey),
        exprFor: (rowId, fieldKey) => formulaLive.current.formulas.exprFor(rowId, fieldKey),
        errorFor: (rowId, fieldKey) => formulaLive.current.formulas.errorFor(rowId, fieldKey),
        colIdOfRef: (name, fieldKey) => formulaLive.current.colIdOfRef(name, fieldKey),
        contextFor: (row, key) => editorContextLive.current(row, key),
    }), []);
    const formulaClipboard = useMemo(() => formulaTransfer<ChannelSheetRow>({
        exprFor: (row, key) => formulaWiring.exprFor(row.rowId, key),
        canEditRow: formulaWiring.canEditRow,
    }), [formulaWiring]);
    const unsettledWrites = useRef(new Map<string, {
        writeId: string;
        subject: string;
    }>());
    const writerRef = useRef<SheetWriter<ChannelSheetRow> | null>(null);
    if (writerRef.current === null) {
        writerRef.current = new SheetWriter<ChannelSheetRow>({
            tracker,
            getApi: getGridApi,
            commit: async (req: SheetWriteRequest<ChannelSheetRow>) => {
                const { writeId, subject } = channelWriteIdentity(req.rowId, ++writeSeq.current, { channel, marketplace, accountId, locale, instanceId: writeInstanceId });
                reporterRef.current.pending(writeId, subject);
                /* VT.2 — the COLUMN's kind, so a `variationTheme` cell can leave by its own route.
                   🔴 `dataRef.current`, NOT `data`: this `commit` closure is created once and lives
                   for the writer's lifetime, so a captured `data` is whatever it was at mount —
                   `undefined` on the first render, which made `kindOf` answer undefined for every
                   column and silently disabled the split. Witnessed: a theme pick on Amazon·IT
                   reported `set` in the editor's own footer and issued no projection request at all.
                   The same ref discipline the formula candidates two hooks above already follow. */
                const result = await commitChannelRow(req, { channel, marketplace, accountId, locale, kindOf: (colId) => dataRef.current?.columns?.find((c) => c.key === colId)?.kind,
                    familyRows: () => rowsRef.current, onListingsCreated: (created) => onListingsCreatedRef.current(created) });
                if (result.unreachable)
                    unsettledWrites.current.set(req.rowId, { writeId, subject });
                else
                    reporterRef.current.resolved(writeId, result.ok, result.reason, subject);
                return result;
            },
            onConflict: () => { },
            /* R-VT-15 — the same announcement the master scope makes, from the same shared
               implementation (`useProductSheetInteraction.announceRefusals`), through the one DS toast
               provider this route mounts. Captured once with the writer because it is a stable
               `useCallback`; a changing callback here would rebuild the writer and orphan its queue.
               Before this the channel scope's refusals — including the axis and content-address ones
               this programme measured — appeared only as a red cell mark. */
            onRefused: announceRefusals,
            readBack: async (request) => {
                const recoveryLanguages = columnLanguages(request.cells.map(cell => cell.colId));
                const response = await fetch(channelScopeUrl({ productId, channel, marketplace, accountId, locale, locales: recoveryLanguages.length ? [...new Set([...(locale ? [locale] : []), ...recoveryLanguages])] : null }), { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(30000) });
                if (!response.ok)
                    return null;
                return recoverSheetRow(await response.json(), request, { channel, market: marketplace, accountId, locale });
            },
            onReconciled: ({ rowId, ok, savedAt }) => {
                const { writeId, subject } = channelWriteIdentity(rowId, ++writeSeq.current, { channel, marketplace, accountId, locale, instanceId: writeInstanceId });
                const held = unsettledWrites.current.get(rowId);
                ok = ok && !Object.keys(rowsRef.current.find(row => row.rowId === rowId)?.values ?? {}).some(key => tracker.get(rowId, key)?.state === 'refused');
                reporterRef.current.resolved(held?.writeId ?? writeId, ok, ok ? undefined : 'Review the highlighted edits against the stored values.', held?.subject ?? subject);
                unsettledWrites.current.delete(rowId);
                if (ok) {
                    setLastSavedAt(savedAt);
                    refreshReadinessSoonRef.current();
                    void refreshRef.current(() => writerRef.current?.pending === 0 && !tracker.hasUnconfirmedChanges && (getGridApi()?.getEditingCells().length ?? 0) === 0);
                }
            },
            onSettled: ({ ok, savedAt }) => {
                if (!ok)
                    return;
                setLastSavedAt(savedAt);
                refreshReadinessSoonRef.current();
                if (writerRef.current?.pending !== 0)
                    return;
                const savedSequence = writeSeq.current;
                void refreshRef.current(() => writeSeq.current === savedSequence && writerRef.current?.pending === 0 &&
                    !tracker.hasUnconfirmedChanges &&
                    (getGridApi()?.getEditingCells().length ?? 0) === 0);
            },
        });
    }
    const writer = writerRef.current;
    useSheetPublicationGuard(writer, tracker, getGridApi);
    const { pending, refused, refusedRowIds, offline, saving, refreshCounts } = useSheetSaveStatus(writer, tracker, rows, data?.columns);
    useEffect(() => {
        writer.arm();
        return () => writer.destroy();
    }, [writer]);
    useEffect(() => {
        if (!data)
            return;
        writer.seed(rows.map((r) => ({ id: r.rowId, version: r.version, row: r })));
    }, [data, rows, writer]);
    const refreshCountsRef = useRef(refreshCounts);
    refreshCountsRef.current = refreshCounts;
    const reloadConfirm = useActionConfirm();
    const onReload = useCallback(async () => {
        const impact = reloadImpact({ pending: writer.pending, refused, unknown: writer.unknownCount });
        if (impact && !(await reloadConfirm.ask(impact)))
            return;
        reporterRef.current.cleared(rows.map(row => channelWriteIdentity(row.rowId, 0, { channel, marketplace, accountId, locale, instanceId: writeInstanceId }).subject));
        writer.discard();
        reload();
        refreshReadiness();
    }, [writer, refused, rows, channel, marketplace, accountId, locale, writeInstanceId, reload, reloadConfirm.ask, refreshReadiness]);
    /** "Refresh progress": the rows' bars (a quiet re-read — edits in flight stay) and the scope's readiness. */
    const refreshProgress = useCallback(() => {
        refreshReadiness();
        void refreshRef.current(() => !tracker.hasUnconfirmedChanges && (getGridApi()?.getEditingCells().length ?? 0) === 0);
    }, [refreshReadiness, tracker, getGridApi]);
    const aliasLabel = useCallback((aliasId: string | null) => {
        const alias = data?.aliases.find((a) => aliasKeyOf(a.id) === aliasKeyOf(aliasId));
        return alias?.label == null ? 'Listing alias label not reported' : alias.label;
    }, [data]);
    const listResetConfirm = useActionConfirm();
    const onCascade = useCallback(async (row: ChannelSheetRow, cell: StudioCellValue, intent: CascadeIntent) => {
        if (!offersCascade(cell))
            return;
        const colKey = Object.keys(row.values).find((k) => row.values[k] === cell) ?? cell.writeField;
        if (intent.action === 'reset' && wholeListWriteField(cell.writeField)) {
            await writer.flush();
            const base = wholeListWriteField(cell.writeField)!;
            const slots = (data?.columns ?? []).filter(col => wholeListWriteField(row.values[col.key]?.writeField ?? '') === base);
            const followsMaster = !!cell.mapped?.sourcePath && !cell.mapped.usesExpression;
            const confirmed = await listResetConfirm.ask({ level: 'confirm', title: followsMaster ? 'Follow Master for the whole list?' : 'Remove the whole list’s override?',
                consequences: [
                    `Remove the override for all ${slots.length} positions in this list for ${row.sku} on ${channel} · ${marketplace}, ${aliasLabel(row.aliasId)}.`,
                    followsMaster ? 'Future Master changes will flow through its channel mapping.' : 'The list will use its configured mapping or default. It may become empty if no source is configured.',
                    'Current values being replaced:',
                    ...slots.map(col => `${col.label}: ${String(row.values[col.key]?.value ?? 'Empty')}`),
                ] });
            if (!confirmed)
                return;
            writer.set(row.rowId, colKey, null, { row, intent: 'reset-list' });
            return;
        }
        writer.set(row.rowId, colKey, intent.value, { row, intent: intent.action });
    }, [writer, data, channel, marketplace, aliasLabel, listResetConfirm.ask]);
    type PendingContentEdit = {
        rowId: string;
        colId: string;
        value: unknown;
        row: ChannelSheetRow;
        previous: unknown;
    };
    const [pendingWrites, setPendingWrites] = useState<PendingContentEdit[]>([]);
    const pendingMasterWrite = pendingWrites[0] ?? null;
    /* LX.14 — one queued choice per edited cell (a bullets cell's positions queue one each); the reducer lives in
       `slotListColumns.ts` unchanged so the bullets arm runs it. */
    const setPendingMasterWrite = (next: PendingContentEdit | null) => setPendingWrites(prior => queuePendingEdit(prior, next));
    const acknowledgedRef = useRef(false);
    const revertingRef = useRef(false);
    useEffect(() => {
        acknowledgedRef.current = false;
        setPendingWrites([]);
    }, [channel, marketplace, accountId, locale]);
    const onCellValueChanged = useCallback((e: {
        data?: ChannelSheetRow;
        colDef: {
            colId?: string;
        };
        newValue: unknown;
        source?: string;
        oldValue?: unknown;
    }): void => {
        const colId = e.colDef.colId;
        if (!e.data || !colId)
            return;
        /* Step 4.3 #3 (A-52, R-55) — the one bullets cell is not a field: its change leaves as one dispatch per CHANGED
           position, each through THIS handler under that slot's own column id (gate, acknowledgement, formula check,
           `writer.set`) — exactly the path a typed slot takes. The writer coalesces them into the row's one request. */
        const fanOut = slotFanOut(colId, e.oldValue, e.newValue, dataRef.current?.columns ?? []);
        if (fanOut) {
            for (const slot of fanOut)
                onCellValueChanged({ data: e.data, colDef: { colId: slot.colId }, oldValue: slot.oldValue, newValue: e.data.values?.[slot.colId]?.value ?? slot.newValue, source: e.source });
            const node = getGridApi()?.getRowNode(rowIdOf(e.data));
            if (node)
                getGridApi()?.refreshCells({ force: true, rowNodes: [node], columns: [colId] });
            return;
        }
        const gate = channelWriteGate({
            colId,
            source: e.source,
            selfInflicted: revertingRef.current,
            cell: e.data.values?.[colId],
            acknowledged: acknowledgedRef.current,
        });
        if (gate === 'ignore' || gate === 'blocked')
            return;
        if (gate === 'acknowledge') {
            setPendingMasterWrite({
                rowId: e.data.rowId,
                colId,
                value: e.newValue,
                row: e.data,
                previous: (e as {
                    oldValue?: unknown;
                }).oldValue,
            });
            return;
        }
        const shopifyValue = !!data?.columns.find(column => column.key === colId)?.shopifyField;
        if (!shopifyValue && !formulas.ready) {
            const reason = formulas.loadError ?? 'Formulas are still loading. Retry this edit once they are ready.';
            tracker.set(e.data.rowId, colId, 'refused', reason);
            const { writeId, subject } = channelWriteIdentity(e.data.rowId, ++writeSeq.current, { channel, marketplace, accountId, locale, instanceId: writeInstanceId });
            reporterRef.current.pending(writeId, subject);
            reporterRef.current.resolved(writeId, false, reason, subject);
            return;
        }
        const typed = typeof e.newValue === 'string' ? e.newValue : null;
        if (!shopifyValue && ((typed !== null && isFormulaDraft(typed)) || formulas.exprFor(e.data.rowId, colId!))) {
            const row = e.data;
            const prev = row.values?.[colId];
            if (prev) {
                row.values = { ...row.values, [colId]: { ...prev, value: e.oldValue } };
                const node = getGridApi()?.getRowNode(rowIdOf(row));
                if (node)
                    getGridApi()?.refreshCells({ force: true, rowNodes: [node], columns: [colId] });
            }
            const { writeId, subject } = channelWriteIdentity(row.rowId, ++writeSeq.current, { channel, marketplace, accountId, locale, instanceId: writeInstanceId });
            reporterRef.current.pending(writeId, subject);
            void (typed !== null && isFormulaDraft(typed) ? formulas.save(row.rowId, colId, exprOf(typed)) : formulas.replace(row.rowId, colId, e.newValue))
                .then((r) => {
                reporterRef.current.resolved(writeId, r.ok, r.error, subject);
                tracker.set(row.rowId, colId, r.ok ? 'saved' : 'refused', r.error);
                if (!r.ok) {
                    const cell = row.values?.[colId];
                    if (cell) {
                        row.values = { ...row.values, [colId]: { ...cell, value: e.newValue } };
                        const n = getGridApi()?.getRowNode(rowIdOf(row));
                        if (n)
                            getGridApi()?.refreshCells({ force: true, rowNodes: [n], columns: [colId] });
                    }
                }
            })
                .catch((err: unknown) => {
                const reason = err instanceof Error ? err.message : String(err);
                tracker.set(row.rowId, colId, 'unknown', `Could not confirm this save. Refresh to check: ${reason}`);
                reporterRef.current.resolved(writeId, false, reason, subject);
            });
            return;
        }
        writer.set(e.data.rowId, colId, e.newValue, { row: e.data, intent: 'set' });
    }, [writer, formulas, reload, channel, marketplace, accountId, locale, writeInstanceId]);
    /* The band stops before the progress column (2026-09-26): the listing row keeps its own progress cell there, as
       master's parent row does. */
    const bandSpan = useMemo(() => bandColSpan<ChannelSheetRow>({ isBand: (d) => d?.rowKind === 'parent', stopBefore: isProgressColumn }), []);
    const auth = useAuth();
    const permission: PermissionState = auth.status === 'loading' ? 'checking'
        : auth.status === 'anon' ? 'no-session'
            : auth.has(CHANNEL_VERB_PERMISSION) ? 'granted'
                : 'denied';
    const verbs = useMemo(() => data
        ? channelActions({
            accountSpecific: alternateAccount,
            channelConnectionId: data.scope.connectionId,
            channel,
            marketplace,
            scopeLabel: data.scope.label,
            aliases: data.aliases,
            permission,
            siblingMarkets: [],
            pickMarkets: async () => null,
            openRecord: (rowId: string) => record.open(rowId, lastDataCell.current ?? undefined),
            openRecordId: record.rowId,
        })
        : [], [data, channel, marketplace, permission, record.open, record.rowId, alternateAccount]);
    const { press, problem, clearProblem, confirmElement } = useActionPress<ChannelSheetRow>();
    const isRecordRow = useCallback((r: ChannelSheetRow) => r.rowKind === 'variant', []);
    const menuItems = useMemo(() => actionMenuItems<ChannelSheetRow>({ actions: verbs, onSelect: press, isRecord: isRecordRow }), [verbs, press, isRecordRow]);
    const openCellDetails = useCallback((row: ChannelSheetRow, column: SheetColumn) => {
        const cell = row.values[column.key];
        const value = cell?.value;
        const formulaReason = refusedReasonFor(row.rowId, column.key);
        const source = describeValueSource(cell, classifyProvenance({ ...withMappingRun(cell, data?.meta?.mapping?.productLevelOnly ?? false), refusedReason: formulaReason }, 'channel'), formulaReason);
        const layer = cascadeOf(cell, row.rowKind);
        const intent = cell && offersCascade(cell) && cell.editable && layer !== 'unset' && !['formula', 'warning', 'ai'].includes(source.kind)
            ? cascadeIntent(layer, row.rowKind, value ?? null) : null;
        setCellDetails({
            title: `${column.label}: ${row.sku}`,
            rowId: row.rowId,
            colKey: column.key,
            action: intent && cell ? {
                label: intent.action === 'pin' ? 'Keep as listing override' : wholeListWriteField(cell.writeField) ? 'Review removing list override…' : 'Remove listing override',
                description: intent.action === 'pin'
                    ? `Keep the current value for ${row.sku} · ${aliasLabel(row.aliasId)} on this channel and market.`
                    : `Remove this ${wholeListWriteField(cell.writeField) ? 'whole list’s' : 'listing'} override and ${resetSourceLabel(cell)}.`,
                run: () => { void onCascade(row, cell, intent); },
            } : undefined,
            value: value == null || value === '' ? 'Empty' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value),
            notes: composeCellTooltip(tracker.get(row.rowId, column.key)?.reason, channelValidation(column).validate(value, row, column.key).message, cell?.mapped?.errors.join('\n'), cell?.mapped?.warnings.join('\n'), `${source.label}. ${source.description}`, column.kind === 'longtext' ? longTextTooltipLine(value, column) : null, shapeTooltipLine(column, value), referenceTooltip(value, column.optionLabels), cellHoverNote(cell, data?.scope.label ?? ''), column.helpText),
        });
    }, [data, tracker, refusedReasonFor, onCascade, aliasLabel]);
    const closeCellDetails = useCallback(() => {
        const previous = cellDetails;
        setCellDetails(null);
        if (previous)
            requestAnimationFrame(() => {
                const api = getGridApi(), node = api?.getRowNode(previous.rowId);
                if (node?.rowIndex != null)
                    api?.setFocusedCell(node.rowIndex, previous.colKey);
            });
    }, [cellDetails, getGridApi]);
    const contextMenu = useMemo(() => {
        const actions = actionContextMenu<ChannelSheetRow>({ actions: verbs, onSelect: press, isRecord: isRecordRow });
        return (params: GetContextMenuItemsParams<ChannelSheetRow>) => {
            const items = actions(params);
            const row = params.node?.data;
            const column = data?.columns.find(c => c.key === params.column?.getColId());
            if (row && column)
                items.unshift({ name: 'Cell details…', action: () => openCellDetails(row, column) });
            const mapping = data && column?.channels?.[data.scope.label];
            const field = mapping?.key ?? mapping?.attribute;
            if (!row || !field)
                return items;
            const supplyingRule = column && row.values[column.key]?.mapped?.supplyingRule;
            return [{ name: 'Open reusable mapping for this field', tooltip: 'This rule can affect other matching products. Opens separately to preserve your edits.',
                    action: () => window.open(supplyingRule?.href ?? mappingHref({ channel, market: marketplace, category: row.productType, field, productId: row.id }), '_blank', 'noopener') }, ...items];
        };
    }, [verbs, press, isRecordRow, data, channel, marketplace, openCellDetails]);
    const productLevelOnly = data?.meta?.mapping?.productLevelOnly ?? false;
    const familyShowsAxes = useMemo(() => {
        const variants = rows.filter((r) => r.rowKind === 'variant');
        return variants.length > 0 && variants.every((r) => Object.keys(r.axisValues ?? {}).length > 0);
    }, [rows]);
    const viewCtx = useMemo(() => ({
        variationAxes: data?.family?.variationAxes ?? [],
        locale: data?.scope.locale ?? locale ?? '',
        flaggedKeys: flaggedColumnKeys(rows),
        requiredKeys: [...new Set(rows.flatMap(row => Object.entries(row.values).filter(([, cell]) => cell.mapped?.requiredByRule).map(([key]) => key)))],
    }), [data, rows, locale]);
    const shopifyEditor = useShopifyDraftCell(shopifySchema, getGridApi);
    const mediaEditor = useProductMediaEditor(() => { void refresh(() => !tracker.hasUnconfirmedChanges && (getGridApi()?.getEditingCells().length ?? 0) === 0); }, data?.scope.locale ?? locale);
    const mediaClipboard = useMemo(() => mediaGridTransfer(formulaClipboard, mediaEditor.actions), [formulaClipboard, mediaEditor.actions]);
    /* Step 4.3 #3 (A-52, R-56) — the one bullets cell joins the grid's columns (the media column's pattern): built, in
       Customise, in the views; never a server column, never a write field. */
    const gridColumns = useMemo(() => withSlotListColumns(withProductMediaColumn(data?.columns ?? []).filter((col) => !RESERVED_COLUMN_IDS.includes(col.key as never))), [data]);
    const columnDefs = useMemo(() => buildSheetColumns('channel', {
        data, gridColumns, formulaWiring, accountId, openCellDetails, productLevelOnly,
        refusedReasonFor, tracker, activeCellsRef, viewCtx, mediaEditor, shopifyEditor, shopifySchema, auth,
    }), [data, gridColumns, formulaWiring, accountId, openCellDetails, productLevelOnly, refusedReasonFor,
        tracker, viewCtx, mediaEditor.open, mediaEditor.actions, shopifyEditor.open, shopifySchema, auth]);
    /**
     * The scope's PROGRESS COLUMN (2026-09-26) — the bar left the Product cell. The same builder as master
     * (`../progressColumns`), fed by this sheet's own rows: `completeness` is measured against THIS channel's fields.
     */
    const progressColumns = useMemo<ColDef<ChannelSheetRow>[]>(() => {
        if (!data) return [];
        const label = data.scope.label;
        const presence = (field: string): ColumnPresence => {
            const col = getGridApi()?.getColumn(field);
            return !col ? 'absent' : col.isVisible() ? 'visible' : 'hidden';
        };
        return [progressColumn<ChannelSheetRow>({
            colId: SCOPE_PROGRESS_COLUMN,
            headerName: label,
            headerTooltip: `Progress on ${label}: filled ÷ every field ${label} applies here, required and optional. Red — a required field is empty. Yellow — only optional fields are empty. Green — nothing is empty. Grey — this listing cannot be scored yet. Hover or click a bar to see what is missing. Completeness, not publish readiness.`,
            value: (row) => rowProgressValue(row, rowProgressUnscorable(row, dataRef.current?.aliases.find(alias => aliasKeyOf(alias.id) === aliasKeyOf(row.aliasId)))),
            menu: () => [refreshProgressItem(refreshProgress, progressReadAtRef.current)],
            cell: {
                scopeLabel: label,
                subjectOf: (p) => (p.data as ChannelSheetRow | undefined)?.sku ?? null,
                actionFor: (field, fieldLabel) => sheetFieldAction(presence(field), fieldLabel, 'Not a column on this sheet'),
                onGoTo: (field, p) => {
                    const row = p.data as ChannelSheetRow | undefined;
                    const api = getGridApi();
                    if (row && api) landOnCell(api, { rowId: rowIdOf(row), colId: field, reveal: (colId) => revealCell(colId, 'reveal'), root: document.querySelector('.nds-grid-sheet') ?? undefined });
                },
                footerLink: () => ({ label: `All products for ${label}`, href: listingsHref({ channel: data.scope.channel, market: marketplace, language: data.scope.locale }) }),
            },
        })];
    }, [data, marketplace, getGridApi, revealCell, refreshProgress]);
    const allColumnDefs = useMemo(() => [...progressColumns, ...columnDefs], [progressColumns, columnDefs]);
    const searchColumnLabels = useMemo(() => new Map(gridColumns.map(col => [col.key, col.optionLabels])), [gridColumns]);
    const searchTerm = search.trim().toLowerCase();
    const matchesSearch = useCallback((r: ChannelSheetRow) => {
        if (!searchTerm)
            return true;
        if (`${r.sku ?? ''} ${r.name ?? ''}`.toLowerCase().includes(searchTerm))
            return true;
        return Object.entries(r.values ?? {}).some(([key, c]) => referenceSearchText(c?.value, searchColumnLabels.get(key)).includes(searchTerm));
    }, [searchTerm, searchColumnLabels]);
    const scopeRows = useMemo(() => {
        const afterRefused = showRefusedOnly && refusedRowIds.size ? filterProductSheetRows(rows, row => refusedRowIds.has(productSheetRowKey(row))) : rows;
        return searchTerm ? filterProductSheetRows(afterRefused, matchesSearch) : afterRefused;
    }, [rows, searchTerm, matchesSearch, showRefusedOnly, refusedRowIds]);
    useLanguageChips(data ? scopeRows : null, gridColumns);
    useSheetChips(data ? scopeRows : null, gridColumns, { scope: 'channel', mapping: true, warningsId: 'channel-warnings', mappingRun: data?.meta.mapping ?? null });
    const { activeId, active, setActive } = useViewChips();
    const visibleRows = useMemo(() => active ? filterProductSheetRows(scopeRows, row => (active.cells.byRow[productSheetRowKey(row)]?.length ?? 0) > 0) : scopeRows, [scopeRows, active]);
    activeCellsRef.current = (active?.cells as {
        byRow: Record<string, string[]>;
    } | undefined) ?? null;
    useEffect(() => {
        getGridApi()?.refreshCells({ force: true });
    }, [activeId]);
    const crossChannelCols = useMemo(() => crossChannelColumnCount(rows.find((r) => r.rowKind === 'variant')), [rows]);
    /* Progress column (2026-09-26) — a member of the column model (Customise, views, locks), built above by the shared
       builder; the channel builder never sees it. */
    const modelColumns = useMemo(() => data ? [progressSheetColumn<typeof gridColumns[number]>(SCOPE_PROGRESS_COLUMN, data.scope.label, `Progress on ${data.scope.label}: filled ÷ every field it applies here, required and optional.`), ...gridColumns] : gridColumns, [data, gridColumns]);
    const schemaColumns = useMemo(() => modelColumns as never as StudioSheetColumn[], [modelColumns]);
    const prefsBridge = useMemo<PrefsBridgeOptions>(() => ({
        columns: [{ key: '__identity', locked: true }, ...modelColumns.map((c) => ({ key: c.key }))],
        treeColumnKey: '__identity',
    }), [modelColumns]);
    const sheetColumns = useSheetColumns<ChannelSheetRow, null>({
        apiRef,
        gridReady,
        columns: schemaColumns,
        viewCtx,
        identityColumn: '__identity',
        prefsBridge,
        activeChip: active,
        /* TOOLBAR REBUILD (2026-09-27) — one layout and one remembered view per channel, on every market. */
        layoutSurface: `product-edit:layout:${channel.toUpperCase()}`,
        legacyLayoutSurface: `product-edit:layout:${channel.toUpperCase()}:${marketplace.toUpperCase()}`,
        productType: data ? data.family?.productType ?? null : undefined,
        grid: {
            surface: surfaceKey,
            viewsSurface: `product-edit:views:${channel.toUpperCase()}`,
            baseUrl: getBackendUrl(),
            getPageState: () => null,
            applyPageState: () => { },
        },
    });
    const { onGridReady, onGridPreDestroyed } = useSheetGridBindings({ apiRef, sheetColumns, bindGridApi, releaseGrid, clearRows: () => setSelected([]) });
    /**
     * LX.13 — the same ONE builder the master host uses (`sheet/compareTargets.ts`): every language of
     * the field (source first) on the shared record, then the coordinates. The old list was
     * `[Shared, this coordinate]`, so a translator could not see the German beside the Dutch without
     * changing scope — and the `Shared` entry carried no market, which `useCompare` then had to
     * back-fill from the open drawer.
     *
     * The coordinate rows are this scope's own listing today; the full "every coordinate carrying it"
     * list needs the family's listing inventory, which arrives with the per-coordinate readiness
     * columns (LX.15, deferred to VT.2's file).
     */
    editorContextLive.current = (row, key) => data ? {
        history: historyLoaderFor(row, key, { kind: 'channel', channel: data.scope.channel, marketplace, accountId: accountId ?? undefined, aliasId: row.aliasId ?? '', label: data.scope.label, locale: data.scope.locale }),
        inherited: inheritedContextOf(row.values?.[key], from => from === row.id ? null : rows.find(candidate => candidate.id === from)?.sku),
    } : null;
    const compareTargets = useMemo<CompareTarget[]>(() => {
        if (!data || !accountId)
            return [];
        const aliasId = rows.find(row => row.rowId === record.rowId)?.aliasId ?? '';
        return buildCompareTargets({
            scope: { kind: 'channel', channel: data.scope.channel, marketplace, accountId, aliasId, label: data.scope.label, locale: data.scope.locale },
            languages: languageScope.options.locales.map(language => language.code),
            primaryLanguage: languageScope.primaryLanguage,
            coordinates: [{ channel: data.scope.channel, marketplace, accountId, ...(aliasId ? { aliasId } : {}), locale: data.scope.locale ?? locale ?? '' }],
            labels: { channel: channelLabel, language: languageLabel },
            masterLabel: 'Shared',
            masterMarket: marketplace,
        });
    }, [data, marketplace, accountId, rows, record.rowId, languageScope.options.locales, languageScope.primaryLanguage, locale]);
    const onExport = useCallback((mode: SheetExportMode) => {
        const api = getGridApi();
        if (!api || api.isDestroyed() || !data)
            return;
        try {
            const r = exportGridCsv<ChannelSheetRow>(api, `${data.family?.sku ?? 'channel'}-${channel}-${marketplace}-table`, {
                columns: mode === 'all' ? sheetColumns.orderedKeys : 'displayed',
                leading: [
                    { colId: '__sku', header: 'SKU', value: row => row.sku },
                    { colId: '__account', header: 'Account', value: () => accountId ?? 'Primary account' },
                    { colId: '__market', header: 'Marketplace', value: () => marketplace },
                    { colId: '__alias', header: 'Listing alias', value: row => row.aliasId ?? '' },
                ],
                narrowed: searchTerm.length > 0 || !!activeId,
            });
            setExportNote(`${r.rows} rows · ${r.columns} columns → ${r.fileName} · reference table`);
        }
        catch (e: unknown) {
            setExportNote(e instanceof GridExportRefused ? e.message : 'Could not build the file.');
        }
    }, [data, channel, marketplace, accountId, searchTerm, activeId, sheetColumns]);
    const { preferences, columnDialog, openCustomise, openNewView } = useSheetPreferences({ scope: 'channel', sheetColumns, getGridApi, bandWidthRef, bandDerivedRef, revealCell });
    const getDataPath = useCallback((d: ChannelSheetRow) => dataPathFor(d), []);
    const getRowId = useCallback((p: {
        data: ChannelSheetRow;
    }) => rowIdOf(p.data), []);
    const familyShowsAxesRef = useRef(familyShowsAxes);
    familyShowsAxesRef.current = familyShowsAxes;
    const menuItemsRef = useRef(menuItems);
    menuItemsRef.current = menuItems;
    const autoGroupColumnDef = useMemo<ColDef<ChannelSheetRow>>(() => ({
        colSpan: bandSpan,
        valueGetter: (p: ValueGetterParams<ChannelSheetRow>) => p.data?.sku ?? null,
        cellRenderer: (p: ICellRendererParams<ChannelSheetRow>) => {
            const row = p.data;
            if (!row)
                return null;
            if (row.rowKind === 'parent') {
                const alias = (dataRef.current?.aliases ?? []).find((a) => aliasKeyOf(a.id) === aliasKeyOf(row.aliasId));
                if (!alias)
                    return null;
                return <AliasBandCell {...p} summary={summariseAlias(rowsRef.current, alias)} aliasCount={(dataRef.current?.aliases ?? []).length} menuItems={menuItemsRef.current(row)}/>;
            }
            const axes = familyShowsAxesRef.current ? Object.values(row.axisValues ?? {}).filter(Boolean) : [];
            const axisTitle = Object.entries(row.axisValues ?? {}).map(([axis, value]) => `${axis}: ${value}`).join(' · ');
            return (<IdentityBand expand={<BandExpander node={p.node}/>} role={<ProductRoleChip product={row}/>} image={row.imageUrl} noImage={!row.imageUrl} photoCount={row.imageInherited ? undefined : row.photoCount} imageMark={row.imageInherited ? (<ProvenanceMark provenance="inherited" from="the family's picture — this variation has none of its own"/>) : null} sku={row.sku ? <SkuTag>{row.sku}</SkuTag> : null} secondary={axes.length > 0 ? axes.join(' · ') : null} secondaryTitle={axisTitle || undefined} menuItems={menuItemsRef.current(row)} menuLabel={`Actions for ${row.sku ?? row.rowId}`}/>);
        },
        headerTooltip: 'One group per listing alias; the child SKUs beneath it are shared by every alias',
        headerName: 'Product',
        colId: 'alias',
        pinned: 'left',
        lockPinned: true,
        lockPosition: 'left',
        width: bandWidthRef.current,
        suppressHeaderMenuButton: true,
        cellClass: 'nds-ag-cell',
    }), []);
    const shopifyClipboard = useMemo(() => shopifyGridTransfer(mediaClipboard, data?.columns ?? [], accountId ?? '', message => toast(message, 'info')), [mediaClipboard, data?.columns, accountId, toast]);
    const [adding, setAdding] = useState(false);
    const aliasCreationPending = useRef(false);
    useEffect(() => registerScopeChangeGuard(() => !aliasCreationPending.current), [registerScopeChangeGuard]);
    const [preflightAlias, setPreflightAlias] = useState<PreflightAlias | null>(null);
    const [reviewBusy, setReviewBusy] = useState(false);
    const nativeReviewRow = preflightAlias ? rows.find(row => row.aliasId === preflightAlias.id && row.shopify) : null;
    const reviewPath = nativeReviewRow?.shopify && accountId ? `/api/products/${encodeURIComponent(nativeReviewRow.shopify.productId)}/shopify-linked?${new URLSearchParams({ accountId, listingId: nativeReviewRow.shopify.listingId, market: 'GLOBAL', ...(locale ? { locale } : {}) })}` : null;
    const [addError, setAddError] = useState<string | null>(null);
    const onAddAlias = useCallback(async () => {
        if (aliasCreationPending.current)
            return;
        aliasCreationPending.current = true;
        setAdding(true);
        setAddError(null);
        const res = await addListingAlias({ productId, channel, marketplace, accountId });
        aliasCreationPending.current = false;
        setAdding(false);
        if (!res.ok) {
            setAddError(res.reason ?? 'Could not add a listing alias');
            return;
        }
        reload();
        if (selectedAlias !== null)
            setListing(undefined);
        toast('Listing alias created as a Nexus draft.', 'success');
    }, [productId, channel, marketplace, accountId, reload, selectedAlias, setListing, toast]);
    const overflowItems = useMemo<MenuItemDef[]>(() => {
        const items: MenuItemDef[] = (data?.aliases ?? []).map((a) => {
            const n = variantRowsOf(rows, a.id).length;
            const mark = aliasMark(a.position);
            const copy = reviewCopy(accountId && rows.some(row => row.aliasId === a.id && row.shopify) ? 'synchronize' : 'check');
            if (n === 0)
                return { id: `preflight:${a.id}`, label: `${copy.menu} ${mark}`, disabled: true, description: `${mark} has no applicable rows to check` };
            return {
                id: `preflight:${a.id}`,
                label: `${copy.menu} ${mark} (${n})`,
                disabled: pending > 0 || refused > 0,
                description: copy.subtitle,
                onSelect: () => setPreflightAlias(a),
            };
        });
        items.push({
            id: 'add-alias',
            label: adding ? 'Adding…' : '+ Add listing alias',
            disabled: adding || pending > 0 || refused > 0 || !auth.has('products.edit'),
            ...(addError ? { description: addError } : {}),
            onSelect: () => void onAddAlias(),
        });
        items.unshift({
            id: 'cell-details', label: 'Cell details…', description: 'Select a cell to inspect its full value, source and validation.',
            onSelect: () => {
                const api = getGridApi(), focused = api?.getFocusedCell();
                const row = focused ? api?.getDisplayedRowAtIndex(focused.rowIndex)?.data : undefined;
                const column = data?.columns.find(col => col.key === focused?.column.getColId());
                if (row && column)
                    openCellDetails(row, column);
                else
                    toast('Select an attribute cell first, then open Cell details.', 'info');
            },
        });
        return items;
    }, [data, rows, adding, addError, onAddAlias, alternateAccount, channel, pending, refused, getGridApi, openCellDetails, toast, auth.has]);
    const unavailable = !loading && (backendMissing || !!error || !data);
    const emptyState = sheetEmptyState(rows.length, () => {
        setSearch('');
        setActive(null);
        setShowRefusedOnly(false);
        getGridApi()?.setFilterModel(null);
    }, reload);
    const unlisted = !!data?.aliases.length && data.aliases.every((a) => a.readiness?.state === 'unlisted');
    /* Create path, step 6 — what the family holds here, from the rows' own listings (and the drafts a save just
       started, `listingEpoch`). `none` on the primary listing: the first edit starts the draft, and the header says so —
       or, with no account to start it under, says the API's own refusal. `draft`: every listing here is still a Nexus
       draft by the shared rule (`isStillDraftListing`), and the chip says it is not published. */
    const listingState = useMemo(() => (data ? coordinateListingState(rows) : null), [data, rows, listingEpoch]);
    const startsDraftHere = listingState === 'none' && rows.some((row) => row.aliasId == null);
    const noAccount = !accountId && !data?.scope.connectionId && accounts.length === 0;
    return {
        scope: 'channel',
        loading, unavailable: unavailable,
        errorLabel: `${channelLabel(channel)} · ${marketplace} information`,
        errorMessage: error,
        backendMissing: backendMissing, retry: reload,
        columns: sheetColumns,
        toolbar: {
            pendingWrite: pending > 0 || saving,
            visible: visibleRows.length,
            total: rows.length,
            selected: selected.length,
            /* With no listing here, the alias count ("1 listing") counted the primary GROUP, not a listing — so it is left
               out, and the notice above the grid says what the first edit does. */
            descriptor: data && <span className="nds-cell-muted">
              {' · '}
              {listingState === 'none' || unlisted ? `${readinessMeta('unlisted', 'row').label} · ` : ''}
              {listingState === 'none' ? '' : `${data.aliases.length} ${data.aliases.length === 1 ? 'listing' : 'listings'} · `}
              {distinctVariantCount(rows)} variations
            </span>,
            search: search,
            onSearch: setSearch,
            onCustomise: openCustomise,
            onNewView: openNewView,
            onExport: () => { setTransferIntent('export'); setTransferOpen(true); },
            exportCounts: { view: sheetColumns.visibleAttributeKeys().length, all: sheetColumns.orderedKeys.length },
            exportDisabled: !data || loading || destination.status !== 'ready' || !auth.has('products.export'),
            exportPurpose: "workbook",
            onReload: onReload,
            onImport: () => { setTransferIntent('import'); setTransferOpen(true); },
            importDisabled: !data || loading || destination.status !== 'ready' || !auth.has('products.import'),
            loading: loading,
            unavailable: unavailable,
            overflow: [liveRead.menuItem, { id: 'refresh-progress', label: refreshProgressItem(refreshProgress, progressReadAt).name, description: `Read the progress bars of ${data?.scope.label ?? 'this scope'} again`, disabled: !data, onSelect: refreshProgress }, { id: 'requirements', label: data ? `${rulesStatus(channel, marketplace, data.meta.schemaMissing).label}…` : 'Requirements…', disabled: !data, description: 'Inspect the requirements for this category and marketplace.', onSelect: () => setRequirementsOpen(true) }, ...overflowItems, { id: 'formula-history', label: 'Formula history…', disabled: selectedAlias == null && new Set(selected.map(row => row.aliasId ?? '')).size !== 1, description: 'Select rows from one listing to inspect its formula history.', onSelect: () => setFormulaHistoryOpen(true) }, { id: 'bulk-formula', label: 'Apply formula to selected products…', disabled: !selected.length || !formulas.ready || new Set(selected.map(row => row.aliasId ?? '')).size !== 1, onSelect: () => setBulkFormulaRows(selected.map(row => ({ id: row.id, label: row.sku ?? row.id, rowId: row.rowId, aliasKey: row.aliasId ?? '' })).sort((a, b) => Number(a.id === productId) - Number(b.id === productId))) }],
            // 2026-09-27 — one wording for the chip, the dialog and the empty grid (`rulesStatus`).
            status: data ? [
                ...(listingState === 'draft' ? [{ tone: 'info' as const, label: DRAFT_CHIP_LABEL, detail: draftChipDetail(channel, marketplace) }] : []),
                (({ tone, label, detail }) => ({ tone, label, detail }))(rulesStatus(channel, marketplace, data.meta.schemaMissing)),
            ] : [],
        },
        toolbarExtra: <>    {liveRead.element}{pendingMasterWrite && (() => {
                const pm = pendingMasterWrite;
                const choices = pm.row.values[pm.colId]?.contentAcknowledgement;
                const accept = (address?: import('@nexus/shared/content-language').ContentAddress) => {
                    if (address) {
                        const cell = pm.row.values[pm.colId];
                        pm.row.values = { ...pm.row.values, [pm.colId]: { ...cell, contentAddress: address, contentAcknowledged: true } };
                    }
                    else
                        acknowledgedRef.current = true;
                    setPendingMasterWrite(null);
                    onCellValueChanged({ data: pm.row, colDef: { colId: pm.colId }, newValue: pm.value, oldValue: pm.previous, source: 'edit' });
                };
                const decline = () => {
                    setPendingMasterWrite(null);
                    revertingRef.current = true;
                    try {
                        revertPendingEdit(pm);
                        const oneCell = slotListKeyOfSlot(pm.colId, data?.columns ?? []);
                        getGridApi()?.refreshCells({ force: true, columns: oneCell ? [pm.colId, oneCell] : [pm.colId] });
                        const node = getGridApi()?.getRowNode(pm.rowId);
                        if (node?.rowIndex != null)
                            getGridApi()?.setFocusedCell(node.rowIndex, pm.colId);
                    }
                    finally {
                        revertingRef.current = false;
                    }
                };
                /**
                 * LX.14 — the acknowledgement, worded for the TIER, with both answers on it and the
                 * reach NAMED (design §8 LX.14; copy from the mock's S3,
                 * `/design/language-axis`). The old wording ("Choose where to save this text ·
                 * Shared text reaches …") named neither the language nor what declining does, so
                 * the operator could not tell a shared-language write from a coordinate pin without
                 * reading the two button labels.
                 *
                 * Every part is DERIVED: the language from the cell's own requested language through
                 * the ONE web label helper (`_studio/scopes.ts#languageLabel`), the reach and both
                 * button labels from the server's `contentAcknowledgement` — no local language map,
                 * no second copy of the reach sentence.
                 */
                const cell = pm.row.values[pm.colId];
                const fieldLabel = data?.columns.find(column => column.key === pm.colId)?.label ?? pm.colId;
                const language = languageLabel(cell?.requested ?? cell?.language ?? data?.scope.locale ?? '');
                // "a, b and c" — a bare `join(', ')` read as one destination when the reach is two.
                const reach = choices?.reach.length
                    ? choices.reach.length > 1 ? `${choices.reach.slice(0, -1).join(', ')} and ${choices.reach[choices.reach.length - 1]}` : choices.reach[0]
                    : data?.scope.label ?? '';
                return <Banner tone="warning" title={choices ? `${fieldLabel} follows the shared ${language} text` : `${fieldLabel} changes the shared product`} action={<div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--nds-space-2)' }}>
                    <Button autoFocus variant="primary" size="sm" onClick={() => accept(choices?.shared.address)}>{choices?.shared.label ?? 'Save to all channels'}</Button>
                    {choices && <Button variant="secondary" size="sm" onClick={() => accept(choices.pin.address)}>{choices.pin.label}</Button>}
                    <Button variant="secondary" size="sm" onClick={decline}>Cancel</Button>
                  </div>}>
                  {choices
                    ? `Editing it here changes ${language} on every listing that follows it: ${reach}. Pin it on this listing to change only this listing. Declining reverts the cell.`
                    : 'Every channel that follows this field receives the change. Declining reverts the cell.'}
                  {pendingWrites.length > 1 && ` ${pendingWrites.length} edits await a choice.`}
                </Banner>;
            })()}</>,
        status: {
            rows: visibleRows.length,
            /* The selection is counted ONCE, on the toolbar, not again here (SHEET-VIEWS, 2026-09-26). */
            pending: pending,
            saving: saving,
            refused: refused,
            lastSavedAt: lastSavedAt,
        }, footerNote: {
            offline: offline,
            layoutRecovery: sheetColumns.loadError ? { retry: sheetColumns.reloadSavedPreferences } : null,
            refused: refused,
            showRefusedOnly: showRefusedOnly,
            onToggleRefused: () => setShowRefusedOnly((v) => !v),
            lastSavedAt: lastSavedAt,
        }, footerExtra: exportNote ? <span className="nds-cell-sub">{exportNote}</span> : null, footerBefore: null, footerLead: <>    {data && crossChannelCols > 0 && (<span className="nds-cell-muted cs-cross-channel-note" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${crossChannelCols} of ${data.columns.length} columns write the shared master record — every channel sees those edits`}>
              {crossChannelCols} of {data.columns.length} columns write the shared master record — every channel sees those edits
            </span>)}</>,
        notice: startsDraftHere
            ? <Banner tone={noAccount ? 'warning' : 'info'}>{noAccount ? connectAccountSentence(channel, marketplace) : notListedSentence(channel, marketplace)}</Banner>
            : null,
        grid: {
            loading: loading,
            noRowsOverlayComponentParams: emptyState,
            ...shopifyClipboard,
            rowData: visibleRows,
            columnDefs: allColumnDefs,
            getDataPath: getDataPath,
            getRowId: getRowId,
            autoGroupColumnDef: autoGroupColumnDef,
            groupDefaultExpanded: 1,
            onGridReady: onGridReady,
            onGridPreDestroyed: onGridPreDestroyed,
            initialState: sheetColumns.initialState,
            onCellValueChanged: onCellValueChanged,
            rowSelection: rowSelection,
            onSelectionChanged: onSelectionChanged,
            onCellFocused: onCellFocused,
            onCellDoubleClicked: onCellDoubleClicked,
            onCellKeyDown: onCellKeyDown,
            getContextMenuItems: contextMenu,
            columnDialog: columnDialog,
        },
        gridOverlay: <>    {!loading && data && data.meta.schemaMissing.length > 0 && sheetColumns.landed && sheetColumns.visibleAttributeKeys().length === 0 && (<div className="cs-contract-empty" style={{ left: bandWidth }} role="status">
          <EmptyState title={rulesStatus(channel, marketplace, data.meta.schemaMissing).label} description={rulesStatus(channel, marketplace, data.meta.schemaMissing).detail}/>
        </div>)}</>,
        drawer: data && !unavailable ? {
            resolveRow: (id) => rows.find((r) => r.rowId === id) ?? null,
            onRevealCell: revealCell,
            columns: data.columns,
            scope: { kind: 'channel', accountId, aliasId: rows.find(r => r.rowId === record.rowId)?.aliasId ?? '', channel: data.scope.channel, marketplace: data.scope.marketplace, label: data.scope.label, locale: data.scope.locale },
            compareTargets: compareTargets,
            loading: loading,
            error: error,
            rowActions: verbs,
            onWrite: async () => ({ state: 'refused' as const, message: DRAWER_READ_ONLY }),
            writesRefused: DRAWER_READ_ONLY,
            formulas: { ...formulas,
                exprFor: (id, key) => formulas.exprFor(record.rowId ?? id, key),
            },
        } : null,
        preferences: !unavailable ? preferences : null,
        before: null, beforePreferences: <>{data && <>
              <SchemaStatus open={requirementsOpen} onClose={() => setRequirementsOpen(false)} channel={channel} market={marketplace} accountId={accountId} categories={[...new Set(rows.map(row => row.productType).filter((v): v is string => !!v))]} categorySources={Object.fromEntries([...new Set(rows.map(row => row.productType).filter((v): v is string => !!v))].map(type => [type, [...new Set(rows.filter(row => row.productType === type).map(row => row.categorySource?.label).filter((v): v is string => !!v))].join('; ')]))} typeConflicts={[...new Set(rows.flatMap(row => row.categorySource?.otherMarketConflicts ?? []))]} missing={data.meta.schemaMissing} downloadable={rulesStatus(channel, marketplace, data.meta.schemaMissing).downloadable} differences={(data.meta.coverage ?? []).flatMap(c => c.marketDifference ? [{ category: c.category, ...c.marketDifference }] : [])} ages={data.meta.schemaAge} onRefreshed={reload}/>
              
              {preflightAlias && (<Modal open onClose={() => {
                        if (!reviewBusy)
                            setPreflightAlias(null);
                    }} title={`${reviewCopy(reviewPath != null ? 'synchronize' : 'check').title} · ${data.scope.label} · ${aliasMark(preflightAlias.position)}`} subtitle={reviewCopy(reviewPath != null ? 'synchronize' : 'check').subtitle} size="lg">
                  <>{reviewPath ? <ShopifySheetReview key={reviewPath} path={reviewPath} schema={shopifySchema} onBusyChange={setReviewBusy} onChanged={() => void refresh(() => !tracker.hasUnconfirmedChanges)}/> : <AliasPublishControl alias={preflightAlias} rows={rows} channel={channel} marketplace={marketplace} autoRun/>}</>
                </Modal>)}
        </>}
        {confirmElement}
            {listResetConfirm.element}
            {reloadConfirm.element}</>, afterPreferences: <>
    {problem && <Banner tone="warning" onDismiss={clearProblem}>{problem}</Banner>}
    {/* 2026-09-24 — never a silent short sheet: while the store's field list is not available, say so. The sheet reloads
        itself when the list arrives (`schemaRevision`), and the metafield columns appear then. */}
    {channel === 'SHOPIFY' && data && !loading && data.meta.schemaMissing.includes(SHOPIFY_FIELDS_UNREAD) && <Banner tone="info" title="Loading this store's Shopify fields">
      Metafields and metaobject fields appear here as soon as Shopify answers. The sheet updates by itself.
    </Banner>}
    {formulaHistoryOpen && <FormulaHistoryDialog familyProductId={productId} coordinate={{ scope: 'channel', channel, marketplace, market: marketplace, locale: data?.scope.locale ?? locale ?? '', channelConnectionId: data?.scope.connectionId ?? accountId ?? undefined, aliasKey: selectedAlias ?? selected[0]?.aliasId ?? '' }} onClose={() => setFormulaHistoryOpen(false)} onApplied={() => { formulas.reload(); void refresh(() => true); }}/>}
    {bulkFormulaRows && data && <FormulaBulkDialog rows={bulkFormulaRows} columns={data.columns} coordinate={{ scope: 'channel', channel, marketplace, market: marketplace, locale: data?.scope.locale ?? locale ?? '', channelConnectionId: data?.scope.connectionId ?? accountId ?? undefined, aliasKey: bulkFormulaRows[0]?.aliasKey ?? '' }} functions={formulas.functions} preview={(id, key, expr, signal) => formulas.preview(bulkFormulaRows.find(row => row.id === id)!.rowId, key, expr, signal)} candidatesFor={(id, fieldKey) => { const row = rows.find(row => row.rowId === bulkFormulaRows.find(item => item.id === id)?.rowId); return row ? candidatesFor(row, fieldKey) : []; }} onClose={() => setBulkFormulaRows(null)} onApplied={() => { formulas.reload(); void refresh(() => true); }}/>}</>, after: <><SheetTransfer open={transferOpen} intent={transferIntent} onClose={() => setTransferOpen(false)} productId={productId} market={marketplace} channel={channel} accountId={accountId} aliasKey={selectedAlias} locale={locale} selectedIds={selected.map(row => row.id)} onReference={() => onExport('view')} visibleFields={expandSlotListKeys(sheetColumns.visibleAttributeKeys(), gridColumns).flatMap(key => { const c = data?.columns.find(c => c.key === key); return c ? [c.slot?.of ?? c.key, ...Object.values(c.channels ?? {}).flatMap(channel => [channel.key, channel.attribute])] : []; })} onApplied={() => { formulas.reload(); reload(); }}/>
        {mediaEditor.element}
        {shopifyEditor.element}
    {cellDetails && <Modal open readable size="md" title={cellDetails.title} onClose={closeCellDetails} footer={<><Button size="sm" onClick={closeCellDetails}>Close</Button>
          {cellDetails.action && <Button size="sm" variant="primary" onClick={() => { cellDetails.action?.run(); closeCellDetails(); }}>{cellDetails.action.label}</Button>}
        </>}>
        <div className="cs-cell-details">
          <p>{cellDetails.value}</p>
          <p>{cellDetails.notes}</p>
          {cellDetails.action && <p>{cellDetails.action.description}</p>}
        </div>
      </Modal>}</>,
    };
}
