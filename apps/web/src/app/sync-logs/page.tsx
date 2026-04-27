import { prisma } from '@nexus/database';
import PageHeader from '@/components/layout/PageHeader';

export const dynamic = 'force-dynamic';

async function getSyncLogs() {
  try {
    const syncLogs = await prisma.syncLog.findMany({
      include: {
        product: {
          select: {
            id: true,
            sku: true,
            name: true,
            amazonAsin: true,
          },
        },
      },
      orderBy: {
        startedAt: 'desc',
      },
      take: 50,
    });

    return syncLogs;
  } catch (error) {
    console.error('Failed to fetch sync logs:', error);
    return [];
  }
}

export default async function SyncLogsPage() {
  const syncLogs = await getSyncLogs();

  const formatDate = (date: Date) => {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(date));
  };

  const getStatusBadge = (status: string) => {
    const baseClasses = 'inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-semibold';
    switch (status.toUpperCase()) {
      case 'SUCCESS':
        return `${baseClasses} bg-green-100 text-green-800`;
      case 'IN_PROGRESS':
        return `${baseClasses} bg-blue-100 text-blue-800`;
      case 'FAILED':
        return `${baseClasses} bg-red-100 text-red-800`;
      case 'PENDING':
        return `${baseClasses} bg-yellow-100 text-yellow-800`;
      default:
        return `${baseClasses} bg-gray-100 text-gray-800`;
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status.toUpperCase()) {
      case 'SUCCESS':
        return '✓';
      case 'IN_PROGRESS':
        return '⟳';
      case 'FAILED':
        return '✕';
      case 'PENDING':
        return '⏳';
      default:
        return '○';
    }
  };

  const calculateDuration = (startedAt: Date, completedAt?: Date | null) => {
    const end = completedAt || new Date();
    const duration = end.getTime() - startedAt.getTime();
    if (duration < 1000) return `${duration}ms`;
    return `${(duration / 1000).toFixed(1)}s`;
  };

  const totalItems = syncLogs.reduce((sum, log) => sum + log.itemsProcessed, 0);
  const totalSuccessful = syncLogs.reduce((sum, log) => sum + log.itemsSuccessful, 0);
  const totalFailed = syncLogs.reduce((sum, log) => sum + log.itemsFailed, 0);

  return (
    <div>
      <PageHeader
        title="Amazon Sync Logs"
        subtitle="Monitor and track all Amazon catalog synchronization activities"
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-blue-500">
          <p className="text-sm text-gray-600">Total Syncs</p>
          <p className="text-3xl font-bold text-gray-900">{syncLogs.length}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-green-500">
          <p className="text-sm text-gray-600">Successful</p>
          <p className="text-3xl font-bold text-green-600">
            {syncLogs.filter((l) => l.status.toUpperCase() === 'SUCCESS').length}
          </p>
        </div>
        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-blue-500">
          <p className="text-sm text-gray-600">In Progress</p>
          <p className="text-3xl font-bold text-blue-600">
            {syncLogs.filter((l) => l.status.toUpperCase() === 'IN_PROGRESS').length}
          </p>
        </div>
        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-red-500">
          <p className="text-sm text-gray-600">Failed</p>
          <p className="text-3xl font-bold text-red-600">
            {syncLogs.filter((l) => l.status.toUpperCase() === 'FAILED').length}
          </p>
        </div>
      </div>

      {/* Items Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-600">Total Items Processed</p>
          <p className="text-2xl font-bold text-gray-900">{totalItems}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-600">Items Successful</p>
          <p className="text-2xl font-bold text-green-600">{totalSuccessful}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-600">Items Failed</p>
          <p className="text-2xl font-bold text-red-600">{totalFailed}</p>
        </div>
      </div>

      {/* Sync Logs Table */}
      {syncLogs.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-12 text-center">
          <svg
            className="w-16 h-16 text-gray-400 mx-auto mb-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <p className="text-gray-600 text-lg mb-2">No sync logs yet</p>
          <p className="text-gray-500 text-sm">
            Sync logs will appear here once you trigger an Amazon catalog sync from the inventory page.
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                  Product
                </th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                  Sync Type
                </th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                  Items
                </th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                  Success
                </th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                  Failed
                </th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                  Duration
                </th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                  Started
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {syncLogs.map((log) => (
                <tr key={log.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4 text-sm">
                    <div>
                      <p className="font-medium text-gray-900">{log.product.name}</p>
                      <p className="text-xs text-gray-500">SKU: {log.product.sku}</p>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    <span className="bg-gray-100 px-2 py-1 rounded text-xs font-medium">
                      {log.syncType}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm">
                    <span className={getStatusBadge(log.status)}>
                      <span>{getStatusIcon(log.status)}</span>
                      <span className="capitalize">{log.status}</span>
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm font-medium text-gray-900">
                    {log.itemsProcessed}
                  </td>
                  <td className="px-6 py-4 text-sm">
                    <span className="text-green-700 font-medium">{log.itemsSuccessful}</span>
                  </td>
                  <td className="px-6 py-4 text-sm">
                    <span className="text-red-700 font-medium">{log.itemsFailed}</span>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {calculateDuration(log.startedAt, log.completedAt)}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {formatDate(log.startedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Additional Info */}
      <div className="mt-8 bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-blue-900 mb-2">About Sync Logs</h3>
        <ul className="text-sm text-blue-800 space-y-1">
          <li>• <strong>SUCCESS:</strong> All items synced without errors</li>
          <li>• <strong>IN_PROGRESS:</strong> Sync operation is currently running</li>
          <li>• <strong>FAILED:</strong> Sync operation failed completely</li>
          <li>• <strong>PENDING:</strong> Sync is queued and waiting to start</li>
          <li>• Logs are retained for the last 50 sync operations</li>
          <li>• Check the error message for details on failed syncs</li>
        </ul>
      </div>
    </div>
  );
}
