import { describe, expect, it } from "@effect/vitest";

import { toolActivityFaviconUrl } from "./favicon.ts";

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";
const DARK_PNG_DATA_URL = "data:image/png;base64,ZGFyaw==";
const PAGE_URL = "https://example.com/docs";
const VISITED_PAGE_URLS = [
  "https://example.com/docs",
  "http://localhost:5173/app",
  "https://github.com/x/y",
];

describe("toolActivityFaviconUrl", () => {
  it("computes no remote icon address for a visited website in either appearance", () => {
    for (const pageUrl of VISITED_PAGE_URLS) {
      expect(toolActivityFaviconUrl({ pageUrl }, "light")).toBeNull();
      expect(toolActivityFaviconUrl({ pageUrl }, "dark")).toBeNull();
    }
  });

  it("rejects provider-supplied remote and extension icon URLs", () => {
    expect(
      toolActivityFaviconUrl(
        { pageUrl: PAGE_URL, faviconUrl: "https://example.com/icon.png" },
        "light",
      ),
    ).toBeNull();
    expect(
      toolActivityFaviconUrl(
        { pageUrl: PAGE_URL, faviconUrl: "https://example.com/icon.png" },
        "dark",
      ),
    ).toBeNull();
    expect(
      toolActivityFaviconUrl(
        { pageUrl: PAGE_URL, faviconUrl: "chrome-extension://example/_favicon/" },
        "light",
      ),
    ).toBeNull();
    expect(
      toolActivityFaviconUrl(
        { pageUrl: PAGE_URL, faviconUrlDark: "https://example.com/dark.png" },
        "dark",
      ),
    ).toBeNull();
  });

  it("returns an inline image icon as is", () => {
    expect(toolActivityFaviconUrl({ pageUrl: PAGE_URL, faviconUrl: PNG_DATA_URL }, "light")).toBe(
      PNG_DATA_URL,
    );
  });

  it("prefers the inline dark icon in dark appearance when both inline icons are present", () => {
    const icon = { pageUrl: PAGE_URL, faviconUrl: PNG_DATA_URL, faviconUrlDark: DARK_PNG_DATA_URL };
    expect(toolActivityFaviconUrl(icon, "dark")).toBe(DARK_PNG_DATA_URL);
    expect(toolActivityFaviconUrl(icon, "light")).toBe(PNG_DATA_URL);
  });

  it("falls back to the inline icon in dark appearance when the dark icon is absent or remote", () => {
    expect(toolActivityFaviconUrl({ pageUrl: PAGE_URL, faviconUrl: PNG_DATA_URL }, "dark")).toBe(
      PNG_DATA_URL,
    );
    expect(
      toolActivityFaviconUrl(
        {
          pageUrl: PAGE_URL,
          faviconUrl: PNG_DATA_URL,
          faviconUrlDark: "https://example.com/dark.png",
        },
        "dark",
      ),
    ).toBe(PNG_DATA_URL);
  });

  it("ignores the dark icon in light appearance", () => {
    expect(
      toolActivityFaviconUrl({ pageUrl: PAGE_URL, faviconUrlDark: DARK_PNG_DATA_URL }, "light"),
    ).toBeNull();
  });

  it("accepts only data URLs whose media type is an image", () => {
    expect(
      toolActivityFaviconUrl(
        { pageUrl: PAGE_URL, faviconUrl: "data:text/html,<p>hi</p>" },
        "light",
      ),
    ).toBeNull();
    expect(
      toolActivityFaviconUrl(
        { pageUrl: PAGE_URL, faviconUrl: "data:text/plain,image/png" },
        "light",
      ),
    ).toBeNull();
  });

  it("matches the image media type case-insensitively", () => {
    const upper = "data:IMAGE/PNG;base64,iVBORw0KGgo=";
    expect(toolActivityFaviconUrl({ pageUrl: PAGE_URL, faviconUrl: upper }, "light")).toBe(upper);
  });

  it("limits inline icons to 4096 characters", () => {
    const prefix = "data:image/png;base64,";
    const atLimit = prefix + "A".repeat(4096 - prefix.length);
    expect(atLimit).toHaveLength(4096);
    expect(toolActivityFaviconUrl({ pageUrl: PAGE_URL, faviconUrl: atLimit }, "light")).toBe(
      atLimit,
    );
    expect(
      toolActivityFaviconUrl({ pageUrl: PAGE_URL, faviconUrl: `${atLimit}A` }, "light"),
    ).toBeNull();
  });

  it("returns null for an empty or malformed icon value", () => {
    expect(toolActivityFaviconUrl({ pageUrl: PAGE_URL, faviconUrl: "" }, "light")).toBeNull();
    expect(
      toolActivityFaviconUrl({ pageUrl: PAGE_URL, faviconUrl: "not a url" }, "light"),
    ).toBeNull();
  });
});
