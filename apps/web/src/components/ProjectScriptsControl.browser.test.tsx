import { EnvironmentId, ProjectId, type ProjectScript } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import type {
  ProjectActionSuggestOutcome,
  ProjectActionSuggestionsController,
  SuggestTrigger,
} from "./projectActionSuggestions.logic";
import ProjectScriptsControl from "./ProjectScriptsControl";
import { AnchoredToastProvider, ToastProvider } from "./ui/toast";

const environmentId = EnvironmentId.make("environment");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

function script(
  id: string,
  name: string,
  command: string,
  icon: ProjectScript["icon"],
): ProjectScript {
  return {
    id,
    name,
    command,
    icon,
    runOnWorktreeCreate: false,
    runOnSettle: false,
    stopOnSettle: false,
  };
}

const dev = script("dev", "Dev", "pnpm dev", "play");
const test = script("test", "Test", "pnpm test", "test");
const lint = script("lint", "Lint", "pnpm lint", "lint");
const added = [dev, test, lint];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Suggest = (trigger: SuggestTrigger) => Promise<ProjectActionSuggestOutcome>;
type Undo = ProjectActionSuggestionsController["undo"];

const undoSucceeds: Undo = async () => AsyncResult.success(undefined);

/** Stands in for the web controller: it owns the same `suggesting` and `autoAttempted` flags. */
function Harness(props: {
  scripts: ReadonlyArray<ProjectScript>;
  suggest: Suggest;
  undo?: Undo;
  available?: boolean;
  attempted?: boolean;
  projectId?: ProjectId;
  withController?: boolean;
}) {
  const [suggesting, setSuggesting] = useState(false);
  const [autoAttempted, setAutoAttempted] = useState(props.attempted ?? false);
  const controller: ProjectActionSuggestionsController = {
    available: props.available ?? true,
    projectId: props.projectId ?? projectA,
    projectName: "acme-app",
    suggesting,
    autoAttempted,
    suggest: async (trigger) => {
      if (trigger === "auto") setAutoAttempted(true);
      setSuggesting(true);
      try {
        return await props.suggest(trigger);
      } finally {
        setSuggesting(false);
      }
    },
    undo: props.undo ?? undoSucceeds,
  };
  return (
    <ToastProvider timeout={0}>
      <AnchoredToastProvider timeout={0}>
        <ProjectScriptsControl
          environmentId={environmentId}
          displayMode="panel"
          scripts={props.scripts}
          onRunScript={() => {}}
          onAddScript={async () => AsyncResult.success(undefined)}
          onUpdateScript={async () => AsyncResult.success(undefined)}
          onDeleteScript={async () => AsyncResult.success(undefined)}
          {...(props.withController === false ? {} : { suggestions: controller })}
        />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

it("suggests once on its own, shows the placeholder, then the Undo notice, and does not suggest again after Undo", async () => {
  const pending = deferred<ProjectActionSuggestOutcome>();
  const suggest = vi.fn<Suggest>(() => pending.promise);
  const undo = vi.fn<Undo>(undoSucceeds);
  await using screen = await render(<Harness scripts={[]} suggest={suggest} undo={undo} />);

  await expect.element(page.getByRole("status")).toHaveTextContent("Finding actions in acme-app");
  expect(suggest).toHaveBeenCalledTimes(1);
  expect(suggest).toHaveBeenCalledWith("auto");
  await expect
    .element(page.getByRole("button", { name: "Add project script", exact: true }))
    .not.toBeInTheDocument();

  pending.resolve({ _tag: "Added", projectId: projectA, scripts: added });
  await screen.rerender(<Harness scripts={added} suggest={suggest} undo={undo} />);

  await expect.element(page.getByText("Finding actions in acme-app")).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Run Dev" })).toBeVisible();
  await expect.element(page.getByText("Added 3 actions")).toBeVisible();
  await expect.element(page.getByText("Dev, Test, and Lint")).toBeVisible();

  await page.getByRole("button", { name: "Undo" }).click();
  await vi.waitFor(() => expect(undo).toHaveBeenCalledWith(projectA, added));
  expect(undo).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(document.body.innerText).not.toContain("Added 3 actions"));

  await screen.rerender(<Harness scripts={[]} suggest={suggest} undo={undo} />);
  await expect.element(page.getByRole("button", { name: "Suggest", exact: true })).toBeVisible();
  expect(suggest).toHaveBeenCalledTimes(1);
});

it("says 'Added 1 action' for a single suggestion", async () => {
  const suggest = vi.fn<Suggest>(async () => ({
    _tag: "Added",
    projectId: projectA,
    scripts: [dev],
  }));
  await using screen = await render(<Harness scripts={[]} suggest={suggest} />);
  await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));
  await screen.rerender(<Harness scripts={[dev]} suggest={suggest} />);

  await expect.element(page.getByText("Added 1 action", { exact: true })).toBeVisible();
});

it("dismisses the Added notice as soon as Undo is pressed, before the undo finishes", async () => {
  const pendingUndo = deferred<Awaited<ReturnType<Undo>>>();
  const suggest = vi.fn<Suggest>(async () => ({
    _tag: "Added",
    projectId: projectA,
    scripts: added,
  }));
  const undo = vi.fn<Undo>(() => pendingUndo.promise);
  await using screen = await render(<Harness scripts={[]} suggest={suggest} undo={undo} />);
  await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));
  await screen.rerender(<Harness scripts={added} suggest={suggest} undo={undo} />);
  await expect.element(page.getByText("Added 3 actions")).toBeVisible();

  await page.getByRole("button", { name: "Undo" }).click();

  await vi.waitFor(() => expect(undo).toHaveBeenCalledWith(projectA, added));
  await vi.waitFor(() => expect(document.body.innerText).not.toContain("Added 3 actions"));
  await screen.rerender(<Harness scripts={[]} suggest={suggest} undo={undo} />);
  pendingUndo.resolve(AsyncResult.success(undefined));
  await expect.element(page.getByRole("button", { name: "Suggest", exact: true })).toBeVisible();
  await expect.element(page.getByText("Added 3 actions")).not.toBeInTheDocument();
});

it("closes the Added notice when another project becomes active", async () => {
  const suggest = vi.fn<Suggest>(async () => ({
    _tag: "Added",
    projectId: projectA,
    scripts: added,
  }));
  const undo = vi.fn<Undo>(undoSucceeds);
  await using screen = await render(<Harness scripts={[]} suggest={suggest} undo={undo} />);
  await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));
  await screen.rerender(<Harness scripts={added} suggest={suggest} undo={undo} />);
  await expect.element(page.getByText("Added 3 actions")).toBeVisible();

  await screen.rerender(
    <Harness projectId={projectB} scripts={[dev]} suggest={suggest} undo={undo} />,
  );

  await vi.waitFor(() => expect(document.body.innerText).not.toContain("Added 3 actions"));
  expect(undo).not.toHaveBeenCalled();
});

it("drops a suggestion result for a project that is no longer active, and keeps the active project's own notice", async () => {
  const pendingA = deferred<ProjectActionSuggestOutcome>();
  const suggest = vi.fn<Suggest>((trigger) =>
    trigger === "auto"
      ? pendingA.promise
      : Promise.resolve({ _tag: "Added", projectId: projectB, scripts: [lint] }),
  );
  const undo = vi.fn<Undo>(undoSucceeds);
  await using screen = await render(<Harness scripts={[]} suggest={suggest} undo={undo} />);
  await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));
  await screen.rerender(
    <Harness projectId={projectB} scripts={[dev]} suggest={suggest} undo={undo} />,
  );

  pendingA.resolve({ _tag: "Added", projectId: projectA, scripts: added });
  await expect.element(page.getByRole("button", { name: "Run Dev" })).toBeVisible();
  await page.getByRole("button", { name: "Script actions" }).click();
  await page.getByRole("menuitem", { name: "Suggest more actions" }).click();
  await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(2));
  await screen.rerender(
    <Harness projectId={projectB} scripts={[dev, lint]} suggest={suggest} undo={undo} />,
  );

  await expect.element(page.getByText("Added 1 action", { exact: true })).toBeVisible();
  expect(document.body.innerText).not.toContain("Added 3 actions");
  await page.getByRole("button", { name: "Undo" }).click();
  await vi.waitFor(() => expect(undo).toHaveBeenCalledWith(projectB, [lint]));
  expect(undo).toHaveBeenCalledTimes(1);
});

it("explains a failed Undo", async () => {
  const suggest = vi.fn<Suggest>(async () => ({
    _tag: "Added",
    projectId: projectA,
    scripts: added,
  }));
  const undo = vi.fn<Undo>(async () => AsyncResult.failure(Cause.fail(new Error("Read-only"))));
  await using screen = await render(<Harness scripts={[]} suggest={suggest} undo={undo} />);
  await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));
  await screen.rerender(<Harness scripts={added} suggest={suggest} undo={undo} />);

  await page.getByRole("button", { name: "Undo" }).click();

  await expect.element(page.getByText("Could not undo")).toBeVisible();
  await expect.element(page.getByText("Read-only")).toBeVisible();
});

it("offers Suggest on an empty project and reports an empty result", async () => {
  const pending = deferred<ProjectActionSuggestOutcome>();
  const suggest = vi.fn<Suggest>(() => pending.promise);
  await using _screen = await render(<Harness scripts={[]} attempted suggest={suggest} />);

  expect(suggest).not.toHaveBeenCalled();
  await expect
    .element(page.getByRole("button", { name: "Add project script", exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "Suggest", exact: true }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("Finding actions in acme-app");
  expect(suggest).toHaveBeenCalledTimes(1);
  expect(suggest).toHaveBeenCalledWith("manual");

  pending.resolve({ _tag: "NoneFound" });

  await expect.element(page.getByText("No actions found")).toBeVisible();
  await expect
    .element(page.getByText("Nothing in acme-app looked like a command to suggest."))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Suggest", exact: true })).toBeVisible();
  await expect.element(page.getByText("Finding actions in acme-app")).not.toBeInTheDocument();
});

it("shows the reason when a manual suggestion fails, and settles on the empty row", async () => {
  const suggest = vi.fn<Suggest>(async () => ({ _tag: "Failed", message: "Model unavailable" }));
  await using _screen = await render(<Harness scripts={[]} attempted suggest={suggest} />);

  await page.getByRole("button", { name: "Suggest", exact: true }).click();

  await expect.element(page.getByText("Could not suggest actions")).toBeVisible();
  await expect.element(page.getByText("Model unavailable")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Suggest", exact: true })).toBeVisible();
});

it.each<ProjectActionSuggestOutcome>([
  { _tag: "Failed", message: "Model unavailable" },
  { _tag: "NoneFound" },
  { _tag: "Skipped" },
])("settles quietly when the automatic suggestion ends as $_tag", async (outcome) => {
  const suggest = vi.fn<Suggest>(async () => outcome);
  await using _screen = await render(<Harness scripts={[]} suggest={suggest} />);

  await expect.element(page.getByRole("button", { name: "Suggest", exact: true })).toBeVisible();
  expect(suggest).toHaveBeenCalledTimes(1);
  await expect.element(page.getByText("Could not suggest actions")).not.toBeInTheDocument();
  await expect.element(page.getByText("No actions found")).not.toBeInTheDocument();
});

it("shows no placeholder, Suggest button or menu item, and never calls the server, when suggestions are off", async () => {
  const suggest = vi.fn<Suggest>(async () => ({ _tag: "NoneFound" }));
  await using screen = await render(<Harness scripts={[]} available={false} suggest={suggest} />);

  await expect
    .element(page.getByRole("button", { name: "Add project script", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Suggest", exact: true }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();

  await screen.rerender(<Harness scripts={[dev]} available={false} suggest={suggest} />);
  await page.getByRole("button", { name: "Script actions" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Add project script" })).toBeVisible();
  await expect
    .element(page.getByRole("menuitem", { name: "Suggest more actions" }))
    .not.toBeInTheDocument();
  expect(suggest).not.toHaveBeenCalled();
});

it("offers 'Suggest more actions' in the menu of a project that has actions, without suggesting on its own", async () => {
  const suggest = vi.fn<Suggest>(async () => ({ _tag: "NoneFound" }));
  await using _screen = await render(<Harness scripts={[dev]} suggest={suggest} />);

  await expect.element(page.getByRole("button", { name: "Run Dev" })).toBeVisible();
  expect(suggest).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Script actions" }).click();
  await expect.element(page.getByRole("menu").getByRole("separator")).toBeInTheDocument();
  await page.getByRole("menuitem", { name: "Suggest more actions" }).click();

  await vi.waitFor(() => expect(suggest).toHaveBeenCalledWith("manual"));
  expect(suggest).toHaveBeenCalledTimes(1);
});

it("renders the plain empty row when no controller is passed", async () => {
  const suggest = vi.fn<Suggest>(async () => ({ _tag: "NoneFound" }));
  await using _screen = await render(
    <Harness scripts={[]} withController={false} suggest={suggest} />,
  );

  await expect
    .element(page.getByRole("button", { name: "Add project script", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Suggest", exact: true }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  expect(suggest).not.toHaveBeenCalled();
});
