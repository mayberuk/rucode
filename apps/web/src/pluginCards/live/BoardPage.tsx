import type { EnvironmentId } from "@t3tools/contracts";
import { Link, useSearch } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { LayoutDashboardIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "~/components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { SidebarInset } from "~/components/ui/sidebar";
import { isElectron } from "~/env";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useConnectedEnvironmentIds, useEnvironmentIdentities } from "~/state/environments";

import {
  BoardSkeleton,
  InitiativeBoard,
  InitiativeBoardUnavailable,
} from "./board/InitiativeBoard";
import { boardTarget } from "./board/board.logic";
import { useBoardInitiatives, useInitiativeBoard } from "./liveAtoms";
import { initiativeProgress, type BoardInitiative } from "./liveStateIndex";

function BoardFrame({
  title,
  children,
}: {
  readonly title?: string;
  readonly children: ReactNode;
}) {
  const gt = useGT();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="relative bg-background">
          <WorkspaceBreadcrumb ariaLabel={gt("Board breadcrumb")}>
            {title === undefined ? (
              <WorkspaceBreadcrumbItem current>
                <h1 className="truncate">{gt("Board")}</h1>
              </WorkspaceBreadcrumbItem>
            ) : (
              <>
                <WorkspaceBreadcrumbItem>
                  <Link
                    to="/board"
                    search={{}}
                    className="hover:text-foreground [-webkit-app-region:no-drag]"
                  >
                    {gt("Board")}
                  </Link>
                </WorkspaceBreadcrumbItem>
                <WorkspaceBreadcrumbSeparator />
                <WorkspaceBreadcrumbItem current>
                  <h1 className="truncate">{title}</h1>
                </WorkspaceBreadcrumbItem>
              </>
            )}
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width="readable" className="min-h-full gap-4">
            {children}
          </WorkspacePageContainer>
        </div>
      </div>
    </SidebarInset>
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

function InitiativeChooser({
  initiatives,
  showEnvironment,
}: {
  readonly initiatives: ReadonlyArray<BoardInitiative>;
  readonly showEnvironment: boolean;
}) {
  const gt = useGT();
  const environments = useEnvironmentIdentities();
  const labels = new Map(environments.map(({ environmentId, label }) => [environmentId, label]));
  return (
    <ul className="flex list-none flex-col">
      {initiatives.map(({ key, environmentId, initiative }) => {
        const { slug, title } = initiative;
        const { settled, total } = initiativeProgress(initiative).parts;
        return (
          <li key={key}>
            <Link
              to="/board"
              search={{ environmentId, slug }}
              className="flex h-9 items-center gap-2.5 rounded-md px-2.5 hover:bg-black/[0.035] dark:hover:bg-white/[0.08]"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">
                {title || slug}
              </span>
              {showEnvironment ? (
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {labels.get(environmentId) ?? environmentId}
                </span>
              ) : null}
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {gt("{settled} of {total, plural, one {# part} other {# parts}} settled", {
                  settled,
                  total,
                })}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function InitiativeBoardScreen({
  environmentId,
  slug,
}: {
  readonly environmentId: EnvironmentId;
  readonly slug: string;
}) {
  const view = useInitiativeBoard(environmentId, slug);
  const nowMinute = useNowMinute();
  return (
    <BoardFrame title={view.board?.title || slug}>
      <InitiativeBoard environmentId={environmentId} view={view} now={`${nowMinute}:00Z`} />
    </BoardFrame>
  );
}

export function BoardPage() {
  const gt = useGT();
  const search = useSearch({ from: "/_chat/board" });
  const connected = useConnectedEnvironmentIds();
  const { status, initiatives } = useBoardInitiatives(connected);
  const targets = initiatives.map(({ environmentId, initiative }) => ({
    environmentId,
    slug: initiative.slug,
  }));
  const target = boardTarget(search, targets, connected);

  if (status === "loading" && (search.slug === undefined || target.kind === "choose")) {
    return (
      <BoardFrame>
        <BoardSkeleton />
      </BoardFrame>
    );
  }
  switch (target.kind) {
    case "initiative":
      return (
        <InitiativeBoardScreen
          key={JSON.stringify([target.environmentId, target.slug])}
          environmentId={target.environmentId}
          slug={target.slug}
        />
      );
    case "disconnected":
      return (
        <BoardFrame>
          <BoardEmpty
            title={gt("This initiative's environment isn't connected")}
            description={gt("It opens when that environment reconnects.")}
          />
        </BoardFrame>
      );
    case "none":
      return (
        <BoardFrame>
          <BoardEmpty
            title={gt("No open initiatives")}
            description={gt("Initiatives started with dispatch appear here while they are open.")}
          />
        </BoardFrame>
      );
    case "choose": {
      const choices =
        search.slug === undefined
          ? initiatives
          : initiatives.filter(({ initiative }) => initiative.slug === search.slug);
      return (
        <BoardFrame>
          {choices.length === 0 ? (
            <InitiativeBoardUnavailable />
          ) : (
            <InitiativeChooser initiatives={choices} showEnvironment={connected.length > 1} />
          )}
        </BoardFrame>
      );
    }
  }
}
