import { describe, expect, it } from "@effect/vitest";

import { extractToolActivityPresentation } from "./toolPresentation.ts";

describe("extractToolActivityPresentation", () => {
  it("recovers computer-use presentation for retained calls without result metadata", () => {
    const item = {
      type: "dynamic_tool",
      toolName: "js",
      input: { code: "await sky.get_app_state(app);" },
    };
    expect(extractToolActivityPresentation(item)).toEqual({
      toolSurface: "computer",
      toolSource: { key: "computer-use", name: "Computer Use", kind: "computer" },
    });
    expect(extractToolActivityPresentation({ ...item, toolSurface: "browser" })).toEqual({
      toolSurface: "browser",
    });
    expect(
      extractToolActivityPresentation({ ...item, input: { code: "await fs.readFile(path);" } }),
    ).toEqual({});
  });

  it("replaces a failed Sky call's generic node REPL source", () => {
    const source = { key: "mcp:node_repl", name: "node repl", kind: "integration" };
    const item = {
      type: "dynamic_tool",
      toolName: "node_repl.js",
      title: "js",
      status: "failed",
      toolSource: source,
      input: {
        title: "Restrict the breakpoint to Git actions",
        code: "await sky.type_text({app:'RuCode (Nightly)',text:'debug(ga.run)'});",
      },
    };
    expect(extractToolActivityPresentation(item)).toEqual({
      toolSurface: "computer",
      toolSource: { key: "computer-use", name: "Computer Use", kind: "computer" },
    });
    expect(
      extractToolActivityPresentation({
        ...item,
        input: { code: "await fetch('http://127.0.0.1/json/list');" },
      }),
    ).toEqual({ toolSource: source });
  });

  it("retains valid image paths independently of redacted output", () => {
    expect(
      extractToolActivityPresentation({ viewedImagePath: " /workspace/reference.webp " }),
    ).toEqual({ viewedImagePath: "/workspace/reference.webp" });
    for (const viewedImagePath of [
      "/workspace/README.md",
      "/workspace/a.png\nother",
      "x".repeat(4097) + ".png",
    ])
      expect(extractToolActivityPresentation({ viewedImagePath })).toEqual({});
  });

  it("keeps only inline tool icon images, so no icon request leaves the machine", () => {
    const inline = "data:image/png;base64,iVBORw0KGgo=";
    const remote = "https://www.google.com/s2/favicons?domain=firecrawl.dev&sz=64";
    const source = { key: "mcp:firecrawl", name: "Firecrawl", kind: "integration" };
    const logoOf = (icon: unknown) =>
      extractToolActivityPresentation({ toolIcon: icon, toolSource: source }).toolIcon;

    expect(logoOf({ _tag: "themed-logo", logoUrl: remote })).toBeUndefined();
    expect(logoOf({ _tag: "themed-logo", logoUrl: "data:text/html,<p>x</p>" })).toBeUndefined();
    expect(logoOf({ _tag: "themed-logo", logoUrl: "data:IMAGE/PNG;base64,iVBORw0KGgo=" })).toEqual({
      _tag: "themed-logo",
      logoUrl: "data:IMAGE/PNG;base64,iVBORw0KGgo=",
    });
    expect(logoOf({ _tag: "themed-logo", logoUrl: inline })).toEqual({
      _tag: "themed-logo",
      logoUrl: inline,
    });
    expect(logoOf({ _tag: "themed-logo", logoUrl: inline, logoUrlDark: remote })).toEqual({
      _tag: "themed-logo",
      logoUrl: inline,
    });
    expect(
      logoOf({
        _tag: "website",
        pageUrl: "https://firecrawl.dev/",
        faviconUrl: remote,
        faviconUrlDark: inline,
      }),
    ).toEqual({ _tag: "website", pageUrl: "https://firecrawl.dev/", faviconUrlDark: inline });
  });

  it("does not infer presentation from provider-specific payload data", () => {
    expect(
      extractToolActivityPresentation({
        data: {
          item: {
            arguments: { code: 'await sky.click({ app: "Finder" })' },
            result: {
              _meta: {
                "codex/toolSurface": {
                  kind: "computerUse",
                  app: { kind: "displayName", displayName: "Finder" },
                },
              },
            },
          },
        },
      }),
    ).toEqual({});
  });
});
