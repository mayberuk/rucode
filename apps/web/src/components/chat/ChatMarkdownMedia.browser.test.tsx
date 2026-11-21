import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import ChatMarkdown from "../ChatMarkdown";
import { ChatMarkdownAssetImage, ChatMarkdownImage, markdownImageCopy } from "./ChatMarkdownMedia";

// Every evaluation of the URL query is one mint: the first read, then one per refresh.
const assetQuery = vi.hoisted(() => ({ mints: 0 }));
vi.mock(import("~/state/assets"), async (original) => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const createUrl = Atom.family((_key: string) =>
    Atom.make(() => {
      assetQuery.mints += 1;
      return AsyncResult.success({
        relativeUrl:
          "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        expiresAt: Number.MAX_SAFE_INTEGER,
      });
    }).pipe(Atom.keepAlive),
  );
  const actual = await original();
  return {
    ...actual,
    assetEnvironment: {
      ...actual.assetEnvironment,
      createUrl: (target: { readonly input: unknown }) => createUrl(JSON.stringify(target.input)),
    },
  };
});
vi.mock(import("~/state/session"), async (original) => {
  const { Option } = await import("effect");
  const { PrimaryConnectionTarget } = await import("@t3tools/client-runtime/connection");
  const { EnvironmentId } = await import("@t3tools/contracts");
  const target = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("environment-1"),
    label: "Local",
    httpBaseUrl: "http://localhost:1",
    wsBaseUrl: "ws://localhost:1",
  });
  const prepared: PreparedConnection = {
    environmentId: target.environmentId,
    label: target.label,
    httpBaseUrl: target.httpBaseUrl,
    socketUrl: target.wsBaseUrl,
    httpAuthorization: null,
    target,
  };
  return {
    ...(await original()),
    usePreparedConnection: () => Option.some(prepared),
  };
});
vi.mock(import("~/state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));

describe("ChatMarkdownAssetImage", () => {
  it("does not re-mint an unchanged workspace image's URL on remount", async () => {
    assetQuery.mints = 0;
    const image = (
      <ChatMarkdownAssetImage
        environmentId={EnvironmentId.make("environment-1")}
        resource={{
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: "docs/diagram.png",
        }}
        alt="diagram"
        workspaceMutationId="mutation-1"
      />
    );

    {
      await using screen = await render(image);
      await expect.element(screen.getByRole("img", { name: "diagram" })).toBeInTheDocument();
    }
    // The first mount at a known revision re-mints the cached URL once.
    expect(assetQuery.mints).toBe(2);

    await using screen = await render(<ChatMarkdownAssetImage {...image.props} />);
    await expect.element(screen.getByRole("img", { name: "diagram" })).toBeInTheDocument();
    expect(assetQuery.mints).toBe(2);
  });
});

describe("markdownImageCopy", () => {
  it("copies an image whose path has a space as Markdown that is still that image", () => {
    // Raw HTML <img> and <picture> sources reach the copy with the space unencoded.
    const copied = markdownImageCopy("Shot", "/work/my shot.png", undefined);
    const [block] = unified().use(remarkParse).parse(copied).children;
    const images =
      block?.type === "paragraph" ? block.children.filter((node) => node.type === "image") : [];
    expect(images.map((image) => decodeURI(image.url))).toEqual(["/work/my shot.png"]);
  });
});

describe("remote media loaded from the keyboard", () => {
  // The approval set lives for the whole module, so every case uses a URL no other case does.
  const localImage = (name: string) => `${location.origin}/favicon-16x16.png?${name}`;
  // Reserved documentation address (RFC 5737): the request never gets an answer, so the image stays undecoded.
  const unansweredImage = (name: string) => `https://192.0.2.1/${name}.png`;
  const renderText = (text: string) => render(<ChatMarkdown cwd="/tmp/project" text={text} />);

  it("keeps focus in the page after Load is pressed with Enter", async () => {
    await using screen = await renderText(`![shot](${localImage("keyboard-focus")})`);
    const load = screen.getByRole("button", { name: `Load image from ${location.host}` });
    load.element().focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(screen.container.querySelector("img")).not.toBeNull());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("shows Loading image for a standalone image until it decodes", async () => {
    await using screen = await renderText(`![shot](${unansweredImage("standalone")})`);
    await userEvent.click(screen.getByRole("button", { name: "Load image from 192.0.2.1" }));
    await expect.element(screen.getByText("Loading image")).toBeVisible();
  });

  it("shows no Loading image text for a standalone image that is not remote", async () => {
    await using screen = await render(
      <ChatMarkdownImage
        src={localImage("not-remote")}
        alt="shot"
        copyMarkdown={undefined}
        standalone
        actionsSource={{ kind: "image", name: "shot", src: localImage("not-remote") }}
      />,
    );
    expect(screen.container.textContent).not.toContain("Loading image");
    await vi.waitFor(() => expect(screen.container.querySelector("img")).not.toBeNull());
  });

  it("shows the host chip for an inline image until it loads", async () => {
    await using held = await renderText(`See ![shot](${unansweredImage("inline")}) here`);
    await userEvent.click(held.getByRole("button", { name: "Load image from 192.0.2.1" }));
    await expect.element(held.getByText("Loading image from 192.0.2.1")).toBeVisible();

    await using loaded = await renderText(`See ![shot](${localImage("inline-loads")}) here`);
    await userEvent.click(loaded.getByRole("button", { name: `Load image from ${location.host}` }));
    await expect.element(loaded.getByText("Loading image from")).not.toBeInTheDocument();
    expect(loaded.container.querySelector("img")).not.toBeNull();
  });

  it("loads an image inside a link on the first Enter and follows the link on the next", async () => {
    // The link opens a new tab, so each click that reaches the window unhandled is recorded and cancelled.
    const navigations: Event[] = [];
    const controller = new AbortController();
    window.addEventListener(
      "click",
      (event) => {
        if (!event.defaultPrevented) navigations.push(event);
        event.preventDefault();
      },
      { signal: controller.signal },
    );
    try {
      await using screen = await renderText(
        `[![CI](${localImage("linked")})](https://github.com/o/r)`,
      );
      const link = screen.container.querySelector("a")!;
      link.focus();

      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => expect(screen.container.querySelector("img")).not.toBeNull());
      expect(navigations).toHaveLength(0);

      link.focus();
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => expect(navigations).toHaveLength(1));
      expect(navigations[0]?.target).toBe(link);
    } finally {
      controller.abort();
    }
  });
});
