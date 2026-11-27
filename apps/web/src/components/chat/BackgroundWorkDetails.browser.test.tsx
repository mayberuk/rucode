import "~/index.css";
import { EnvironmentId, ProviderDriverKind, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
const shells = vi.hoisted(() => ({ byId: new Map<string, { id: string; title: string }>() }));
vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useQuietThreadShell: ((ref: { readonly threadId: string } | null) =>
    ref === null ? null : (shells.byId.get(ref.threadId) ?? null)) as never,
}));
vi.mock(import("./CommandOutputPanel"), () => ({
  useCommandOutputStreaming: () => true,
  CommandOutputPanel: () => <div>Command output stream</div>,
}));

import { render } from "../../../test/render";
import { backgroundWorkNowItem } from "./ThreadActivityBanners";
import { ThreadNow } from "./ThreadNow";

it("opens full command details for short labels and keeps pending tasks current", async () => {
  const command = "python3 audit.py -j 6\n> scratch/audit.log 2>&1";
  const commandItem = (status: "running" | "completed") => ({
    id: TurnItemId.make("bash-1"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status,
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-11-09T00:00:00Z"),
    type: "command_execution" as const,
    input: command,
    output: "Command running in background with ID: native-task",
  });
  const view = (
    description?: string,
    status: "running" | "completed" = "completed",
    explicitItem = true,
  ) => (
    <ThreadNow
      attention={null}
      syncPhase={null}
      goal={null}
      work={backgroundWorkNowItem({
        environmentId: EnvironmentId.make("test"),
        threadId: ThreadId.make("thread"),
        tasks: [
          {
            taskId: "native-task",
            itemId: explicitItem ? TurnItemId.make("bash-1") : undefined,
            kind: "command",
            description,
            command,
            awaited: true,
          },
        ],
        turnItems: [
          commandItem(status),
          {
            ...commandItem("running"),
            id: TurnItemId.make("native-match"),
            nativeItemRef: {
              driver: ProviderDriverKind.make("codex"),
              nativeId: "native-task",
              strength: "strong",
            },
            ordinal: 2,
          },
        ],
        stopDisabled: false,
        stopping: false,
        onStop: async () => undefined,
        onOpenThread: () => undefined,
      })}
    />
  );
  await using screen = await render(view("Audit"));
  await screen.getByRole("button", { name: "Details", exact: true }).click();
  await vi.waitFor(() => expect(page.getByRole("dialog").element().textContent).toContain(command));
  await expect.element(page.getByText("Command output stream")).not.toBeInTheDocument();

  await screen.rerender(view(command));
  await expect.element(page.getByRole("heading", { name: "Command", exact: true })).toBeVisible();
  await screen.rerender(view());
  await expect.element(page.getByRole("heading", { name: "Command", exact: true })).toBeVisible();

  await screen.rerender(view("Check remaining modules", "running"));
  await expect
    .element(page.getByRole("heading", { name: "Check remaining modules" }))
    .toBeVisible();
  await expect.element(page.getByText("Command output stream")).toBeVisible();
  await screen.rerender(view("Native fallback", "completed", false));
  await expect.element(page.getByText("Command output stream")).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

const CODEX_COMMAND = "codex exec -s read-only - < prompt.md";
const CODEX_CHILD_ID = ThreadId.make("codex-run:thread:codex-1");

function codexRunView(command: string, onOpenThread: (threadId: ThreadId) => void) {
  return (
    <ThreadNow
      attention={null}
      syncPhase={null}
      goal={null}
      work={backgroundWorkNowItem({
        environmentId: EnvironmentId.make("test"),
        threadId: ThreadId.make("thread"),
        tasks: [
          {
            taskId: "native-task",
            itemId: TurnItemId.make("codex-1"),
            kind: "command",
            command,
          },
        ],
        turnItems: [
          {
            id: TurnItemId.make("codex-1"),
            threadId: ThreadId.make("thread"),
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "running" as const,
            title: null,
            startedAt: null,
            completedAt: null,
            updatedAt: DateTime.makeUnsafe("2026-11-09T00:00:00Z"),
            type: "command_execution" as const,
            input: command,
            output: "",
          },
        ],
        stopDisabled: false,
        stopping: false,
        onStop: async () => undefined,
        onOpenThread,
      })}
    />
  );
}

it("offers Open agent for a Codex run only once its child thread exists", async () => {
  shells.byId.clear();
  const onOpenThread = vi.fn();
  await using screen = await render(codexRunView(CODEX_COMMAND, onOpenThread));
  await screen.getByRole("button", { name: "Details", exact: true }).click();

  await expect.element(page.getByRole("heading", { name: "Codex run" })).toBeVisible();
  expect(page.getByRole("dialog").element().textContent).toContain(CODEX_COMMAND);
  await expect.element(page.getByText("Open agent")).not.toBeInTheDocument();
  await expect.element(page.getByText("Show command")).not.toBeInTheDocument();
  await expect.element(page.getByText(/No transcript/)).not.toBeInTheDocument();

  shells.byId.set(CODEX_CHILD_ID, { id: CODEX_CHILD_ID, title: "List the files" });
  await screen.rerender(codexRunView(CODEX_COMMAND, onOpenThread));
  await expect.element(page.getByRole("heading", { name: "List the files" })).toBeVisible();
  expect(page.getByRole("dialog").element().textContent).not.toContain(CODEX_COMMAND);

  const toggle = page.getByRole("button", { name: "Show command", exact: true });
  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  expect(page.getByRole("dialog").element().textContent).toContain(CODEX_COMMAND);
  const hide = page.getByRole("button", { name: "Hide command", exact: true });
  await expect.element(hide).toHaveAttribute("aria-expanded", "true");
  await hide.click();
  expect(page.getByRole("dialog").element().textContent).not.toContain(CODEX_COMMAND);

  await page.getByRole("button", { name: "Open agent: List the files", exact: true }).click();
  expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(CODEX_CHILD_ID);
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

it("says an --ephemeral Codex run has no transcript and offers no Open agent", async () => {
  shells.byId.clear();
  shells.byId.set(CODEX_CHILD_ID, { id: CODEX_CHILD_ID, title: "List the files" });
  const command = "codex exec --ephemeral -s read-only - < prompt.md";
  await using screen = await render(codexRunView(command, () => undefined));
  await screen.getByRole("button", { name: "Details", exact: true }).click();

  await expect
    .element(
      page.getByText(
        "No transcript: this run was started with --ephemeral, so Codex wrote no session log.",
      ),
    )
    .toBeVisible();
  await expect.element(page.getByText("Open agent")).not.toBeInTheDocument();
  await expect.element(page.getByText("Show command")).not.toBeInTheDocument();
  expect(page.getByRole("dialog").element().textContent).toContain(command);
});

it("renders a command that is not a Codex run, and a subagent, as before", async () => {
  shells.byId.clear();
  shells.byId.set(CODEX_CHILD_ID, { id: CODEX_CHILD_ID, title: "List the files" });
  const onOpenThread = vi.fn();
  const view = (command: string) => (
    <ThreadNow
      attention={null}
      syncPhase={null}
      goal={null}
      work={backgroundWorkNowItem({
        environmentId: EnvironmentId.make("test"),
        threadId: ThreadId.make("thread"),
        tasks: [
          {
            taskId: "native-task",
            itemId: TurnItemId.make("codex-1"),
            kind: "command",
            command,
          },
          {
            taskId: "agent-task",
            kind: "subagent",
            description: `Review the diff ${"and report every finding in full ".repeat(8)}`,
            childThreadId: ThreadId.make("child"),
          },
        ],
        turnItems: [],
        stopDisabled: false,
        stopping: false,
        onStop: async () => undefined,
        onOpenThread,
      })}
    />
  );
  await using screen = await render(view("echo codex exec"));
  await screen.getByRole("button", { name: "Details", exact: true }).click();

  await expect.element(page.getByRole("heading", { name: "Command", exact: true })).toBeVisible();
  await expect.element(page.getByText("Open agent")).not.toBeInTheDocument();
  await expect.element(page.getByText("Show command")).not.toBeInTheDocument();
  expect(page.getByRole("dialog").element().textContent).toContain("echo codex exec");
  const title = page.getByRole("heading", { name: /^Review the diff/ }).element();
  expect(title.getBoundingClientRect().height).toBeGreaterThan(
    parseFloat(getComputedStyle(title).lineHeight) * 1.5,
  );
  await page.getByRole("button", { name: "Open subagent", exact: true }).click();
  expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(ThreadId.make("child"));
});
