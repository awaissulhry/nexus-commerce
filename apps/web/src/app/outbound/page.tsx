import PageHeader from "@/components/layout/PageHeader";
import SyncStats from "@/components/outbound/SyncStats";
import SyncQueueTable from "@/components/outbound/SyncQueueTable";
import AutopilotIndicator from "@/components/outbound/AutopilotIndicator";
import { prisma } from "@nexus/database";

async function getOutboundData() {
  try {
    // Fetch queue items from database
    const queueItems = await prisma.outboundSyncQueue.findMany({
      where: {
        syncStatus: {
          in: ["PENDING", "IN_PROGRESS", "SUCCESS", "FAILED", "SKIPPED"],
        },
      },
      select: {
        id: true,
        productId: true,
        targetChannel: true,
        syncStatus: true,
        syncType: true,
        retryCount: true,
        nextRetryAt: true,
        createdAt: true,
        holdUntil: true,
        product: {
          select: {
            id: true,
            sku: true,
            name: true,
            basePrice: true,
            totalStock: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 100,
    });

    // Calculate stats from queue items
    const stats = {
      queued: queueItems.filter((q) => q.syncStatus === "PENDING").length,
      processed: queueItems.filter((q) => q.syncStatus === "IN_PROGRESS").length,
      succeeded: queueItems.filter((q) => q.syncStatus === "SUCCESS").length,
      failed: queueItems.filter((q) => q.syncStatus === "FAILED").length,
      queueStatus: {
        PENDING: queueItems.filter((q) => q.syncStatus === "PENDING").length,
        IN_PROGRESS: queueItems.filter((q) => q.syncStatus === "IN_PROGRESS").length,
        SUCCESS: queueItems.filter((q) => q.syncStatus === "SUCCESS").length,
        FAILED: queueItems.filter((q) => q.syncStatus === "FAILED").length,
        SKIPPED: queueItems.filter((q) => q.syncStatus === "SKIPPED").length,
      },
      queueByChannel: queueItems.reduce(
        (acc, item) => {
          const channel = item.targetChannel;
          if (!acc[channel]) {
            acc[channel] = 0;
          }
          acc[channel]++;
          return acc;
        },
        {} as Record<string, number>
      ),
      totalQueued: queueItems.length,
    };

    return {
      stats,
      queueItems: queueItems.map((item) => ({
        id: item.id,
        productId: item.productId || "",
        targetChannel: item.targetChannel,
        syncStatus: item.syncStatus,
        syncType: item.syncType,
        retryCount: item.retryCount,
        nextRetryAt: item.nextRetryAt?.toISOString() || null,
        createdAt: item.createdAt.toISOString(),
        holdUntil: item.holdUntil?.toISOString() || null,
        product: item.product
          ? {
              id: item.product.id,
              sku: item.product.sku,
              name: item.product.name,
              basePrice: Number(item.product.basePrice),
              totalStock: item.product.totalStock,
            }
          : {
              id: "",
              sku: "",
              name: "Unknown",
              basePrice: 0,
              totalStock: 0,
            },
      })),
    };
  } catch (error) {
    console.error("Error fetching outbound data:", error);
    return {
      stats: {
        queued: 0,
        processed: 0,
        succeeded: 0,
        failed: 0,
        queueStatus: {
          PENDING: 0,
          IN_PROGRESS: 0,
          SUCCESS: 0,
          FAILED: 0,
          SKIPPED: 0,
        },
        queueByChannel: {},
        totalQueued: 0,
      },
      queueItems: [],
    };
  }
}

export default async function OutboundPage() {
  const { stats, queueItems } = await getOutboundData();

  return (
    <div>
      <PageHeader
        title="Outbound Sync Dashboard"
        breadcrumbs={[
          { label: "Dashboard", href: "/" },
          { label: "Outbound Sync", href: "/outbound" },
        ]}
      />

      <div className="space-y-6 p-6">
        {/* Autopilot Status Indicator */}
        <AutopilotIndicator />

        {/* Statistics Cards */}
        <SyncStats stats={stats} />

        {/* Queue Table */}
        <SyncQueueTable initialItems={queueItems} />
      </div>
    </div>
  );
}
