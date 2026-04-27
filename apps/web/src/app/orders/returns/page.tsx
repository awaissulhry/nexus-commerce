import { prisma } from "@nexus/database";
import PageHeader from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

export default async function ReturnsPage() {
  const returns = await (prisma as any)['return'].findMany({
    include: {
      order: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const formatDate = (date: Date) =>
    new Date(date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

  const formatCurrency = (amount: any) => {
    if (!amount) return "—";
    const num =
      typeof amount === "string"
        ? parseFloat(amount)
        : typeof amount === "number"
        ? amount
        : parseFloat(amount.toString());
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(num);
  };

  const statusStyles: Record<string, string> = {
    REQUESTED: "bg-yellow-100 text-yellow-800",
    APPROVED: "bg-blue-100 text-blue-800",
    RECEIVED: "bg-purple-100 text-purple-800",
    REFUNDED: "bg-green-100 text-green-800",
    DENIED: "bg-red-100 text-red-800",
  };

  return (
    <div>
      <PageHeader
        title="Manage Returns"
        subtitle={`${returns.length} return${returns.length !== 1 ? "s" : ""}`}
        breadcrumbs={[
          { label: "Orders", href: "/orders" },
          { label: "Returns" },
        ]}
      />

      {returns.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-12 text-center">
          <div className="text-5xl mb-4">↩️</div>
          <p className="text-lg font-medium text-gray-900 mb-2">
            No returns yet
          </p>
          <p className="text-sm text-gray-500">
            Return requests will appear here when customers initiate them.
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Return ID
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Order
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Reason
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Refund Amount
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                  Requested
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {returns.map((ret: any) => (
                <tr
                  key={ret.id}
                  className="hover:bg-gray-50 transition-colors"
                >
                  <td className="px-6 py-4 text-sm font-mono text-gray-900">
                    {ret.id.slice(0, 8)}...
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-900">
                    <div>
                      <p className="font-medium">
                        {ret.order?.amazonOrderId || ret.orderId.slice(0, 8)}
                      </p>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-700 max-w-xs truncate">
                    {ret.reason || "No reason provided"}
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        statusStyles[ret.status] || "bg-gray-100 text-gray-700"
                      }`}
                    >
                      {ret.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm font-semibold text-gray-900">
                    {formatCurrency(ret.refundAmount)}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {formatDate(ret.createdAt)}
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
