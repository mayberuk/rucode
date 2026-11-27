import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, Iter8Page, Iter8ReviewSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useGT } from "gt-react";

import { iter8ReviewAtomFamily } from "~/rpc/iter8";
import { type Iter8PageMatch, type Iter8RoundStatus, matchIter8Page } from "./iter8Review.logic";

export type Iter8ReviewStatus = "loading" | "unavailable" | "failed" | "ready";

export interface Iter8ReviewView {
  readonly status: Iter8ReviewStatus;
  readonly match: Iter8PageMatch | null;
  readonly snapshot: Iter8ReviewSnapshot | null;
  readonly retry: () => void;
}

interface ReviewState {
  readonly snapshot: Iter8ReviewSnapshot | null;
  readonly failed: boolean;
}

const reviewStateAtom = Atom.family((source: ReturnType<typeof iter8ReviewAtomFamily>) =>
  Atom.make((get): ReviewState => {
    const result = get(source);
    const kept = Option.getOrNull(get.self<ReviewState>())?.snapshot ?? null;
    return {
      snapshot: AsyncResult.getOrElse(result, () => kept),
      failed: result._tag === "Failure",
    };
  }),
);

/** A dropped or failed subscription keeps its last snapshot, so the dock does not flicker away. */
export function useIter8Review(environmentId: EnvironmentId, url: string | null): Iter8ReviewView {
  const source = iter8ReviewAtomFamily({ environmentId, input: {} });
  const { snapshot, failed } = useAtomValue(reviewStateAtom(source));
  const retry = useAtomRefresh(source);
  const status: Iter8ReviewStatus = failed
    ? "failed"
    : snapshot === null
      ? "loading"
      : snapshot.available
        ? "ready"
        : "unavailable";
  const match = snapshot?.available ? matchIter8Page(snapshot, url) : null;
  return { status, match, snapshot, retry };
}

function sentRounds(page: Iter8Page) {
  return page.rounds
    .filter((round) => round.stage !== "draft")
    .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** Rounds are numbered per page in creation order; drafts belong to the next one. */
function roundNumber(pages: ReadonlyArray<Iter8Page>, status: Iter8RoundStatus): number | null {
  if (status.kind === "none") return null;
  if (status.kind === "drafts") {
    return Math.max(0, ...pages.map((page) => sentRounds(page).length)) + 1;
  }
  for (const page of pages) {
    const index = sentRounds(page).findIndex((round) => round.id === status.roundId);
    if (index !== -1) return index + 1;
  }
  return null;
}

export function useIter8RoundLabel(): (
  pages: ReadonlyArray<Iter8Page>,
  status: Iter8RoundStatus,
) => string | null {
  const gt = useGT();
  return (pages, status) => {
    const round = roundNumber(pages, status);
    if (round === null) return null;
    switch (status.kind) {
      case "drafts":
        return gt("R{round} · {count, plural, one {# draft} other {# drafts}}", {
          round,
          count: status.count,
        });
      case "sent":
        return gt("R{round} sent", { round });
      case "resolved":
        return gt("R{round} resolved", { round });
      case "undelivered":
        return gt("R{round} not delivered", { round });
      case "none":
        return null;
    }
  };
}
