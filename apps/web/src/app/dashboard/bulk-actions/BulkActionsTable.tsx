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
import { BulkActionJob, apiClient } from '@/lib/api-client';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import JobDetailsModal from './JobDetailsModal';

interface BulkActionsTableProps {
  jobs: BulkActionJob[];
  onJobCancelled: () => void;
  onJobRollback: () => void;
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'IN_PROGRESS':
      return 'bg-blue-100 text-blue-800';
    case 'COMPLETED':
      return 'bg-green-100 text-green-800';
    case 'FAILED':
      return 'bg-red-100 text-red-800';
    case 'PENDING':
      return 'bg-yellow-100 text-yellow-800';
    case 'QUEUED':
      return 'bg-purple-100 text-purple-800';
    case 'PARTIALLY_COMPLETED':
      return 'bg-orange-100 text-orange-800';
    case 'CANCELLED':
      return 'bg-gray-100 text-gray-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
}

function getStatusIcon(status: string): string {
  switch (status) {
    case 'IN_PROGRESS':
      return '⏳';
    case 'COMPLETED':
      return '✓';
    case 'FAILED':
      return '✕';
    case 'PENDING':
      return '⏸';
    case 'QUEUED':
      return '📋';
    case 'PARTIALLY_COMPLETED':
      return '⚠';
    case 'CANCELLED':
      return '⊘';
    default:
      return '•';
  }
}

function getActionTypeColor(type: string): string {
  switch (type) {
    case 'PRICING_UPDATE':
      return 'bg-blue-50 text-blue-700 border border-blue-200';
    case 'INVENTORY_UPDATE':
      return 'bg-green-50 text-green-700 border border-green-200';
    case 'STATUS_UPDATE':
      return 'bg-purple-50 text-purple-700 border border-purple-200';
    case 'ATTRIBUTE_UPDATE':
      return 'bg-orange-50 text-orange-700 border border-orange-200';
    case 'LISTING_SYNC':
      return 'bg-pink-50 text-pink-700 border border-pink-200';
    case 'MARKETPLACE_OVERRIDE_UPDATE':
      return 'bg-indigo-50 text-indigo-700 border border-indigo-200';
    default:
      return 'bg-gray-50 text-gray-700 border border-gray-200';
  }
}

export default function BulkActionsTable({
  jobs,
  onJobCancelled,
  onJobRollback,
}: BulkActionsTableProps) {
  const askConfirm = useConfirm();
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'createdAt', desc: true },
  ]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [selectedJob, setSelectedJob] = useState<BulkActionJob | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleCancelJob = async (jobId: string) => {
    if (!(await askConfirm({ title: 'Cancel this job?', confirmLabel: 'Cancel job', cancelLabel: 'Keep running', tone: 'warning' }))) return;

    try {
      setCancelling(jobId);
      setError(null);
      await apiClient.cancelBulkJob(jobId);
      onJobCancelled();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel job');
      console.error('Error cancelling job:', err);
    } finally {
      setCancelling(null);
    }
  };

  const columns = useMemo<ColumnDef<BulkActionJob>[]>(
    () => [
      {
        accessorKey: 'jobName',
        header: 'Job Name',
        cell: (info) => (
          <button
            onClick={() => setSelectedJob(info.row.original)}
            className="font-medium text-blue-600 hover:text-blue-700 hover:underline"
          >
            {info.getValue() as string}
          </button>
        ),
      },
      {
        accessorKey: 'actionType',
        header: 'Action Type',
        cell: (info) => {
          const type = info.getValue() as string;
          return (
            <span className={`px-2 py-1 rounded text-xs font-semibold ${getActionTypeColor(type)}`}>
              {type.replace(/_/g, ' ')}
            </span>
          );
        },
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: (info) => {
          const status = info.getValue() as string;
          return (
            <div className="flex items-center gap-2">
              <span>{getStatusIcon(status)}</span>
              <span className={`px-2 py-1 rounded text-xs font-semibold ${getStatusColor(status)}`}>
                {status}
              </span>
            </div>
          );
        },
      },
      {
        accessorKey: 'progressPercent',
        header: 'Progress',
        cell: (info) => {
          const progress = info.getValue() as number;
          return (
            <div className="w-full">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-gray-700">{progress}%</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-blue-600 h-2 rounded-full transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
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
        header: 'Actions',
        cell: (info) => {
          const job = info.row.original;
          const canCancel = job.status === 'PENDING' || job.status === 'IN_PROGRESS' || job.status === 'QUEUED';
          const isCancellingThis = cancelling === job.id;

          return (
            <div className="flex gap-2">
              <button
                onClick={() => setSelectedJob(job)}
                className="px-3 py-1.5 bg-gray-600 text-white text-sm font-medium rounded hover:bg-gray-700 transition-colors"
              >
                Details
              </button>
              {canCancel && (
                <button
                  onClick={() => handleCancelJob(job.id)}
                  disabled={isCancellingThis}
                  className="px-3 py-1.5 bg-red-600 text-white text-sm font-medium rounded hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isCancellingThis ? 'Cancelling...' : 'Cancel'}
                </button>
              )}
            </div>
          );
        },
      },
    ],
    [cancelling]
  );

  const table = useReactTable({
    data: jobs,
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
    <>
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded">
          <p className="text-red-800 text-sm">{error}</p>
        </div>
      )}

      {jobs.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
          <p className="text-gray-500 text-lg">No bulk action jobs</p>
          <p className="text-gray-400 text-sm mt-1">
            Create a bulk action job to get started
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
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
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
            <div className="text-sm text-gray-600">
              Showing {table.getState().pagination.pageIndex * table.getState().pagination.pageSize + 1} to{' '}
              {Math.min(
                (table.getState().pagination.pageIndex + 1) * table.getState().pagination.pageSize,
                table.getFilteredRowModel().rows.length
              )}{' '}
              of {table.getFilteredRowModel().rows.length} jobs
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

      {/* Job Details Modal */}
      {selectedJob && (
        <JobDetailsModal
          job={selectedJob}
          onClose={() => setSelectedJob(null)}
          onJobRollback={onJobRollback}
        />
      )}
    </>
  );
}
