import { prisma } from "@nexus/database";
import { revalidatePath } from "next/cache";
import SyncLogDetails from "@/app/logs/SyncLogDetails";
import PageHeader from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

async function refreshLogs() {
  "use server";
  revalidatePath("/engine/logs");
}

export default async function EngineSyncLogsPage() {
  const syncLogs = await prisma.marketplaceSync.findMany({
    include: {
      product: true,
    },
    orderBy: {
      lastSyncAt: "desc",
    },
  });

  const formatDate = (date: Date) => {
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(date));
  };

  const getStatusBadge = (status: string) => {
    const normalized = status.toUpperCase();
    if (normalized === "SUCCESS") {
      return (
        <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-800">
          ✓ Success
        </span>
      );
    }
    if (normalized === "FAILED") {
      return (
        <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-800">
          ✗ Failed
        </span>
      );
    }
    return (
      <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-800">
        ⏳ Pending
      </span>
    );
  };

  const getChannelBadge = (channel: string) => {
    if (channel === "AMAZON") {
      return (
        <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-orange-100 text-orange-800">
          🛒 Amazon
        </span>
      );
    }
    if (channel === "EBAY") {
      return (
        <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-800">
          🏷️ eBay
        </span>
      );
    }
    return (
      <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-800">
        {channel}
      </span>
    );
  };

  return (
    <div>
      <PageHeader
        title="Sync Logs"
        subtitle="Track marketplace synchronization status across all channels."
        breadcrumbs={[
          { label: "Nexus Engine", href: "/engine/logs" },
          { label: "Sync Logs" },
        ]}
        actions={
          <form action={refreshLogs}>
            <button
              type="submit"
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
            >
              🔄 Refresh
            </button>
          </form>
        }
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-600">Total Syncs</p>
          <p className="text-2xl font-bold text-gray-900">{syncLogs.length}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-600">Successful</p>
          <p className="text-2xl font-bold text-green-600">
            {syncLogs.filter((l: any) => l.lastSyncStatus.toUpperCase() === "SUCCESS").length}
          </p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-600">Failed</p>
          <p className="text-2xl font-bold text-red-600">
            {syncLogs.filter((l: any) => l.lastSyncStatus.toUpperCase() === "FAILED").length}
          </p>
        </div>
      </div>

      {syncLogs.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-12 text-center">
          <p className="text-gray-600 text-lg mb-2">No sync logs yet</p>
          <p className="text-gray-500 text-sm">
            Sync logs will appear here once the Amazon → eBay sync engine runs.
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Product
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Channel
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Last Sync
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Details
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {syncLogs.map((log: any) => (
                <tr key={log.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4 text-sm text-gray-900">
                    <div>
                      <p className="font-medium">{log.product.name}</p>
                      <p className="text-xs text-gray-500">
                        SKU: {log.product.sku}
                      </p>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-sm">
                    {getChannelBadge(log.channel)}
                  </td>
                  <td className="px-6 py-4 text-sm">
                    {getStatusBadge(log.lastSyncStatus)}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {formatDate(log.lastSyncAt)}
                  </td>
                  <td className="px-6 py-4 text-sm">
                    <SyncLogDetails
                      syncId={log.id}
                      status={log.lastSyncStatus}
                      channel={log.channel}
                      productSku={log.product.sku}
                      ebayItemId={log.product.ebayItemId}
                      amazonAsin={log.product.amazonAsin}
                      lastSyncAt={log.lastSyncAt.toISOString()}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
