import type { DispatchInitiativeState } from "./initiativeState.ts";

export interface InitiativeWavePlan {
  readonly total: number;
  readonly current: number;
  readonly displayOf: (dpWave: number) => number;
}

export const SETTLED_PART_STATUSES: ReadonlySet<string> = new Set([
  "gate-pass",
  "mr-open",
  "merged",
]);

export function planWaves(state: DispatchInitiativeState): InitiativeWavePlan {
  const numbers = [
    ...new Set([
      ...state.waves.map((wave) => wave.number),
      ...state.parts.map((part) => part.wave),
    ]),
  ].sort((left, right) => left - right);
  const total = numbers.length;
  const ranks = new Map(numbers.map((number, index) => [number, index + 1]));
  const displayOf = (dpWave: number) =>
    ranks.get(dpWave) ?? numbers.findLastIndex((number) => number < dpWave) + 2;

  const opened = state.waves.reduce(
    (highest, wave) =>
      wave.opened && !wave.closed ? Math.max(highest, displayOf(wave.number)) : highest,
    0,
  );
  const current =
    opened > 0
      ? opened
      : state.parts.reduce(
          (lowest, part) =>
            SETTLED_PART_STATUSES.has(part.status)
              ? lowest
              : Math.min(lowest, displayOf(part.wave)),
          total,
        );
  return { total, current, displayOf };
}

const MAX_LEAD_LENGTH = 48;

function leadPhrase(title: string): string {
  const lead = title.split(/:| — | \(|;/u, 1)[0]?.trim() ?? "";
  const characters = [...lead];
  if (characters.length <= MAX_LEAD_LENGTH) return lead;

  const prefix = characters.slice(0, MAX_LEAD_LENGTH).join("");
  const boundary = prefix.search(/\s+\S*$/u);
  const shortened =
    boundary > 0 ? prefix.slice(0, boundary) : characters.slice(0, MAX_LEAD_LENGTH - 1).join("");
  return `${shortened}…`;
}

export function waveName(titles: ReadonlyArray<string>): {
  readonly name: string;
  readonly moreParts: number;
} {
  return {
    name: titles.slice(0, 2).map(leadPhrase).join(" + "),
    moreParts: Math.max(0, titles.length - 2),
  };
}
