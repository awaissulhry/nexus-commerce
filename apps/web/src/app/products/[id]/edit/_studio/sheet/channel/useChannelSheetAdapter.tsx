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
import { formulaTransfer } from '@/design-system/grid';
import { SchemaStatus } from './SchemaStatus';
import { channelLabel, languageLabel } from '../../scopes';
import { buildCompareTargets } from '../compareTargets';
import { sheetEmptyState } from '../sheetGridStates';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { mediaGridTransfer } from '../../media/mediaGridTransfer';
import { useProductMediaEditor, withProductMediaColumn } from '../../media/productMediaColumn';
import { CellSaveTracker, CompletenessPill, IdentityBand, ProvenanceMark, SheetWriter, bandColSpan, type ColDef, type ICellRendererParams, type SheetWriteRequest, type ValueGetterParams, exprOf, isFormulaDraft, composeCellTooltip, longTextTooltipLine, shapeTooltipLine, type FormulaCandidate, type FormulaWiring } from '@/design-system/grid';
import { SkuTag } from '@/design-system/grid';
import { Button } from '@/design-system/primitives';
import { Banner, EmptyState, Modal, useToast, type MenuItemDef } from '@/design-system/components';
import { refusalWords } from '@/design-system/grid/editors/refusalWords';
import { AliasBandCell, BandExpander } from './AliasBandCell';
import { resetSourceLabel } from './value-source';
import { AliasPublishControl } from './AliasPublishControl';
import { useCellFormulas } from '../../useCellFormulas';
import { useActionConfirm } from '@/design-system/grid/actions/ActionConfirm';
import { wholeListWriteField } from './provenance';
import { rowReadinessPill, channelWriteIdentity, channelWriteGate, dataPathFor, withMappingRun, distinctVariantCount, isCellEditable, offersCascade, orderRows, rowIdOf, summariseAlias, withRowIdentity, cellHoverNote, crossChannelColumnCount, variantRowsOf } from './rows';
import { aliasMark, cascadeIntent, cascadeOf, type CascadeIntent } from './provenance';
import { studioAccountAccess } from '../../accountScope';
import type { AliasGroup as PreflightAlias } from './types';
import { mappingHref } from '@/app/channels/mapping/_shared/navigation';
import type { GetContextMenuItemsParams } from '@/design-system/grid';
import { addListingAlias, commitChannelRow, useChannelSheet } from './useChannelSheet';
import { useSaveReporter, useStudioRecord, useStudioScope, useViewChips } from '../../contracts';
import type { CompareTarget } from '../../drawer/types';
import { useAuth } from '@/lib/auth/AuthProvider';
import { ProductTransferDrawer } from '../../import/ProductTransferDrawer';
import { readinessMeta } from '@/design-system/grid/renderers/readiness';
import { getBackendUrl } from '@/lib/backend-url';
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
    refusalReason.current = (key, row) => {
        const col = data?.columns.find(column => column.key === key);
        if (!col)
            return null;
        const cell = row.values?.[key];
        if (isCellEditable(cell))
            return null;
        return cell?.writeBlockedReason || refusalWords(col.label || col.key, { kind: cell?.writable === false ? 'channel-not-writable' : col.editable === false ? 'column-read-only' : 'cell-locked' });
    };
    const { bandWidth, bandWidthRef, bandDerivedRef, revealCell } = useSheetGeometry({ scope: 'channel', rows, getGridApi, gridReady, recordId: record.rowId });
    const dataRef = useRef(data);
    dataRef.current = data;
    const rowsRef = useRef(rows);
    rowsRef.current = rows;
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
                const result = await commitChannelRow(req, { channel, marketplace, accountId, locale, kindOf: (colId) => dataRef.current?.columns?.find((c) => c.key === colId)?.kind });
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
                    void refreshRef.current(() => writerRef.current?.pending === 0 && !tracker.hasUnconfirmedChanges && (getGridApi()?.getEditingCells().length ?? 0) === 0);
                }
            },
            onSettled: ({ ok, savedAt }) => {
                if (!ok)
                    return;
                setLastSavedAt(savedAt);
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
    }, [writer, refused, rows, channel, marketplace, accountId, locale, writeInstanceId, reload, reloadConfirm.ask]);
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
    const setPendingMasterWrite = (next: PendingContentEdit | null) => setPendingWrites(prior => {
        if (!next)
            return prior.slice(1);
        const existing = prior.find(edit => edit.rowId === next.rowId && edit.colId === next.colId);
        return existing ? prior.map(edit => edit === existing ? { ...next, previous: existing.previous } : edit) : [...prior, next];
    });
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
    }) => {
        const colId = e.colDef.colId;
        if (!e.data || !colId)
            return;
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
    const bandSpan = useMemo(() => bandColSpan<ChannelSheetRow>({ isBand: (d) => d?.rowKind === 'parent' }), []);
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
    const gridColumns = useMemo(() => withProductMediaColumn(data?.columns ?? []).filter((col) => !RESERVED_COLUMN_IDS.includes(col.key as never)), [data]);
    const columnDefs = useMemo(() => buildSheetColumns('channel', {
        data, gridColumns, formulaWiring, accountId, openCellDetails, productLevelOnly,
        refusedReasonFor, tracker, activeCellsRef, viewCtx, mediaEditor, shopifyEditor, shopifySchema, auth,
    }), [data, gridColumns, formulaWiring, accountId, openCellDetails, productLevelOnly, refusedReasonFor,
        tracker, viewCtx, mediaEditor.open, mediaEditor.actions, shopifyEditor.open, shopifySchema, auth]);
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
    const schemaColumns = useMemo(() => gridColumns as never as StudioSheetColumn[], [gridColumns]);
    const prefsBridge = useMemo<PrefsBridgeOptions>(() => ({
        columns: [{ key: '__identity', locked: true }, ...gridColumns.map((c) => ({ key: c.key }))],
        treeColumnKey: '__identity',
    }), [gridColumns]);
    const sheetColumns = useSheetColumns<ChannelSheetRow, null>({
        apiRef,
        gridReady,
        columns: schemaColumns,
        languages: { selected: languageScope.locales, available: languageScope.options.locales.map(language => language.code), set: languageScope.setLocales },
        viewCtx,
        identityColumn: '__identity',
        prefsBridge,
        activeChip: active,
        setChip: setActive,
        layoutSurface: `product-edit:layout:${channel.toUpperCase()}:${marketplace.toUpperCase()}`,
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
    const { preferences, columnDialog, openCustomise } = useSheetPreferences({ scope: 'channel', sheetColumns, getGridApi, bandWidthRef, bandDerivedRef, revealCell });
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
            return (<IdentityBand expand={<BandExpander node={p.node}/>} role={<ProductRoleChip product={row}/>} image={row.imageUrl} noImage={!row.imageUrl} photoCount={row.imageInherited ? undefined : row.photoCount} imageMark={row.imageInherited ? (<ProvenanceMark provenance="inherited" from="the family's picture — this variation has none of its own"/>) : null} sku={row.sku ? <SkuTag>{row.sku}</SkuTag> : null} secondary={axes.length > 0 ? axes.join(' · ') : null} secondaryTitle={axisTitle || undefined} trailing={<CompletenessPill {...rowReadinessPill(row, dataRef.current?.aliases.find(alias => aliasKeyOf(alias.id) === aliasKeyOf(row.aliasId)))}/>} menuItems={menuItemsRef.current(row)} menuLabel={`Actions for ${row.sku ?? row.rowId}`}/>);
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
            descriptor: data && <span className="nds-cell-muted">
              {' · '}
              {unlisted ? `${readinessMeta('unlisted', 'row').label} · ` : ''}
              {data.aliases.length} {data.aliases.length === 1 ? 'listing' : 'listings'} ·{' '}
              {distinctVariantCount(rows)} variations
              
              
              
            </span>,
            search: search,
            onSearch: setSearch,
            onCustomise: openCustomise,
            onExport: () => { setTransferIntent('export'); setTransferOpen(true); },
            exportCounts: { view: sheetColumns.visibleAttributeKeys().length, all: sheetColumns.orderedKeys.length },
            exportDisabled: !data || loading || destination.status !== 'ready' || !auth.has('products.export'),
            exportPurpose: "workbook",
            onReload: onReload,
            onImport: () => { setTransferIntent('import'); setTransferOpen(true); },
            importDisabled: !data || loading || destination.status !== 'ready' || !auth.has('products.import'),
            loading: loading,
            unavailable: unavailable,
            overflow: [{ id: 'requirements', label: data?.meta.schemaMissing.length ? 'Requirements incomplete…' : 'Requirements…', disabled: !data, description: 'Inspect the requirements for this category and marketplace.', onSelect: () => setRequirementsOpen(true) }, ...overflowItems, { id: 'formula-history', label: 'Formula history…', disabled: selectedAlias == null && new Set(selected.map(row => row.aliasId ?? '')).size !== 1, description: 'Select rows from one listing to inspect its formula history.', onSelect: () => setFormulaHistoryOpen(true) }, { id: 'bulk-formula', label: 'Apply formula to selected products…', disabled: !selected.length || !formulas.ready || new Set(selected.map(row => row.aliasId ?? '')).size !== 1, onSelect: () => setBulkFormulaRows(selected.map(row => ({ id: row.id, label: row.sku ?? row.id, rowId: row.rowId, aliasKey: row.aliasId ?? '' })).sort((a, b) => Number(a.id === productId) - Number(b.id === productId))) }],
            status: data ? [{
                tone: data.meta.schemaMissing.length ? 'warning' : 'neutral',
                label: data.meta.schemaMissing.length ? 'Requirements incomplete' : 'Requirements',
                detail: data.meta.schemaMissing.length
                    ? `Incomplete: ${data.meta.schemaMissing.map(key => key === 'ETSY:*' ? 'Etsy category not selected' : key.replace(/^ETSY:/, 'Etsy category ')).join(', ')}. Readiness cannot be confirmed until these requirements are available.`
                    : 'Requirements depend on the listing category and marketplace. Refresh them after changing categories and before publishing.',
            }] : [],
        },
        toolbarExtra: <>    {pendingMasterWrite && (() => {
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
                        const cell = pm.row.values[pm.colId];
                        pm.row.values = { ...pm.row.values, [pm.colId]: { ...cell, value: pm.previous } };
                        getGridApi()?.refreshCells({ force: true, columns: [pm.colId] });
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
            selected: selected.length,
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
        notice: null,
        grid: {
            loading: loading,
            noRowsOverlayComponentParams: emptyState,
            ...shopifyClipboard,
            rowData: visibleRows,
            columnDefs: columnDefs,
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
          <EmptyState title="Requirements incomplete" description={`${channelLabel(channel)} · ${marketplace}: ${data.meta.schemaMissing.join(', ')} contract not loaded. Open Requirements incomplete, then choose Refresh requirements to load the category’s fields and readiness rules.`}/>
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
              <SchemaStatus open={requirementsOpen} onClose={() => setRequirementsOpen(false)} channel={channel} market={marketplace} accountId={accountId} categories={[...new Set(rows.map(row => row.productType).filter((v): v is string => !!v))]} missing={data.meta.schemaMissing} ages={data.meta.schemaAge} onRefreshed={reload}/>
              
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
    {formulaHistoryOpen && <FormulaHistoryDialog familyProductId={productId} coordinate={{ scope: 'channel', channel, marketplace, market: marketplace, locale: data?.scope.locale ?? locale ?? '', channelConnectionId: data?.scope.connectionId ?? accountId ?? undefined, aliasKey: selectedAlias ?? selected[0]?.aliasId ?? '' }} onClose={() => setFormulaHistoryOpen(false)} onApplied={() => { formulas.reload(); void refresh(() => true); }}/>}
    {bulkFormulaRows && data && <FormulaBulkDialog rows={bulkFormulaRows} columns={data.columns} coordinate={{ scope: 'channel', channel, marketplace, market: marketplace, locale: data?.scope.locale ?? locale ?? '', channelConnectionId: data?.scope.connectionId ?? accountId ?? undefined, aliasKey: bulkFormulaRows[0]?.aliasKey ?? '' }} functions={formulas.functions} preview={(id, key, expr, signal) => formulas.preview(bulkFormulaRows.find(row => row.id === id)!.rowId, key, expr, signal)} candidatesFor={(id, fieldKey) => { const row = rows.find(row => row.rowId === bulkFormulaRows.find(item => item.id === id)?.rowId); return row ? candidatesFor(row, fieldKey) : []; }} onClose={() => setBulkFormulaRows(null)} onApplied={() => { formulas.reload(); void refresh(() => true); }}/>}</>, after: <><ProductTransferDrawer open={transferOpen} intent={transferIntent} onClose={() => setTransferOpen(false)} productId={productId} market={marketplace} channel={channel} accountId={accountId} aliasKey={selectedAlias} locale={locale} selectedIds={selected.map(row => row.id)} onReference={() => onExport('view')} visibleFields={sheetColumns.visibleAttributeKeys().flatMap(key => { const c = data?.columns.find(c => c.key === key); return c ? [c.slot?.of ?? c.key, ...Object.values(c.channels ?? {}).flatMap(channel => [channel.key, channel.attribute])] : []; })} onApplied={() => { formulas.reload(); reload(); }}/>
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
