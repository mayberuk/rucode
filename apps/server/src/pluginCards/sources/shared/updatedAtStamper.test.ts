import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { makeUpdatedAtStamper } from "./updatedAtStamper.ts";

const T0 = "1970-01-01T00:00:00.000Z";
const T5 = "1970-01-01T00:00:05.000Z";
const T9 = "1970-01-01T00:00:09.000Z";

it.effect(
  "keeps the first time while the data is unchanged and stamps the new time on change",
  () =>
    Effect.gen(function* () {
      const stamp = yield* makeUpdatedAtStamper;
      expect(yield* stamp("card", { phases: [1, 2] })).toBe(T0);

      yield* TestClock.adjust("5 seconds");
      expect(yield* stamp("card", { phases: [1, 2] })).toBe(T0);
      expect(yield* stamp("card", { phases: [1, 2, 3] })).toBe(T5);

      yield* TestClock.adjust("4 seconds");
      expect(yield* stamp("card", { phases: [1, 2, 3] })).toBe(T5);
      expect(yield* stamp("card", { phases: [1, 2] })).toBe(T9);
    }),
);

it.effect("tracks each key separately", () =>
  Effect.gen(function* () {
    const stamp = yield* makeUpdatedAtStamper;
    expect(yield* stamp("a", { n: 1 })).toBe(T0);
    yield* TestClock.adjust("5 seconds");
    expect(yield* stamp("b", { n: 1 })).toBe(T5);
    expect(yield* stamp("a", { n: 1 })).toBe(T0);
  }),
);

it.effect("does not share state between stampers", () =>
  Effect.gen(function* () {
    const first = yield* makeUpdatedAtStamper;
    const second = yield* makeUpdatedAtStamper;
    yield* first("card", { n: 1 });
    yield* TestClock.adjust("5 seconds");
    expect(yield* second("card", { n: 1 })).toBe(T5);
  }),
);
