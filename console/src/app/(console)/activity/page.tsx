import { PageHeader } from "@/components/page-header";
import { ActivityFeed } from "./activity-feed";

export default function ActivityPage() {
  return (
    <>
      <PageHeader
        title="Activity"
        description="Every bell, announcement, and change — when it happened, who asked for it, and the result."
      />
      <ActivityFeed />
    </>
  );
}
