import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useGT } from "gt-react";

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { Skeleton } from "~/components/ui/skeleton";

import type { InitiativeBoardView } from "../liveAtoms";
import { BoardHeader } from "./BoardHeader";
import { WaveGroup } from "./WaveGroup";
import { previousWave } from "./board.logic";

export function BoardSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy>
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} shape="card" className="h-8 w-full" />
      ))}
    </div>
  );
}

export function InitiativeBoardUnavailable() {
  const gt = useGT();
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{gt("Can't read this initiative right now")}</EmptyTitle>
        <EmptyDescription>{gt("The board refreshes when the server reconnects.")}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Link to="/board" search={{}} className="text-info-foreground hover:underline">
          {gt("All initiatives")}
        </Link>
      </EmptyContent>
    </Empty>
  );
}

export function InitiativeBoard({
  view,
  now,
}: {
  readonly environmentId: EnvironmentId;
  readonly view: InitiativeBoardView;
  readonly now: string;
}) {
  const gt = useGT();
  if (view.status === "loading") return <BoardSkeleton />;
  const { board } = view;
  if (board === null) return <InitiativeBoardUnavailable />;

  return (
    <div className="flex flex-col gap-6">
      <BoardHeader board={board} now={now} paused={view.status === "unavailable"} />
      {board.waves.length === 0 ? (
        <p className="text-xs text-muted-foreground">{gt("No parts yet")}</p>
      ) : (
        <div className="flex flex-col gap-4">
          {board.waves.map((wave) => (
            <WaveGroup
              key={wave.number}
              wave={wave}
              total={board.waves.length}
              previousName={previousWave(board, wave.number)?.name ?? null}
              now={now}
            />
          ))}
        </div>
      )}
    </div>
  );
}
