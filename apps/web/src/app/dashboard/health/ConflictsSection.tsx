'use client';

import { useState, useMemo } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  ColumnDef,
  SortingState,
  ColumnFiltersState,
} from '@tanstack/react-table';
import { UnresolvedConflict, apiClient } from '@/lib/api-client';

interface ConflictsSectionProps {
  conflicts: UnresolvedConflict[];
  onConflictResolved: () => void;
}

function getSeverityColor(severity: string): string {
  switch (severity) {
    case 'CRITICAL':
      return 'bg-red-100 text-red-800';
    case 'ERROR':
      return 'bg-orange-100 text-orange-800';
    case 'WARNING':
      return 'bg-yellow-100 text-yellow-800';
    case 'INFO':
      return 'bg-blue-100 text-blue-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
}

function getSeverityIcon(severity: string): string {
  switch (severity) {
    case 'CRITICAL':
      return '🔴';
    case 'ERROR':
      return '🟠';
    case 'WARNING':
      return '🟡';
    case 'INFO':
      return '🔵';
    default:
      return '⚪';
  }
}

export default function ConflictsSection({
  conflicts,
  onConflictResolved,
}: ConflictsSectionProps) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'severity', desc: true },
  ]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [resolving, setResolving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleResolveConflict = async (conflictId: string) => {
    try {
      setResolving(conflictId);
      setError(null);
      await apiClient.resolveConflict(conflictId, {
        status: 'AUTO_RESOLVED',
        notes: 'Resolved from dashboard',
      });
      onConflictResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve conflict');
      console.error('Error resolving conflict:', err);
    } finally {
      setResolving(null);
    }
  };

  const columns = useMemo<ColumnDef<UnresolvedConflict>[]>(
    () => [
      {
        accessorKey: 'severity',
        header: 'Severity',
        cell: (info) => {
          const severity = info.getValue() as string;
          return (
            <div className="flex items-center gap-2">
              <span>{getSeverityIcon(severity)}</span>
              <span className={`px-2 py-1 rounded text-xs font-semibold ${getSeverityColor(severity)}`}>
                {severity}
              </span>
            </div>
          );
        },
      },
      {
        accessorKey: 'channel',
        header: 'Channel',
        cell: (info) => (
          <span className="font-medium text-gray-900">
            {(info.getValue() as string).charAt(0).toUpperCase() +
              (info.getValue() as string).slice(1)}
          </span>
        ),
      },
      {
        accessorKey: 'conflictType',
        header: 'Type',
        cell: (info) => {
          const type = info.getValue() as string | undefined;
          return type ? (
            <span className="text-sm text-gray-700">{type}</span>
          ) : (
            <span className="text-sm text-gray-500">-</span>
          );
        },
      },
      {
        accessorKey: 'message',
        header: 'Message',
        cell: (info) => (
          <span className="text-sm text-gray-700 max-w-xs truncate">
            {info.getValue() as string}
          </span>
        ),
      },
      {
        accessorKey: 'productId',
        header: 'Product ID',
        cell: (info) => {
          const id = info.getValue() as string | undefined;
          return id ? (
            <span className="text-sm font-mono text-gray-600">{id.slice(0, 8)}...</span>
          ) : (
            <span className="text-sm text-gray-500">-</span>
          );
        },
      },
      {
        accessorKey: 'createdAt',
        header: 'Created',
        cell: (info) => (
          <span className="text-sm text-gray-600">
            {new Date(info.getValue() as string).toLocaleString()}
          </span>
        ),
      },
      {
        id: 'actions',
        header: 'Action',
        cell: (info) => {
          const conflictId = info.row.original.id;
          const isResolving = resolving === conflictId;
          return (
            <button
              onClick={() => handleResolveConflict(conflictId)}
              disabled={isResolving}
              className="px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isResolving ? 'Resolving...' : 'Resolve'}
            </button>
          );
        },
      },
    ],
    [resolving]
  );

  const table = useReactTable({
    data: conflicts,
    columns,
    state: {
      sorting,
      columnFilters,
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
      <h2 className="text-xl font-bold text-gray-900 mb-6">Actionable Conflicts</h2>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded">
          <p className="text-red-800 text-sm">{error}</p>
        </div>
      )}

      {conflicts.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 text-lg">✓ No unresolved conflicts</p>
          <p className="text-gray-400 text-sm mt-1">All marketplace syncs are healthy</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                {table.getHeaderGroups().map((headerGroup) =>
                  headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      className="px-4 py-3 text-left text-sm font-semibold text-gray-900"
                    >
                      {header.isPlaceholder ? null : (
                        <div
                          {...{
                            className: header.column.getCanSort()
                              ? 'cursor-pointer select-none flex items-center gap-2'
                              : '',
                            onClick: header.column.getToggleSortingHandler(),
                          }}
                        >
                          {header.column.columnDef.header &&
                            typeof header.column.columnDef.header === 'string'
                            ? header.column.columnDef.header
                            : null}
                          {header.column.getCanSort() && (
                            <span className="text-xs">
                              {header.column.getIsSorted() === 'desc'
                                ? '↓'
                                : header.column.getIsSorted() === 'asc'
                                  ? '↑'
                                  : '⇅'}
                            </span>
                          )}
                        </div>
                      )}
                    </th>
                  ))
                )}
              </tr>
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr key={row.id} className="border-b border-gray-200 hover:bg-gray-50">
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-4 py-3">
                      {typeof cell.column.columnDef.cell === 'function'
                        ? cell.column.columnDef.cell(cell.getContext())
                        : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          {/* Pagination */}
          <div className="flex items-center justify-between mt-4 px-4 py-3 border-t border-gray-200">
            <div className="text-sm text-gray-600">
              Showing {table.getState().pagination.pageIndex * table.getState().pagination.pageSize + 1} to{' '}
              {Math.min(
                (table.getState().pagination.pageIndex + 1) * table.getState().pagination.pageSize,
                table.getFilteredRowModel().rows.length
              )}{' '}
              of {table.getFilteredRowModel().rows.length} conflicts
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
                className="px-3 py-1.5 border border-gray-300 rounded text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <button
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
                className="px-3 py-1.5 border border-gray-300 rounded text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
