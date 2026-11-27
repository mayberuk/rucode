import { resolveThreadActivityTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useGT } from "gt-react";

import { cn } from "~/lib/utils";
import { useNowMinute } from "../../hooks/useNowMinute";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { SidebarGroupStatus } from "../Sidebar.logic";

type IdleThread = Pick<EnvironmentThreadShell, "latestUserMessageAt" | "latestRun" | "updatedAt">;

const TONE_CLASS_NAME: Record<SidebarGroupStatus["kind"], string> = {
  "needs-you": "font-medium text-warning-foreground",
  failed: "font-medium text-error-foreground",
  working: "font-medium text-info-foreground",
  idle: "tabular-nums text-sidebar-muted-foreground",
};

// Matches the thread row's compact age, so a group and its first row read the same.
function compactAge(label: string): string {
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

/**
 * The words a collapsed group shows for its status; for an idle group, the age of `idleThread`.
 * Null when there is nothing to say.
 */
export function useSidebarGroupStatusLabel(
  status: SidebarGroupStatus | null,
  idleThread: IdleThread | null,
): string | null {
  const gt = useGT();
  const nowMinute = useNowMinute();
  if (status === null) return null;
  switch (status.kind) {
    case "needs-you":
      return gt("{count, plural, one {Needs you} other {# need you}}", { count: status.count });
    case "failed":
      return gt("{count} failed", { count: status.count });
    case "working":
      return gt("{count} working", { count: status.count });
    case "idle": {
      const timestamp = idleThread === null ? null : resolveThreadActivityTimestamp(idleThread);
      if (timestamp === null) return null;
      const label = formatRelativeTimeLabel(timestamp, Date.parse(`${nowMinute}:00.000Z`));
      return label === "" ? null : compactAge(label);
    }
  }
}

export function SidebarGroupStatusText(props: {
  status: SidebarGroupStatus;
  label: string;
  className?: string;
}) {
  return (
    <span className={cn("shrink-0 text-xs", TONE_CLASS_NAME[props.status.kind], props.className)}>
      {props.label}
    </span>
  );
}
