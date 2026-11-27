import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { useState } from "react";

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
import { NeedsYouGroup } from "./NeedsYouGroup";
import { PartSheet } from "./PartSheet";
import { WaveGroup } from "./WaveGroup";
import { partTitle, previousWave } from "./board.logic";

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
  environmentId,
  view,
  now,
}: {
  readonly environmentId: EnvironmentId;
  readonly view: InitiativeBoardView;
  readonly now: string;
}) {
  const gt = useGT();
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  const board = view.status === "loading" ? null : view.board;
  const selectedWave =
    selectedPartId === null
      ? undefined
      : board?.waves.find(({ parts }) => parts.some(({ id }) => id === selectedPartId));
  const selectedPart = selectedWave?.parts.find(({ id }) => id === selectedPartId);
  if (selectedPartId !== null && selectedPart === undefined) setSelectedPartId(null);

  if (view.status === "loading") return <BoardSkeleton />;
  if (board === null) return <InitiativeBoardUnavailable />;

  const paused = view.status === "unavailable";
  const needsYou = view.needsYou.map((item) => ({ ...item, part: partTitle(board, item.part) }));
  const open = needsYou.filter(({ cardId }) => !answered.has(cardId));

  return (
    <div className="flex flex-col gap-6">
      <BoardHeader
        board={board}
        decisions={{ count: open.length, oldestPart: open[0]?.part || null }}
        now={now}
        paused={paused}
      />
      <NeedsYouGroup
        environmentId={environmentId}
        items={needsYou}
        answered={answered}
        setAnswered={setAnswered}
        paused={paused}
        now={now}
      />
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
              onOpenPart={setSelectedPartId}
            />
          ))}
        </div>
      )}
      {selectedPart && selectedWave ? (
        <PartSheet
          part={selectedPart}
          wave={selectedWave}
          board={board}
          now={now}
          open
          onOpenChange={(open) => {
            if (!open) setSelectedPartId(null);
          }}
        />
      ) : null}
    </div>
  );
}
