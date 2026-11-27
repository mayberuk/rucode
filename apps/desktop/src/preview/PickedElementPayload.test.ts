import { describe, expect, it } from "vite-plus/test";

import { isPickedElementPayload, isPreviewAnnotationPayload } from "./PickedElementPayload.ts";

function validPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    pageUrl: "https://example.com/",
    pageTitle: "Example",
    tagName: "button",
    selector: "button.submit",
    htmlPreview: "<button>Save</button>",
    componentName: "SubmitButton",
    source: {
      functionName: "SubmitButton",
      fileName: "/repo/src/Button.tsx",
      lineNumber: 12,
      columnNumber: 5,
    },
    stack: [
      {
        functionName: "SubmitButton",
        fileName: "/repo/src/Button.tsx",
        lineNumber: 12,
        columnNumber: 5,
      },
    ],
    styles: ".submit { color: white; }",
    pickedAt: "2026-05-03T18:00:00.000Z",
    ...overrides,
  };
}

describe("isPickedElementPayload", () => {
  it("rejects non-finite numeric line/column numbers", () => {
    expect(
      isPickedElementPayload(
        validPayload({
          source: {
            functionName: null,
            fileName: null,
            lineNumber: Number.POSITIVE_INFINITY,
            columnNumber: null,
          },
        }),
      ),
    ).toBe(false);
    expect(
      isPickedElementPayload(
        validPayload({
          source: {
            functionName: null,
            fileName: null,
            lineNumber: Number.NaN,
            columnNumber: null,
          },
        }),
      ),
    ).toBe(false);
  });
});

function validAnnotation(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "annotation_1",
    pageUrl: "https://example.com/",
    pageTitle: "Example",
    comment: "Make this clearer",
    elements: [
      {
        id: "element_1",
        element: validPayload(),
        rect: { x: 10, y: 20, width: 100, height: 40 },
      },
    ],
    regions: [{ id: "region_1", rect: { x: 5, y: 6, width: 20, height: 30 } }],
    strokes: [
      {
        id: "stroke_1",
        color: "#7c3aed",
        width: 4,
        points: [
          { x: 10, y: 10 },
          { x: 20, y: 20 },
        ],
        bounds: { x: 6, y: 6, width: 18, height: 18 },
      },
    ],
    styleChanges: [
      {
        targetId: "element_1",
        selector: "button.submit",
        property: "opacity",
        previousValue: "1",
        value: "0.5",
      },
    ],
    screenshot: null,
    createdAt: "2026-06-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("isPreviewAnnotationPayload", () => {
  it("rejects screenshots supplied by the guest preload", () => {
    expect(isPreviewAnnotationPayload(validAnnotation({ screenshot: { dataUrl: "bad" } }))).toBe(
      false,
    );
  });
});

describe("isPreviewAnnotationPayload with an iter8 target", () => {
  const iter8 = (overrides?: {
    readonly target?: Record<string, unknown>;
    readonly anchor?: Record<string, unknown>;
  }) => ({
    intent: "change",
    anchor: {
      selector: ["x-card#card", "button#pay"],
      role: "button",
      name: "Pay",
      text: "Pay now",
      box: { x: 10, y: 420, width: 120, height: 32 },
      ...overrides?.anchor,
    },
    viewport: { width: 1280, height: 800, devicePixelRatio: 2 },
    theme: "dark",
    ...overrides?.target,
  });

  it("accepts an annotation without an iter8 field and one with a well-formed target", () => {
    expect(isPreviewAnnotationPayload(validAnnotation())).toBe(true);
    expect(isPreviewAnnotationPayload(validAnnotation({ iter8: iter8() }))).toBe(true);
    expect(
      isPreviewAnnotationPayload(
        validAnnotation({
          iter8: iter8({ anchor: { role: undefined, name: undefined, text: undefined } }),
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ["a null target", null],
    ["an undefined target", undefined],
    ["an unknown intent", iter8({ target: { intent: "praise" } })],
    ["an unknown theme", iter8({ target: { theme: "sepia" } })],
    ["no anchor", iter8({ target: { anchor: null } })],
    ["an empty selector list", iter8({ anchor: { selector: [] } })],
    ["an empty selector hop", iter8({ anchor: { selector: ["main", ""] } })],
    ["a non-string selector hop", iter8({ anchor: { selector: ["main", 3] } })],
    ["a selector string instead of a list", iter8({ anchor: { selector: "main" } })],
    ["a non-string role", iter8({ anchor: { role: 1 } })],
    ["a non-string name", iter8({ anchor: { name: null } })],
    ["a non-string text", iter8({ anchor: { text: false } })],
    [
      "a NaN box coordinate",
      iter8({ anchor: { box: { x: Number.NaN, y: 0, width: 1, height: 1 } } }),
    ],
    ["a box missing its height", iter8({ anchor: { box: { x: 0, y: 0, width: 1 } } })],
    [
      "an infinite viewport",
      iter8({
        target: {
          viewport: { width: Number.POSITIVE_INFINITY, height: 800, devicePixelRatio: 2 },
        },
      }),
    ],
    [
      "a viewport without a pixel ratio",
      iter8({ target: { viewport: { width: 1280, height: 800 } } }),
    ],
  ])("rejects %s", (_name, target) => {
    expect(isPreviewAnnotationPayload(validAnnotation({ iter8: target }))).toBe(false);
  });
});
