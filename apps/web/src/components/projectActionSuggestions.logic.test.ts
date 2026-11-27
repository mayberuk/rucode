import type { ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  scriptsAfterUndo,
  shouldAutoSuggest,
  suggestionNoticeFor,
  type ProjectActionSuggestionNotice,
  type ProjectActionSuggestOutcome,
} from "./projectActionSuggestions.logic";

const testScript = {
  id: "test",
  name: "Run Tests",
  command: "npm test",
  icon: "test",
  runOnWorktreeCreate: false,
  runOnSettle: false,
  stopOnSettle: false,
} satisfies ProjectScript;
const buildScript = {
  ...testScript,
  id: "build",
  name: "Build App",
  command: "npm run build",
  icon: "build",
} satisfies ProjectScript;
const lintScript = {
  ...testScript,
  id: "lint",
  name: "Run Lint",
  command: "npm run lint",
  icon: "lint",
} satisfies ProjectScript;

describe("shouldAutoSuggest", () => {
  describe.each([
    { scriptCount: 0, eligibleWithAllFlags: true },
    { scriptCount: 1, eligibleWithAllFlags: false },
  ])("with $scriptCount current actions", ({ scriptCount, eligibleWithAllFlags }) => {
    it.each([
      { available: true, autoAttempted: false, suggesting: false, expected: eligibleWithAllFlags },
      { available: false, autoAttempted: false, suggesting: false, expected: false },
      { available: true, autoAttempted: true, suggesting: false, expected: false },
      { available: true, autoAttempted: false, suggesting: true, expected: false },
      { available: false, autoAttempted: true, suggesting: false, expected: false },
      { available: false, autoAttempted: false, suggesting: true, expected: false },
      { available: true, autoAttempted: true, suggesting: true, expected: false },
      { available: false, autoAttempted: true, suggesting: true, expected: false },
    ])(
      "returns $expected with available=$available, autoAttempted=$autoAttempted, suggesting=$suggesting",
      ({ available, autoAttempted, suggesting, expected }) => {
        expect(shouldAutoSuggest({ available, autoAttempted, suggesting, scriptCount })).toBe(
          expected,
        );
      },
    );
  });

  it.each([-1, 0.5, 2, 2 ** 32 - 1, 2 ** 32, Number.NaN, Number.POSITIVE_INFINITY])(
    "requires an exact zero count rather than %s",
    (scriptCount) => {
      expect(
        shouldAutoSuggest({ available: true, scriptCount, autoAttempted: false, suggesting: false }),
      ).toBe(false);
    },
  );
});

describe("scriptsAfterUndo", () => {
  const editedTest = { ...testScript, command: "npm test -- --watch" };
  const otherTest = { ...testScript, id: "test-all" };
  const renamedBuild = { ...buildScript, name: "Build Package" };

  it.each([
    {
      name: "removes both unchanged actions and keeps edited and unrelated actions in order",
      current: [otherTest, lintScript, editedTest, renamedBuild],
      added: [testScript, buildScript, lintScript],
      expected: [otherTest, editedTest],
    },
    {
      name: "matches any added command when an ID appears more than once",
      current: [testScript, editedTest, lintScript],
      added: [testScript, editedTest],
      expected: [lintScript],
    },
    {
      name: "removes every current entry that matches the same added action",
      current: [testScript, lintScript, testScript],
      added: [testScript],
      expected: [lintScript],
    },
    {
      name: "keeps current actions when a previous Undo already removed the suggestions",
      current: [lintScript, otherTest],
      added: [testScript, buildScript],
      expected: [lintScript, otherTest],
    },
    {
      name: "keeps current actions when the added list is empty",
      current: [lintScript, otherTest],
      added: [],
      expected: [lintScript, otherTest],
    },
    {
      name: "returns an empty list when no current actions remain",
      current: [],
      added: [testScript],
      expected: [],
    },
    {
      name: "returns an empty list when all current actions were added",
      current: [testScript, buildScript],
      added: [buildScript, testScript],
      expected: [],
    },
  ])("$name", ({ current, added, expected }) => {
    expect(scriptsAfterUndo(current, added)).toStrictEqual(expected);
  });
});

describe("suggestionNoticeFor", () => {
  describe.each(["auto", "manual"] as const)("with the %s trigger", (trigger) => {
    it.each<{
      name: string;
      outcome: ProjectActionSuggestOutcome;
      auto: ProjectActionSuggestionNotice | null;
      manual: ProjectActionSuggestionNotice | null;
    }>([
      {
        name: "one added action",
        outcome: { _tag: "Added", scripts: [testScript] },
        auto: { kind: "added", scripts: [testScript] },
        manual: { kind: "added", scripts: [testScript] },
      },
      {
        name: "three added actions in their original order",
        outcome: { _tag: "Added", scripts: [testScript, buildScript, lintScript] },
        auto: { kind: "added", scripts: [testScript, buildScript, lintScript] },
        manual: { kind: "added", scripts: [testScript, buildScript, lintScript] },
      },
      {
        name: "an empty added list",
        outcome: { _tag: "Added", scripts: [] },
        auto: null,
        manual: null,
      },
      {
        name: "skipped",
        outcome: { _tag: "Skipped" },
        auto: null,
        manual: null,
      },
      {
        name: "none found",
        outcome: { _tag: "NoneFound" },
        auto: null,
        manual: { kind: "none-found" },
      },
      {
        name: "failure with its original message",
        outcome: { _tag: "Failed", message: "Service unavailable" },
        auto: null,
        manual: { kind: "failed", message: "Service unavailable" },
      },
      {
        name: "failure with an empty message",
        outcome: { _tag: "Failed", message: "" },
        auto: null,
        manual: { kind: "failed", message: "" },
      },
    ])("handles $name", (testCase) => {
      expect(suggestionNoticeFor(trigger, testCase.outcome)).toStrictEqual(testCase[trigger]);
    });
  });
});
