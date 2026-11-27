import { describe, expect, it } from "vite-plus/test";
import {
  buildConfirmReply,
  mergeConfirmReply,
  parseConfirmReply,
  parseConfirmSection,
  splitInlineCode,
  toggleConfirmAnswer,
  type ConfirmAnswers,
  type ConfirmQuestion,
} from "./confirmBlock.logic";

const YES_NO = [
  { label: "Yes", reply: "yes", suggested: false },
  { label: "No", reply: "no", suggested: false },
] as const;

function option(label: string, suggested = false) {
  return { label, reply: label, suggested };
}

function question(
  overrides: Partial<ConfirmQuestion> & Pick<ConfirmQuestion, "number">,
): ConfirmQuestion {
  return {
    group: "needs-your-call",
    groupLabel: "Needs your call",
    text: "Which one?",
    kind: "choice",
    multiple: false,
    options: [option("A"), option("B"), option("C")],
    ...overrides,
  };
}

function answers(entries: ReadonlyArray<readonly [number, ReadonlyArray<number>]>): ConfirmAnswers {
  return new Map(entries);
}

describe("parseConfirmSection", () => {
  const PUSH = "Push the branch and open a draft PR?";

  const parses: ReadonlyArray<{
    name: string;
    input: string;
    body: string;
    questions: ReadonlyArray<ConfirmQuestion>;
  }> = [
    {
      name: "one Just confirm question gets implicit yes/no",
      input: `Recap.\n\n**Just confirm — 1. ${PUSH}**`,
      body: "Recap.",
      questions: [
        {
          number: 1,
          group: "just-confirm",
          groupLabel: "Just confirm",
          text: PUSH,
          kind: "yes-no",
          multiple: false,
          options: YES_NO,
        },
      ],
    },
    {
      name: "Just confirm then Needs your call with answer lines, blank lines allowed between",
      input: [
        "Summary of changes.",
        "",
        `**Just confirm — 1. ${PUSH}**`,
        "",
        "**Needs your call — 2. Which suites should run for acme/app?**",
        "",
        "- Unit tests",
        "",
        "- Typecheck",
        "- Both",
        "",
      ].join("\n"),
      body: "Summary of changes.",
      questions: [
        {
          number: 1,
          group: "just-confirm",
          groupLabel: "Just confirm",
          text: PUSH,
          kind: "yes-no",
          multiple: false,
          options: YES_NO,
        },
        {
          number: 2,
          group: "needs-your-call",
          groupLabel: "Needs your call",
          text: "Which suites should run for acme/app?",
          kind: "choice",
          multiple: false,
          options: [option("Unit tests"), option("Typecheck"), option("Both")],
        },
      ],
    },
    {
      name: "(my pick) marks the option suggested and is stripped, any case, any spacing",
      input: [
        "**Needs your call — 1. Merge strategy?**",
        "- Squash merge (my pick)",
        "- Rebase",
        "- Merge commit(My Pick)  ",
        "- Keep (my pick) as is",
      ].join("\n"),
      body: "",
      questions: [
        {
          number: 1,
          group: "needs-your-call",
          groupLabel: "Needs your call",
          text: "Merge strategy?",
          kind: "choice",
          multiple: false,
          options: [
            option("Squash merge", true),
            option("Rebase"),
            option("Merge commit", true),
            option("Keep (my pick) as is"),
          ],
        },
      ],
    },
    {
      name: "Pick any: makes a multiple choice and strips the prefix, any case",
      input: [
        "**Needs your call — 1. Pick any: which checks should run?**",
        "- Lint",
        "- Tests",
        "**Needs your call — 2. pick any:   which targets?**",
        "- Web",
      ].join("\n"),
      body: "",
      questions: [
        {
          number: 1,
          group: "needs-your-call",
          groupLabel: "Needs your call",
          text: "which checks should run?",
          kind: "choice",
          multiple: true,
          options: [option("Lint"), option("Tests")],
        },
        {
          number: 2,
          group: "needs-your-call",
          groupLabel: "Needs your call",
          text: "which targets?",
          kind: "choice",
          multiple: true,
          options: [option("Web")],
        },
      ],
    },
    {
      name: "Pick any: without answer lines strips the prefix but is not multiple",
      input: "**Just confirm — 1. Pick any: ship it?**",
      body: "",
      questions: [
        {
          number: 1,
          group: "just-confirm",
          groupLabel: "Just confirm",
          text: "ship it?",
          kind: "yes-no",
          multiple: false,
          options: YES_NO,
        },
      ],
    },
    {
      name: "Needs your call without answer lines is open",
      input: "**Needs your call — 1. What should the flag be called?**",
      body: "",
      questions: [
        {
          number: 1,
          group: "needs-your-call",
          groupLabel: "Needs your call",
          text: "What should the flag be called?",
          kind: "open",
          multiple: false,
          options: [],
        },
      ],
    },
    {
      name: "en dash and hyphen separators",
      input: "**Just confirm – 1. First?**\n**Needs your call - 2. Second?**",
      body: "",
      questions: [
        {
          number: 1,
          group: "just-confirm",
          groupLabel: "Just confirm",
          text: "First?",
          kind: "yes-no",
          multiple: false,
          options: YES_NO,
        },
        {
          number: 2,
          group: "needs-your-call",
          groupLabel: "Needs your call",
          text: "Second?",
          kind: "open",
          multiple: false,
          options: [],
        },
      ],
    },
    {
      name: "CRLF input keeps no carriage returns in fields and a prefix body",
      input: "Recap.\r\n\r\n**Needs your call — 1. Which one?**\r\n- A\r\n- B\r\n",
      body: "Recap.",
      questions: [
        {
          number: 1,
          group: "needs-your-call",
          groupLabel: "Needs your call",
          text: "Which one?",
          kind: "choice",
          multiple: false,
          options: [option("A"), option("B")],
        },
      ],
    },
    {
      name: "a message that is only the section has an empty body",
      input: "\n\n**Just confirm — 1. Ship it?**\n",
      body: "",
      questions: [
        {
          number: 1,
          group: "just-confirm",
          groupLabel: "Just confirm",
          text: "Ship it?",
          kind: "yes-no",
          multiple: false,
          options: YES_NO,
        },
      ],
    },
    {
      name: "a recap of several paragraphs stays in the body, leading text untouched",
      input: "  Intro line.\n\nSecond paragraph.\n\n\n**Just confirm — 1. Ship it?**",
      body: "  Intro line.\n\nSecond paragraph.",
      questions: [
        {
          number: 1,
          group: "just-confirm",
          groupLabel: "Just confirm",
          text: "Ship it?",
          kind: "yes-no",
          multiple: false,
          options: YES_NO,
        },
      ],
    },
    {
      name: "up to three spaces of indent on question and answer lines",
      input: "   **Needs your call — 1. Which?**\n   - A",
      body: "",
      questions: [
        {
          number: 1,
          group: "needs-your-call",
          groupLabel: "Needs your call",
          text: "Which?",
          kind: "choice",
          multiple: false,
          options: [option("A")],
        },
      ],
    },
    {
      name: "a closed code fence in the body does not block the section",
      input: "```\ncode\n```\n\n~~~\nmore\n~~~\n\n**Just confirm — 1. Ship it?**",
      body: "```\ncode\n```\n\n~~~\nmore\n~~~",
      questions: [
        {
          number: 1,
          group: "just-confirm",
          groupLabel: "Just confirm",
          text: "Ship it?",
          kind: "yes-no",
          multiple: false,
          options: YES_NO,
        },
      ],
    },
  ];

  it.each(parses)("parses: $name", ({ input, body, questions }) => {
    expect(parseConfirmSection(input)).toEqual({ body, questions });
  });

  it.each(parses)("body is a prefix of the input: $name", ({ input }) => {
    const section = parseConfirmSection(input);
    expect(section).not.toBeNull();
    expect(input.startsWith(section?.body ?? "\u0000")).toBe(true);
  });

  const misses: ReadonlyArray<{ name: string; input: string }> = [
    { name: "empty input", input: "" },
    { name: "a plain numbered list at the end", input: "Notes:\n\n1. foo\n2. bar" },
    {
      name: "a bold question line mid-message followed by prose",
      input: "**Just confirm — 1. Ship it?**\n\nThanks, that is all.",
    },
    {
      name: "the question line is not the end: prose between two questions",
      input: "**Just confirm — 1. A?**\nprose\n**Just confirm — 2. B?**",
    },
    { name: "numbering that starts at 2", input: "**Just confirm — 2. Ship it?**" },
    {
      name: "numbering that skips",
      input: "**Just confirm — 1. A?**\n**Needs your call — 3. B?**",
    },
    {
      name: "numbering out of order",
      input: "**Just confirm — 2. A?**\n**Just confirm — 1. B?**",
    },
    {
      name: "a repeated number",
      input: "**Just confirm — 1. A?**\n**Just confirm — 1. B?**",
    },
    { name: "a zero-padded number", input: "**Just confirm — 01. Ship it?**" },
    { name: "an unknown label", input: "**Heads up — 1. Ship it?**" },
    {
      name: "an unknown label after a real one",
      input: "**Just confirm — 1. A?**\n**Heads up — 2. B?**",
    },
    { name: "a lowercase label", input: "**just confirm — 1. Ship it?**" },
    { name: "a missing closing bold marker", input: "**Just confirm — 1. Ship it?" },
    { name: "empty question text", input: "**Just confirm — 1. **" },
    {
      name: "a question that is only the Pick any: prefix",
      input: "**Needs your call — 1. Pick any:**",
    },
    {
      name: "a trailing sentence after the answers",
      input: "**Needs your call — 1. Which?**\n- A\n- B\n\nLet me know.",
    },
    {
      name: "an answer line before any question line in the trailing run",
      input: "- stray\n**Just confirm — 1. Ship it?**",
    },
    {
      name: "a bullet list above the section, blank line between",
      input: "Intro\n\n- stray\n\n**Just confirm — 1. Ship it?**",
    },
    {
      name: "an answer line with no text",
      input: "**Needs your call — 1. Which?**\n- A\n- ",
    },
    {
      name: "an answer that is only the (my pick) marker",
      input: "**Needs your call — 1. Which?**\n- (my pick)",
    },
    {
      name: "a question line indented four spaces",
      input: "    **Just confirm — 1. Ship it?**",
    },
    {
      name: "an answer line indented four spaces",
      input: "**Needs your call — 1. Which?**\n    - A",
    },
    {
      name: "the section inside an unclosed backtick fence",
      input: "```\nlog output\n\n**Just confirm — 1. Ship it?**",
    },
    {
      name: "the section inside an unclosed tilde fence",
      input: "Text\n~~~\nlog output\n\n**Just confirm — 1. Ship it?**\n- A",
    },
    {
      name: "three fences leave one open",
      input: "```\na\n```\n```\nb\n\n**Just confirm — 1. Ship it?**",
    },
  ];

  it.each(misses)("returns null for $name", ({ input }) => {
    expect(parseConfirmSection(input)).toBeNull();
  });
});

describe("toggleConfirmAnswer", () => {
  const single = question({ number: 2 });
  const multiple = question({ number: 2, multiple: true });

  it("single choice: pick, replace, then re-pick clears", () => {
    const picked = toggleConfirmAnswer(single, answers([]), 1);
    expect([...picked]).toEqual([[2, [1]]]);

    const replaced = toggleConfirmAnswer(single, picked, 0);
    expect([...replaced]).toEqual([[2, [0]]]);

    const cleared = toggleConfirmAnswer(single, replaced, 0);
    expect(cleared.size).toBe(0);
    expect(cleared.has(2)).toBe(false);
  });

  it("multiple choice: toggles membership and keeps indexes sorted", () => {
    const a = toggleConfirmAnswer(multiple, answers([]), 2);
    const b = toggleConfirmAnswer(multiple, a, 0);
    expect([...b]).toEqual([[2, [0, 2]]]);

    const c = toggleConfirmAnswer(multiple, b, 2);
    expect([...c]).toEqual([[2, [0]]]);

    const d = toggleConfirmAnswer(multiple, c, 0);
    expect(d.has(2)).toBe(false);
  });

  it("yes-no picks the second option", () => {
    const yesNo = question({ number: 1, kind: "yes-no", options: YES_NO });
    expect([...toggleConfirmAnswer(yesNo, answers([]), 1)]).toEqual([[1, [1]]]);
  });

  it("returns a new map and leaves the input and other questions alone", () => {
    const before = answers([
      [1, [0]],
      [2, [1]],
    ]);
    const after = toggleConfirmAnswer(single, before, 2);
    expect(after).not.toBe(before);
    expect([...before]).toEqual([
      [1, [0]],
      [2, [1]],
    ]);
    expect(after.get(1)).toEqual([0]);
    expect(after.get(2)).toEqual([2]);
  });

  it.each([-1, 3, 1.5, Number.NaN])("returns the input unchanged for option index %s", (index) => {
    const before = answers([[2, [0]]]);
    expect(toggleConfirmAnswer(single, before, index)).toBe(before);
    expect(toggleConfirmAnswer(multiple, before, index)).toBe(before);
  });

  it("returns the input unchanged for an open question", () => {
    const open = question({ number: 1, kind: "open", options: [] });
    const before = answers([]);
    expect(toggleConfirmAnswer(open, before, 0)).toBe(before);
  });
});

describe("buildConfirmReply", () => {
  it("is empty when nothing is answered", () => {
    expect(buildConfirmReply([question({ number: 1 })], answers([]))).toBe("");
    expect(buildConfirmReply([], answers([]))).toBe("");
  });

  it("uses the option reply, not the label", () => {
    const yesNo = question({ number: 1, kind: "yes-no", options: YES_NO });
    expect(buildConfirmReply([yesNo], answers([[1, [0]]]))).toBe("1. yes");
    expect(buildConfirmReply([yesNo], answers([[1, [1]]]))).toBe("1. no");
  });

  it("joins multiple answers with a comma and space in option order", () => {
    const checks = question({
      number: 2,
      multiple: true,
      options: [option("Unit tests"), option("Typecheck"), option("Lint")],
    });
    expect(buildConfirmReply([checks], answers([[2, [2, 0]]]))).toBe("2. Unit tests, Lint");

    const picked = toggleConfirmAnswer(checks, toggleConfirmAnswer(checks, answers([]), 2), 1);
    expect(buildConfirmReply([checks], picked)).toBe("2. Typecheck, Lint");
  });

  it("skips unanswered and open questions, keeps the gaps, one line each in number order", () => {
    const questions = [
      question({ number: 3, options: [option("Retry"), option("Typecheck")] }),
      question({ number: 1, kind: "yes-no", options: YES_NO }),
      question({ number: 2, kind: "open", options: [] }),
      question({ number: 4 }),
    ];
    expect(
      buildConfirmReply(
        questions,
        answers([
          [3, [1]],
          [1, [0]],
          [2, [0]],
        ]),
      ),
    ).toBe("1. yes\n3. Typecheck");
  });

  it("ignores answers whose option index does not exist", () => {
    expect(buildConfirmReply([question({ number: 1 })], answers([[1, [5]]]))).toBe("");
    expect(
      buildConfirmReply([question({ number: 1, multiple: true })], answers([[1, [1, 7]]])),
    ).toBe("1. B");
  });
});

describe("parseConfirmReply", () => {
  const questions = [
    question({ number: 1, kind: "yes-no", options: YES_NO }),
    question({ number: 2, options: [option("Staging"), option("Production")] }),
    question({
      number: 3,
      multiple: true,
      options: [option("Lint"), option("Tests, unit"), option("Types")],
    }),
    question({ number: 4, kind: "open", options: [] }),
  ];

  it.each([
    {
      name: "reads back what buildConfirmReply wrote",
      prompt: "1. yes\n2. Production\n3. Lint, Types\n\nMine",
      answers: [
        [1, [0]],
        [2, [1]],
        [3, [0, 2]],
      ],
      reply: "1. yes\n2. Production\n3. Lint, Types",
    },
    {
      name: "keeps a label that contains the separator",
      prompt: "3. Tests, unit, Types",
      answers: [[3, [1, 2]]],
      reply: "3. Tests, unit, Types",
    },
    {
      name: "is empty for a draft with no reply",
      prompt: "Also check the docs",
      answers: [],
      reply: "",
    },
    { name: "is empty for an empty draft", prompt: "", answers: [], reply: "" },
    {
      name: "stops at an answer that is not an option",
      prompt: "1. no\n2. Preview\n3. Lint",
      answers: [[1, [1]]],
      reply: "1. no",
    },
    {
      name: "stops at an out-of-order line",
      prompt: "2. Staging\n1. yes",
      answers: [[2, [0]]],
      reply: "2. Staging",
    },
    {
      name: "ignores open questions and unknown numbers",
      prompt: "4. maybe\n9. yes",
      answers: [],
      reply: "",
    },
    {
      name: "reads multiple answers only in option order",
      prompt: "3. Types, Lint",
      answers: [],
      reply: "",
    },
  ])("$name", ({ prompt, answers: expected, reply }) => {
    const result = parseConfirmReply(questions, prompt);
    expect([...result.answers.entries()]).toEqual(expected);
    expect(result.reply).toBe(reply);
  });

  it("round-trips through buildConfirmReply and mergeConfirmReply", () => {
    const picked = answers([
      [2, [0]],
      [3, [1]],
    ]);
    const reply = buildConfirmReply(questions, picked);
    const prompt = mergeConfirmReply("Mine", "", reply);
    expect(parseConfirmReply(questions, prompt)).toEqual({ answers: picked, reply });
  });
});

describe("mergeConfirmReply", () => {
  const merges: ReadonlyArray<{
    name: string;
    prompt: string;
    previous: string;
    next: string;
    expected: string;
  }> = [
    { name: "onto an empty prompt", prompt: "", previous: "", next: "1. yes", expected: "1. yes" },
    {
      name: "in front of the user's text, after a blank line",
      prompt: "please also run lint",
      previous: "",
      next: "1. yes",
      expected: "1. yes\n\nplease also run lint",
    },
    {
      name: "replacing the previous reply and keeping the user's text",
      prompt: "1. yes\n\nplease also run lint",
      previous: "1. yes",
      next: "1. no",
      expected: "1. no\n\nplease also run lint",
    },
    {
      name: "replacing the previous reply when it is the whole draft",
      prompt: "1. yes",
      previous: "1. yes",
      next: "1. yes\n2. no",
      expected: "1. yes\n2. no",
    },
    {
      name: "clearing leaves only the user's text",
      prompt: "1. yes\n\nnote",
      previous: "1. yes",
      next: "",
      expected: "note",
    },
    {
      name: "clearing the only text leaves an empty draft",
      prompt: "1. yes",
      previous: "1. yes",
      next: "",
      expected: "",
    },
    {
      name: "a draft the user rewrote so it no longer starts with the previous reply",
      prompt: "I changed my mind",
      previous: "1. yes",
      next: "1. no",
      expected: "1. no\n\nI changed my mind",
    },
    {
      name: "a previous reply that appears later in the draft is not removed",
      prompt: "note 1. yes",
      previous: "1. yes",
      next: "1. no",
      expected: "1. no\n\nnote 1. yes",
    },
    {
      name: "a draft that is only a prefix of the previous reply is kept whole",
      prompt: "1.",
      previous: "1. yes",
      next: "1. no",
      expected: "1. no\n\n1.",
    },
    {
      name: "leading newlines are dropped, trailing whitespace is kept",
      prompt: "\n\ntext\n",
      previous: "",
      next: "1. yes",
      expected: "1. yes\n\ntext\n",
    },
    {
      name: "a single newline after the previous reply is also dropped",
      prompt: "1. yes\nnote\n",
      previous: "1. yes",
      next: "1. no",
      expected: "1. no\n\nnote\n",
    },
    {
      name: "nothing to write and only newlines left",
      prompt: "\n\n",
      previous: "",
      next: "",
      expected: "",
    },
  ];

  it.each(merges)("$name", ({ prompt, previous, next, expected }) => {
    expect(mergeConfirmReply(prompt, previous, next)).toBe(expected);
  });
});

describe("splitInlineCode", () => {
  it.each([
    ["plain text", [{ text: "plain text", code: false }]],
    [
      "Push `acme/app` now",
      [
        { text: "Push ", code: false },
        { text: "acme/app", code: true },
        { text: " now", code: false },
      ],
    ],
    ["`only`", [{ text: "only", code: true }]],
    [
      "`a` and `b`",
      [
        { text: "a", code: true },
        { text: " and ", code: false },
        { text: "b", code: true },
      ],
    ],
    ["an unpaired ` tick", [{ text: "an unpaired ` tick", code: false }]],
    ["", []],
  ])("splits %j", (input, expected) => {
    expect(splitInlineCode(input)).toEqual(expected);
  });
});
