import type { EnvironmentId, PluginLiveInitiative } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { LayoutDashboardIcon } from "lucide-react";
import { useState } from "react";

import { UsageRow } from "~/components/chat/ThreadDetailsUsage";
import { Badge } from "~/components/ui/badge";
import { Collapsible, CollapsiblePanel } from "~/components/ui/collapsible";
import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { SidebarInset } from "~/components/ui/sidebar";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "~/components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { isElectron } from "~/env";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useConnectedEnvironmentIds, useEnvironments } from "~/state/environments";

import { useBoardInitiatives } from "./liveAtoms";
import { formatAsOf, type BoardInitiative } from "./liveStateIndex";

type Part = PluginLiveInitiative["parts"][number];

function partStatusVariant(status: string) {
  switch (status) {
    case "merged":
    case "gate-pass":
      return "success";
    case "gate-fail":
      return "error";
    case "mr-open":
      return "info";
    default:
      return "outline";
  }
}

function PartsTable({
  environmentId,
  parts,
}: {
  readonly environmentId: EnvironmentId;
  readonly parts: ReadonlyArray<Part>;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Part</TableHead>
          <TableHead>Wave</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Chats</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {parts.map((part) => (
          <TableRow key={part.id}>
            <TableCell>{part.title ?? part.id}</TableCell>
            <TableCell>{part.wave}</TableCell>
            <TableCell>
              <Badge variant={partStatusVariant(part.status)}>{part.status}</Badge>
            </TableCell>
            <TableCell>
              <span className="flex gap-2">
                {part.threadIds.map((threadId, index) => (
                  <Link
                    key={threadId}
                    to="/$environmentId/$threadId"
                    params={{ environmentId, threadId }}
                    title={threadId}
                    className="text-info-foreground underline-offset-4 hover:underline"
                  >
                    Chat {index + 1}
                  </Link>
                ))}
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function InitiativeSection({
  item,
  environmentLabel,
  now,
}: {
  readonly item: BoardInitiative;
  readonly environmentLabel: string | null;
  readonly now: string;
}) {
  const [open, setOpen] = useState(item.active);
  const { initiative } = item;
  const partsUnavailable = initiative.title === null && initiative.parts.length === 0;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleSectionHeader
        expanded={open}
        tone="emphasized"
        variant="panel"
        onClick={() => setOpen(!open)}
        accessory={
          <span className="shrink-0 text-3xs leading-none">{formatAsOf(initiative.asOf, now)}</span>
        }
      >
        {initiative.title ?? initiative.slug}
        {environmentLabel === null ? null : ` · ${environmentLabel}`}
      </CollapsibleSectionHeader>
      <CollapsiblePanel>
        <div className="flex flex-col gap-3 pt-2">
          <div className="grid max-w-md grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
            {item.metrics.map((metric) => (
              <UsageRow
                key={metric.label}
                label={metric.label}
                fill={metric.fill === null ? null : metric.fill * 100}
                tone={metric.tone}
                value={metric.value}
                tooltip={<span className="text-foreground">{metric.tooltip}</span>}
              />
            ))}
          </div>
          {partsUnavailable ? (
            <p className="px-2.5 text-xs text-muted-foreground">
              Part list unavailable (dp could not be read)
            </p>
          ) : initiative.parts.length === 0 ? (
            <p className="px-2.5 text-xs text-muted-foreground">No parts yet</p>
          ) : (
            <PartsTable environmentId={item.environmentId} parts={initiative.parts} />
          )}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function BoardEmpty({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <Empty>
      <EmptyMedia variant="icon">
        <LayoutDashboardIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function BoardBody() {
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const { environments } = useEnvironments();
  const board = useBoardInitiatives(connectedEnvironmentIds);
  const nowMinute = useNowMinute();
  const now = `${nowMinute}:00Z`;
  const labels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );

  if (board.status === "loading") {
    return (
      <div className="flex flex-col gap-3" aria-busy>
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} shape="card" className="h-8 w-full" />
        ))}
      </div>
    );
  }
  if (board.status === "unavailable") {
    return (
      <BoardEmpty
        title="Can't read initiatives right now"
        description="The board refreshes when the server reconnects."
      />
    );
  }
  if (board.initiatives.length === 0) {
    return (
      <BoardEmpty
        title="No open initiatives"
        description="Initiatives started with dispatch appear here while they are open."
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {board.initiatives.map((item) => (
        <InitiativeSection
          key={item.key}
          item={item}
          environmentLabel={
            connectedEnvironmentIds.length > 1 ? (labels.get(item.environmentId) ?? null) : null
          }
          now={now}
        />
      ))}
    </div>
  );
}

export function BoardPage() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="relative bg-background">
          <WorkspaceBreadcrumb ariaLabel="Board breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Board</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width="expanded" className="min-h-full gap-4">
            <BoardBody />
          </WorkspacePageContainer>
        </div>
      </div>
    </SidebarInset>
  );
}
