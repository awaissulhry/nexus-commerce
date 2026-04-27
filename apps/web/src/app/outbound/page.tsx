import { prisma } from "@nexus/database";
import PageHeader from "@/components/layout/PageHeader";
import SyncStats from "@/components/outbound/SyncStats";
import SyncQueueTable from "@/components/outbound/SyncQueueTable";
import AutopilotIndicator from "@/components/outbound/AutopilotIndicator";

async function getOutboundData() {
  try {
    // Fetch stats from API
    const statsResponse = await fetch("http://localhost:3001/api/outbound/stats", {
      cache: "no-store",
    });
    const statsData = await statsResponse.json();

    // Fetch queue items from API
    const queueResponse = await fetch(
      "http://localhost:3001/api/outbound/queue?limit=100",
      {
        cache: "no-store",
      }
    );
    const queueData = await queueResponse.json();

    return {
      stats: statsData.stats || {},
      queueItems: queueData.data || [],
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
