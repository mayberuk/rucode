import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type {
  DeleteProjectInput,
  UpdateProjectInput,
} from "@t3tools/client-runtime/state/projects";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type ProjectActionsSuggestInput,
  type ProjectActionsSuggestResult,
  type ProjectScript,
  type ServerConfig,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render, type Screen } from "../../../test/render";
import type { Project } from "../../types";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
type SettingsResult = AtomCommandResult<ServerSettings, Error>;
type SuggestResult = AtomCommandResult<ProjectActionsSuggestResult, Error>;
const state = vi.hoisted(() => ({
  sessions: new Map<EnvironmentId, Atom.Writable<SessionResult>>(),
  projects: [] as Project[],
  update:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: UpdateProjectInput;
      }) => Promise<AsyncResult.Success<void> | AsyncResult.Failure<void, Error>>
    >(),
  delete:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: DeleteProjectInput;
      }) => Promise<AsyncResult.Success<void>>
    >(),
  updateSettings:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: { patch: ServerSettingsPatch };
      }) => Promise<SettingsResult>
    >(),
  suggest:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: ProjectActionsSuggestInput;
      }) => Promise<SuggestResult>
    >(),
  upsertKeybinding: vi.fn(),
  removeKeybinding: vi.fn(),
  confirm: vi.fn<() => Promise<boolean>>(),
  releaseUploads: vi.fn(),
  clearDraft: vi.fn(),
  toast: vi.fn(),
}));

// Session grants come from the server; each test drives them through these atoms.
vi.mock(import("@t3tools/client-runtime/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    createEnvironmentSessionAtoms: ((
      ...args: Parameters<typeof actual.createEnvironmentSessionAtoms>
    ) => ({
      ...actual.createEnvironmentSessionAtoms(...args),
      sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id)!,
    })) as typeof actual.createEnvironmentSessionAtoms,
  };
});
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: useAtomValue(environmentsAtom) })) as never,
  readEnvironment: ((id: EnvironmentId) =>
    appAtomRegistry.get(environmentsAtom).find((environment) => environment.environmentId === id) ??
    null) as never,
  usePrimaryEnvironmentId: () => primaryId,
  usePrimaryEnvironment: (() => useAtomValue(environmentsAtom)[0] ?? null) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => state.projects) as never,
  useThreadShells: () => [],
  useServerConfigs: (() =>
    new Map(
      useAtomValue(environmentsAtom).map((environment) => [
        environment.environmentId,
        environment.serverConfig,
      ]),
    )) as never,
  waitForProjectRemoval: async () => true,
}));
vi.mock(import("~/state/projects"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    projectEnvironment: {
      ...actual.projectEnvironment,
      update: "update",
      delete: "delete",
    } as unknown as typeof actual.projectEnvironment,
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: "update" | "delete" | { label: string }) =>
    typeof command === "string"
      ? state[command]
      : {
          "environment-data:server:update-settings": state.updateSettings,
          "environment-data:project-actions:suggest": state.suggest,
          [serverEnvironment.upsertKeybinding.label]: state.upsertKeybinding,
          [serverEnvironment.removeKeybinding.label]: state.removeKeybinding,
        }[command.label]) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: (environmentId: EnvironmentId | null) => fixtureConfigAtom(environmentId),
    },
  };
});
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS) as never,
}));
vi.mock(import("~/localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() => ({ dialogs: { confirm: state.confirm } })) as never,
}));
vi.mock(import("~/lib/composerDraftUploads"), async (original) => ({
  ...(await original()),
  releaseProjectDraftUploads: state.releaseUploads,
}));
// No toaster is mounted in these tests; the guard's error toast is read at this seam.
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});
// These sections have separate data sources and their own tests.
vi.mock(import("./ProjectDefaultsSettings"), async (original) => ({
  ...(await original()),
  ProjectDefaultsSettings: (() => null) as never,
}));
vi.mock(import("../files/projectFilesQueryState"), async (original) => ({
  ...(await original()),
  getProjectFileQueryAtom: () => missingProjectFile,
}));

import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { I18nProvider } from "../../i18n/I18nProvider";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { assetEnvironment } from "../../state/assets";
import { serverEnvironment } from "../../state/server";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { useProjectScriptEditing } from "../chat/useProjectScriptEditing";
import type {
  ProjectActionSuggestOutcome,
  ProjectActionSuggestionsController,
} from "../projectActionSuggestions.logic";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { ProjectsSettings } from "./ProjectsSettings";
import { SettingsScopeProvider } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { pendingScopedWritesAtom } from "./scopedSettings";
import { validateSettingsScopeSearch, type SettingsScopeSearch } from "./settingsScope";
import { retainSettingsScope, validateSettingsRouteSearch } from "./settingsScopeNavigation";

const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("remote");
const instanceId = ProviderInstanceId.make("codex");
const makeEnvironments = () =>
  [primaryId, remoteId].map((environmentId) => ({
    environmentId,
    label: environmentId,
    connection: { phase: "connected" },
    serverConfig: {
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      settings: { ...DEFAULT_SERVER_SETTINGS },
      environment: {
        platform: { machine: "server" },
        capabilities: { projectOrganization: true, projectSettingsOverrides: true },
      },
    },
  }));
const environmentsAtom = Atom.make(makeEnvironments()).pipe(Atom.keepAlive);
const fixtureConfigAtom = Atom.family((id: EnvironmentId | null) =>
  Atom.make(
    (get) =>
      (get(environmentsAtom).find((environment) => environment.environmentId === id)
        ?.serverConfig as ServerConfig | undefined) ?? null,
  ),
);
const session = (scopes: ReadonlyArray<AuthEnvironmentScope>): AuthSessionState => ({
  authenticated: true,
  scopes,
  permissions: scopes,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
  },
});
const writable = () => AsyncResult.success(session([AuthOrchestrationOperateScope]));
const missingProjectFile = Atom.make(AsyncResult.initial<never, never>());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function setup() {
  vi.clearAllMocks();
  appAtomRegistry.set(environmentsAtom, makeEnvironments());
  appAtomRegistry.set(pendingScopedWritesAtom, []);
  state.updateSettings.mockReset().mockResolvedValue(AsyncResult.success(DEFAULT_SERVER_SETTINGS));
  state.suggest.mockReset();
  for (const id of [primaryId, remoteId]) {
    const atom = state.sessions.get(id);
    if (atom) {
      appAtomRegistry.set(atom, writable());
    } else {
      state.sessions.set(id, Atom.make<SessionResult>(writable()).pipe(Atom.keepAlive));
    }
  }
  state.projects = [primaryId, remoteId].map((environmentId) => ({
    id: ProjectId.make(`project-${environmentId}`),
    environmentId,
    title: "Shared repo",
    workspaceRoot: `/work/${environmentId}`,
    repositoryIdentity: {
      canonicalKey: "github.com/example/shared-repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/shared-repo.git",
      },
    },
    defaultModelSelection: { instanceId, model: "gpt-5-codex" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  }));
  state.update.mockImplementation(async ({ environmentId, input }) => {
    const { projectId, ...updates } = input;
    const patch = Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined),
    ) as Partial<Project>;
    state.projects = state.projects.map((project) =>
      project.environmentId === environmentId && project.id === projectId
        ? { ...project, ...patch }
        : project,
    );
    return AsyncResult.success(undefined);
  });
  state.delete.mockResolvedValue(AsyncResult.success(undefined));
  state.confirm.mockResolvedValue(true);
  useComposerDraftStore.setState({ clearProjectDraftThreadId: state.clearDraft });
}

function projectKey() {
  return buildSidebarProjectSnapshots({
    projects: state.projects,
    settings: DEFAULT_CLIENT_SETTINGS,
    primaryEnvironmentId: primaryId,
    resolveEnvironmentLabel: (id) => id,
  })[0]!.projectKey;
}

async function mountPanel(search: Omit<SettingsScopeSearch, "project"> = {}) {
  const key = projectKey();
  const rootRoute = createRootRoute();
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "settings",
    validateSearch: validateSettingsRouteSearch,
    search: { middlewares: [retainSettingsScope] },
  });
  const projectsRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: "projects",
    component: () => (
      <I18nProvider>
        <SettingsScopeProvider search={{ project: key, ...search }} onChange={() => {}}>
          <ProjectSettingsPanel
            projectKey={key}
            environmentId={search.machine ? EnvironmentId.make(search.machine) : null}
            checkoutKey={search.checkout ?? null}
          />
        </SettingsScopeProvider>
      </I18nProvider>
    ),
  });
  const query = new URLSearchParams({ project: key });
  for (const [name, value] of Object.entries(search)) {
    if (value !== undefined) query.set(name, value);
  }
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute.addChildren([projectsRoute])]),
    history: createMemoryHistory({ initialEntries: [`/settings/projects?${query}`] }),
  });
  await router.load();
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    // The panel's own route tree validates settings search params, which the default router lacks.
    await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <RouterProvider router={router} />
      </RegistryContext.Provider>,
      { router: false },
    ),
  );
  await vi.waitFor(() => expect(nameInput(screen)).not.toBeNull());
  stack.move();
  return { ...screen, router };
}

async function mountSettings(search: SettingsScopeSearch) {
  const searchParams = new URLSearchParams(
    Object.entries(search).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
  );
  const route = createRootRoute({
    validateSearch: validateSettingsScopeSearch,
    component: () => (
      <SettingsScopeProvider
        search={route.useSearch()}
        onChange={(next) => void router.navigate({ to: "/settings/projects", search: () => next })}
      >
        <I18nProvider>
          <ProjectsSettings />
        </I18nProvider>
      </SettingsScopeProvider>
    ),
  });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({
      initialEntries: [`/settings/projects?${searchParams.toString()}`],
    }),
  });
  await router.load();
  // The settings route tree above validates scope search params, which the default router lacks.
  const screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <RouterProvider router={router} />
    </RegistryContext.Provider>,
    { router: false },
  );
  return { ...screen, router };
}

const nameInput = (screen: Screen) =>
  screen.container.querySelector<HTMLInputElement>('[aria-label="Project name"]')!;
const removeCheckout = (screen: Screen, root: string) =>
  screen.container.querySelector<HTMLButtonElement>(`[aria-label="Remove checkout ${root}"]`)!;
const removeAll = (screen: Screen) =>
  [...screen.container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Remove all entries"),
  )!;

async function grant(id: EnvironmentId, result: SessionResult) {
  await act(async () => appAtomRegistry.set(state.sessions.get(id)!, result));
}

async function rename(screen: Screen, title: string) {
  await userEvent.fill(nameInput(screen), title);
  await userEvent.keyboard("{Enter}");
}

// The recheck reports the denial by toast; seeing it proves the recheck ran.
async function expectProjectAccessDeniedToast(title: string) {
  await vi.waitFor(() =>
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title,
        description: "This connection cannot change projects in remote.",
      }),
    ),
  );
  expect(state.toast).toHaveBeenCalledOnce();
}

describe("project organization", () => {
  it("archives the checkout on every machine while one machine is picked", async () => {
    setup();
    await using _screen = await mountPanel({ machine: primaryId });
    await userEvent.click(page.getByRole("button", { name: "Archive" }));
    await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
    expect(
      state.update.mock.calls.map(([request]) => [request.environmentId, request.input.archived]),
    ).toEqual([
      [primaryId, true],
      [remoteId, true],
    ]);
  });
});

describe("project settings permissions", () => {
  it("disables shared edits when any member lacks project access", async () => {
    setup();
    await grant(remoteId, AsyncResult.success(session([AuthSettingsWriteScope])));
    await using screen = await mountPanel();

    expect(nameInput(screen).disabled).toBe(true);
    expect(removeAll(screen).disabled).toBe(true);
    expect(screen.container.textContent).toContain(
      "Shared settings require permission to change every checkout in this group.",
    );
    expect(state.update).not.toHaveBeenCalled();
  });

  it("renames every member when all have project access without settings access", async () => {
    setup();
    await using screen = await mountPanel();
    await rename(screen, "Renamed");
    expect(state.update.mock.calls.map(([request]) => request.environmentId)).toEqual([
      primaryId,
      remoteId,
    ]);
    expect(nameInput(screen).value).toBe("Renamed");
  });

  it("stops before the next member if its grant is revoked during an earlier update", async () => {
    setup();
    const firstUpdate = deferred<AsyncResult.Success<void>>();
    state.update.mockReturnValueOnce(firstUpdate.promise);
    await using screen = await mountPanel();
    await rename(screen, "Renamed");
    expect(state.update).toHaveBeenCalledOnce();

    await grant(remoteId, AsyncResult.success(session([])));
    await act(async () => {
      firstUpdate.resolve(AsyncResult.success(undefined));
      await firstUpdate.promise;
    });
    await expectProjectAccessDeniedToast("Failed to rename project");
    expect(state.update).toHaveBeenCalledOnce();
    expect(state.update.mock.calls[0]![0].environmentId).toBe(primaryId);
  });

  it("disables removal for a checkout whose project grant is missing", async () => {
    setup();
    await grant(remoteId, AsyncResult.success(session([])));
    await using screen = await mountPanel();
    expect(removeCheckout(screen, "/work/remote").disabled).toBe(true);
    expect(removeCheckout(screen, "/work/primary").disabled).toBe(false);
  });

  it("removes a writable checkout while removal of the mixed group stays denied", async () => {
    setup();
    await grant(remoteId, AsyncResult.success(session([])));
    await using screen = await mountPanel();
    const initialHref = screen.router.state.location.href;
    expect(removeAll(screen).disabled).toBe(true);

    await userEvent.click(removeCheckout(screen, "/work/primary"));
    await vi.waitFor(() => expect(state.delete).toHaveBeenCalledOnce());
    expect(state.delete).toHaveBeenCalledWith({
      environmentId: primaryId,
      input: { projectId: state.projects[0]!.id, force: true },
    });
    await vi.waitFor(() => expect(state.releaseUploads).toHaveBeenCalledOnce());
    expect(state.clearDraft).toHaveBeenCalledOnce();
    expect(screen.router.state.location.href).toBe(initialHref);
  });

  it("moves a draft on the removed checkout to a remaining checkout of the group", async () => {
    setup();
    const draftId = DraftId.make("draft-handed-off");
    const [primaryProject, remoteProject] = state.projects;
    const drafts = useComposerDraftStore.getState();
    drafts.setLogicalProjectDraftThreadId(
      "github.com/example/shared-repo",
      scopeProjectRef(primaryId, primaryProject!.id),
      draftId,
    );
    // "Add to another machine" hands the open draft to the new checkout this way.
    drafts.setDraftThreadContext(draftId, {
      projectRef: scopeProjectRef(remoteId, remoteProject!.id),
      environmentSelection: "manual",
      loadBalancedEnvironmentId: null,
    });
    drafts.setPrompt(draftId, "keep this prompt");
    await using screen = await mountPanel();

    await userEvent.click(removeCheckout(screen, "/work/remote"));
    await vi.waitFor(() => expect(state.releaseUploads).toHaveBeenCalledOnce());

    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
      environmentId: primaryId,
      projectId: primaryProject!.id,
    });
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
      "keep this prompt",
    );
  });

  it("rechecks every removal target after confirmation before deleting or clearing drafts", async () => {
    setup();
    const confirmed = deferred<boolean>();
    state.confirm.mockReturnValueOnce(confirmed.promise);
    await using screen = await mountPanel();
    await userEvent.click(removeAll(screen));
    expect(state.confirm).toHaveBeenCalledOnce();

    await grant(remoteId, AsyncResult.success(session([])));
    await act(async () => {
      confirmed.resolve(true);
      await confirmed.promise;
    });
    await expectProjectAccessDeniedToast("Failed to remove project");
    expect(state.delete).not.toHaveBeenCalled();
    expect(state.releaseUploads).not.toHaveBeenCalled();
    expect(state.clearDraft).not.toHaveBeenCalled();
  });

  it("does not save an edit whose grant was revoked mid-edit, and recovers when restored", async () => {
    setup();
    await using screen = await mountPanel();
    await userEvent.fill(nameInput(screen), "Renamed");
    await grant(remoteId, AsyncResult.success(session([])));
    // Chromium takes focus off a newly disabled input without firing blur. Send the
    // focusout so the save attempt runs and hits the same recheck as a real blur.
    await act(async () => {
      nameInput(screen).dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await expectProjectAccessDeniedToast("Failed to rename project");
    expect(state.update).not.toHaveBeenCalled();
    expect(nameInput(screen).disabled).toBe(true);

    await grant(remoteId, writable());
    expect(nameInput(screen).disabled).toBe(false);
    await rename(screen, "Recovered");
    await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
    expect(nameInput(screen).value).toBe("Recovered");
  });

  it.each([
    ["loading", () => AsyncResult.initial<AuthSessionState, Error>(), false],
    [
      "failed",
      () => AsyncResult.failure<AuthSessionState, Error>(Cause.fail(new Error("Disconnected"))),
      false,
    ],
    ["refreshing", () => AsyncResult.waiting(writable()), true],
  ] as const)(
    "uses the current grant while a member's session is %s",
    async (_state, result, allowed) => {
      setup();
      await grant(remoteId, result());
      await using screen = await mountPanel();
      expect(nameInput(screen).disabled).toBe(!allowed);
      if (!allowed) return;
      await rename(screen, "Renamed");
      expect(state.update).toHaveBeenCalledTimes(2);
    },
  );
});

describe("project identity reset", () => {
  const scratchIcon = { kind: "lucide", name: "message-square-dashed", color: "gray" } as const;
  const resetButton = (screen: Screen, label: string) =>
    screen.container.querySelector<HTMLButtonElement>(`[aria-label="Reset ${label} to default"]`);
  const asScratch = (project: Project): Project => ({
    ...project,
    isScratch: true,
    title: "Notes",
    workspaceRoot: "/t3/scratch",
    projectIcon: { kind: "emoji", emoji: "📝" },
  });

  it("restores a renamed scratch project's built-in name and icon", async () => {
    setup();
    state.projects = [{ ...asScratch(state.projects[0]!), faviconPath: null, projectIcon: null }];
    await using screen = await mountPanel();

    await userEvent.click(resetButton(screen, "project name")!);
    await vi.waitFor(() =>
      expect(state.update).toHaveBeenCalledWith({
        environmentId: primaryId,
        input: { projectId: state.projects[0]!.id, title: "No project" },
      }),
    );
    await userEvent.click(resetButton(screen, "project icon")!);
    await vi.waitFor(() =>
      expect(state.update).toHaveBeenLastCalledWith({
        environmentId: primaryId,
        input: { projectId: state.projects[0]!.id, faviconPath: null, projectIcon: scratchIcon },
      }),
    );
  });

  it("resets each member of a mixed group to its own default icon", async () => {
    setup();
    const [primary, remote] = state.projects;
    state.projects = [asScratch(primary!), { ...remote!, faviconPath: "logo.png" }];
    await using screen = await mountPanel();

    expect(resetButton(screen, "project name")).toBeNull();
    await userEvent.click(resetButton(screen, "project icon")!);
    await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
    expect(state.update.mock.calls.map(([request]) => request)).toEqual([
      {
        environmentId: primaryId,
        input: { projectId: primary!.id, faviconPath: null, projectIcon: scratchIcon },
      },
      {
        environmentId: remoteId,
        input: { projectId: remote!.id, faviconPath: null, projectIcon: null },
      },
    ]);
  });

  it("refreshes a saved checkout's icon when a later checkout update fails", async () => {
    setup();
    state.projects = state.projects.map((project) => ({ ...project, faviconPath: "logo.png" }));
    let iconExists = false;
    const iconUrl = Atom.make(() =>
      AsyncResult.success({
        expiresAt: 4_000_000_000_000,
        relativeUrl: iconExists ? "/restored-icon.svg" : "/project-favicon-missing",
      }),
    );
    using _mount = { [Symbol.dispose]: appAtomRegistry.mount(iconUrl) };
    const createUrl = assetEnvironment.createUrl;
    using _createUrl = vi
      .spyOn(assetEnvironment, "createUrl")
      .mockImplementation((target) =>
        target.environmentId === primaryId ? iconUrl : createUrl(target),
      );
    state.update
      .mockResolvedValueOnce(AsyncResult.success(undefined))
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Save failed"))));
    await using screen = await mountPanel();
    expect(appAtomRegistry.get(iconUrl).value.relativeUrl).toBe("/project-favicon-missing");

    iconExists = true;
    await userEvent.click(resetButton(screen, "project icon")!);

    await vi.waitFor(() =>
      expect(appAtomRegistry.get(iconUrl).value.relativeUrl).toBe("/restored-icon.svg"),
    );
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to update project icon on remote" }),
    );
  });
});

it("opens the fallback search target across all environments from a checkout", async () => {
  setup();
  const root = createRootRoute();
  const settings = createRoute({
    getParentRoute: () => root,
    path: "settings",
    validateSearch: validateSettingsRouteSearch,
    search: { middlewares: [retainSettingsScope] },
  });
  const threads = createRoute({
    getParentRoute: () => settings,
    path: "threads",
    component: () => (
      <SettingsScopeProvider search={settings.useSearch()} onChange={() => {}}>
        <SettingsScopeNotice target="all" targetId="fallback-model">
          Choose all environments to edit the fallback model.
        </SettingsScopeNotice>
      </SettingsScopeProvider>
    ),
  });
  const query = new URLSearchParams({
    project: projectKey(),
    machine: primaryId,
    checkout: "primary:/work/primary",
  });
  const router = createRouter({
    routeTree: root.addChildren([settings.addChildren([threads])]),
    history: createMemoryHistory({ initialEntries: [`/settings/threads?${query}#fallback-model`] }),
  });
  await router.load();
  // This route needs the real scope-retention middleware used by settings search.
  await using _screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <RouterProvider router={router} />
    </RegistryContext.Provider>,
    { router: false },
  );
  await userEvent.click(page.getByRole("button", { name: "Open all environments" }));
  await vi.waitFor(() => expect(router.state.location.search).toEqual({}));
  expect(router.state.location.hash).toBe("fallback-model");
});

describe("project settings scope", () => {
  const environmentMenu = () => page.getByRole("button", { name: /^Environment scope:/ });
  const primaryOption = () => page.getByRole("menuitemradio", { name: /^primary/ });
  const remoteOption = () => page.getByRole("menuitemradio", { name: /^remote/ });

  it("offers every environment while no project is selected", async () => {
    setup();
    state.projects = state.projects.filter((project) => project.environmentId === primaryId);
    await using _screen = await mountSettings({});

    await userEvent.click(environmentMenu());
    await expect.element(primaryOption()).toBeVisible();
    await expect.element(remoteOption()).toBeVisible();
  });

  it("lists only the selected environment's projects and keeps it when one is opened", async () => {
    setup();
    const [primaryProject, remoteProject] = state.projects;
    state.projects = [
      primaryProject!,
      {
        ...remoteProject!,
        title: "Remote only",
        repositoryIdentity: null,
      },
    ];
    await using screen = await mountSettings({ machine: primaryId });

    await expect.element(page.getByRole("button", { name: /^Shared repo/ })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /^Remote only/ }))
      .not.toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: /^Shared repo/ }));
    await vi.waitFor(() =>
      expect(screen.router.state.location.search).toEqual({
        project: projectKey(),
        machine: primaryId,
      }),
    );
  });

  it("offers only the selected project's checkout environments", async () => {
    setup();
    state.projects = state.projects.filter((project) => project.environmentId === primaryId);
    await using _screen = await mountSettings({ project: projectKey() });

    await expect.element(page.getByRole("textbox", { name: "Project name" })).toBeVisible();
    await userEvent.click(environmentMenu());
    await expect.element(primaryOption()).toBeVisible();
    await expect.element(remoteOption()).not.toBeInTheDocument();
  });

  it("reaches each checkout on one environment and returns to all of them", async () => {
    setup();
    const [first] = state.projects;
    state.projects = [
      { ...first!, id: ProjectId.make("clone-a"), workspaceRoot: "/work/clone-a" },
      { ...first!, id: ProjectId.make("clone-b"), workspaceRoot: "/work/clone-b" },
    ];
    const key = projectKey();
    await using screen = await mountSettings({ project: key, machine: primaryId });

    await userEvent.click(page.getByRole("button", { name: "Checkout scope: All checkouts" }));
    await userEvent.click(page.getByRole("menuitemradio", { name: /clone-b/ }));

    await expect
      .element(page.getByRole("button", { name: "Checkout scope: clone-b" }))
      .toBeVisible();
    expect(screen.router.state.location.search).toMatchObject({
      project: key,
      machine: primaryId,
      checkout: expect.stringContaining("clone-b"),
    });

    await userEvent.click(page.getByRole("button", { name: "Checkout scope: clone-b" }));
    await userEvent.click(page.getByRole("menuitemradio", { name: "All checkouts" }));

    await vi.waitFor(() =>
      expect(screen.router.state.location.search).toEqual({ project: key, machine: primaryId }),
    );
  });

  it("keeps an unknown project recoverable from any environment", async () => {
    setup();
    state.projects = state.projects.filter((project) => project.environmentId === primaryId);
    await using screen = await mountSettings({ project: "removed-project" });

    await userEvent.click(environmentMenu());
    await expect.element(primaryOption()).toBeVisible();
    await expect.element(remoteOption()).toBeVisible();
    await userEvent.click(remoteOption());
    await vi.waitFor(() =>
      expect(screen.router.state.location.search).toEqual({
        project: "removed-project",
        machine: remoteId,
      }),
    );
  });

  it.each([
    [undefined, "This project has no checkout on this environment."],
    [
      "removed-checkout",
      "This checkout is no longer available in the selected project and environment.",
    ],
  ])("recovers a stale environment link with checkout %s", async (checkout, message) => {
    setup();
    state.projects = state.projects.filter((project) => project.environmentId === primaryId);
    const key = projectKey();
    await using screen = await mountSettings({
      project: key,
      machine: remoteId,
      ...(checkout ? { checkout } : {}),
    });

    await expect.element(page.getByText(message, { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: /^Project scope:/ })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Environment scope: remote" }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Show all environments" }));

    await expect
      .element(page.getByRole("textbox", { name: "Project name" }))
      .toHaveValue("Shared repo");
    expect(screen.router.state.location.search).toEqual({ project: key });
    await expect
      .element(page.getByRole("button", { name: "Environment scope: All environments" }))
      .toBeVisible();
    await expect.element(page.getByText(message, { exact: true })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Remove project", exact: true }))
      .toBeEnabled();
  });
});

describe("Suggest actions setting", () => {
  const toggle = () => page.getByRole("switch", { name: "Suggest actions" });
  const reset = () => page.getByRole("button", { name: "Reset Suggest actions to default" });
  const withSuggestions = (suggestProjectActions: boolean) => ({
    ...DEFAULT_SERVER_SETTINGS,
    suggestProjectActions,
  });

  async function allowSettingsWrites() {
    for (const id of [primaryId, remoteId]) {
      await grant(id, AsyncResult.success(session([AuthSettingsWriteScope])));
    }
  }

  async function publishSettings(
    environmentIds: readonly EnvironmentId[],
    settings: ServerSettings,
  ) {
    await act(() =>
      appAtomRegistry.update(environmentsAtom, (environments) =>
        environments.map((environment) =>
          environmentIds.includes(environment.environmentId)
            ? { ...environment, serverConfig: { ...environment.serverConfig, settings } }
            : environment,
        ),
      ),
    );
  }

  it("keeps each global change visible while saving, including a toggle queued behind a save", async () => {
    setup();
    state.projects = [];
    await allowSettingsWrites();
    const disable = deferred<SettingsResult>();
    const enable = deferred<SettingsResult>();
    state.updateSettings.mockReturnValueOnce(disable.promise).mockReturnValueOnce(enable.promise);
    await using _screen = await mountSettings({ machine: primaryId });

    await expect.element(toggle()).toBeChecked();
    await userEvent.click(toggle());
    await expect.element(toggle()).not.toBeChecked();
    expect(appAtomRegistry.get(fixtureConfigAtom(primaryId))?.settings.suggestProjectActions).toBe(
      true,
    );
    expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({
      environmentId: primaryId,
      input: { patch: { suggestProjectActions: false } },
    });

    await userEvent.click(toggle());
    await expect.element(toggle()).toBeChecked();
    expect(state.updateSettings).toHaveBeenCalledOnce();
    await act(() => disable.resolve(AsyncResult.success(withSuggestions(false))));
    expect(state.updateSettings).toHaveBeenLastCalledWith({
      environmentId: primaryId,
      input: { patch: { suggestProjectActions: true } },
    });
    await expect.element(toggle()).toBeChecked();
    await act(() => enable.resolve(AsyncResult.success(withSuggestions(true))));
    await expect.element(toggle()).toBeChecked();
    expect(state.toast).not.toHaveBeenCalled();
  });

  it("saves globally on every environment and resets to the built-in default", async () => {
    setup();
    await allowSettingsWrites();
    state.updateSettings.mockResolvedValue(AsyncResult.success(withSuggestions(false)));
    await using _screen = await mountSettings({});

    await userEvent.click(toggle());
    await vi.waitFor(() => expect(state.updateSettings).toHaveBeenCalledTimes(2));
    expect(state.updateSettings.mock.calls).toEqual(
      [primaryId, remoteId].map((environmentId) => [
        { environmentId, input: { patch: { suggestProjectActions: false } } },
      ]),
    );
    await expect.element(toggle()).not.toBeChecked();
    await expect.element(reset()).toBeEnabled();
    await publishSettings([primaryId, remoteId], withSuggestions(false));
    state.updateSettings.mockResolvedValue(AsyncResult.success(withSuggestions(true)));
    await userEvent.click(reset());
    await vi.waitFor(() => expect(state.updateSettings).toHaveBeenCalledTimes(4));
    expect(state.updateSettings.mock.calls.slice(2)).toEqual(
      [primaryId, remoteId].map((environmentId) => [
        { environmentId, input: { patch: { suggestProjectActions: true } } },
      ]),
    );
    await expect.element(toggle()).toBeChecked();
  });

  it.each([
    [
      "a rejected save",
      AsyncResult.failure<ServerSettings, Error>(Cause.fail(new Error("Save rejected"))),
      "Save rejected",
    ],
    [
      "an interrupted save",
      AsyncResult.failure<ServerSettings, Error>(Cause.interrupt()),
      "All fibers interrupted without error",
    ],
    [
      "an unsupported setting",
      AsyncResult.success(DEFAULT_SERVER_SETTINGS),
      "does not support this setting",
    ],
  ] as const)("restores the stored value after %s", async (_case, result, message) => {
    setup();
    await allowSettingsWrites();
    const save = deferred<SettingsResult>();
    state.updateSettings.mockReturnValueOnce(save.promise);
    await using _screen = await mountSettings({ machine: remoteId });

    await userEvent.click(toggle());
    await expect.element(toggle()).not.toBeChecked();
    await act(() => save.resolve(result));
    await expect.element(toggle()).toBeChecked();
    await vi.waitFor(() =>
      expect(state.toast).toHaveBeenCalledExactlyOnceWith({
        type: "error",
        title: "Setting not saved",
        description: expect.stringContaining(message),
      }),
    );
  });

  it.each([undefined, "primary:/work/primary"])(
    "saves and clears an override in the selected project scope (%s)",
    async (checkout) => {
      setup();
      await allowSettingsWrites();
      const id = state.projects[0]!.id;
      const patch = { projectSettingsOverrides: { [id]: { suggestProjectActions: false } } };
      const saved = { ...DEFAULT_SERVER_SETTINGS, ...patch };
      state.updateSettings.mockResolvedValueOnce(AsyncResult.success(saved));
      await using _screen = await mountSettings({
        project: projectKey(),
        machine: primaryId,
        checkout,
      });

      await expect.element(toggle()).toBeChecked();
      await userEvent.click(toggle());
      await vi.waitFor(() =>
        expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({
          environmentId: primaryId,
          input: { patch },
        }),
      );
      await expect.element(toggle()).not.toBeChecked();
      await publishSettings([primaryId], saved);
      await userEvent.click(reset());
      await vi.waitFor(() =>
        expect(state.updateSettings).toHaveBeenLastCalledWith({
          environmentId: primaryId,
          input: { patch: { projectSettingsOverrides: { [id]: null } } },
        }),
      );
      await expect.element(toggle()).toBeChecked();
    },
  );

  it("disables the switch when the selected environment cannot write settings", async () => {
    setup();
    await using screen = await mountSettings({ machine: remoteId });
    const switchElement = screen.container.querySelector<HTMLElement>(
      '[aria-label="Suggest actions"][role="switch"]',
    );
    expect(switchElement).not.toBeNull();
    await expect.element(switchElement).toHaveAttribute("data-disabled");
    expect(state.updateSettings).not.toHaveBeenCalled();
  });
});

const suggestedAction: ProjectScript = {
  id: "test",
  name: "Run tests",
  command: "make test",
  icon: "test",
  runOnWorktreeCreate: false,
};

type SuggestionInput = Parameters<typeof useProjectScriptEditing>[0];
const suggestionInput = (project: Project | null, scripts: readonly ProjectScript[] = []) => ({
  environmentId: project?.environmentId ?? primaryId,
  project,
  scripts,
  settings: DEFAULT_UNIFIED_SETTINGS,
});

function SuggestionProbe({
  input,
  onController,
}: {
  input: SuggestionInput;
  onController: (controller: ProjectActionSuggestionsController) => void;
}) {
  onController(useProjectScriptEditing(input).projectActionSuggestions);
  return null;
}

async function mountSuggestionController(input: SuggestionInput) {
  let controller: ProjectActionSuggestionsController;
  const view = (value: SuggestionInput) => (
    <RegistryContext.Provider value={appAtomRegistry}>
      <SuggestionProbe
        input={value}
        onController={(next) => {
          controller = next;
        }}
      />
    </RegistryContext.Provider>
  );
  const screen = await render(view(input));
  return {
    ...screen,
    get controller() {
      return controller;
    },
    select: (next: SuggestionInput) => screen.rerender(view(next)),
  };
}

describe("project action suggestions controller", () => {
  it("resolves the project override and requires a project and the destination's settings grant", async () => {
    setup();
    const project = { ...state.projects[1]!, title: "acme-app" };
    const input = suggestionInput(project);
    await using screen = await mountSuggestionController(input);
    expect(screen.controller).toMatchObject({ projectName: "acme-app", available: false });
    await grant(remoteId, AsyncResult.success(session([AuthSettingsWriteScope])));
    expect(screen.controller.available).toBe(true);

    const settings = (global: boolean, override?: boolean) => ({
      ...DEFAULT_UNIFIED_SETTINGS,
      suggestProjectActions: global,
      projectSettingsOverrides:
        override === undefined ? {} : { [project.id]: { suggestProjectActions: override } },
    });
    await screen.select({ ...input, settings: settings(true, false) });
    expect(screen.controller.available).toBe(false);
    await expect(screen.controller.suggest("manual")).resolves.toEqual({ _tag: "Skipped" });
    await screen.select({ ...input, settings: settings(false) });
    expect(screen.controller.available).toBe(false);
    await screen.select({ ...input, settings: settings(false, true) });
    expect(screen.controller.available).toBe(true);
    await screen.select({ ...input, project: null });
    expect(screen.controller).toMatchObject({ projectName: null, available: false });
    await expect(screen.controller.suggest("manual")).resolves.toEqual({ _tag: "Skipped" });
    expect(state.suggest).not.toHaveBeenCalled();
  });

  it.each([
    [
      AsyncResult.success<ProjectActionsSuggestResult>({
        _tag: "Added",
        scripts: [suggestedAction],
      }),
      { _tag: "Added", projectId: ProjectId.make("project-remote"), scripts: [suggestedAction] },
    ],
    [
      AsyncResult.success<ProjectActionsSuggestResult>({ _tag: "Skipped", reason: "in-progress" }),
      { _tag: "Skipped" },
    ],
    [
      AsyncResult.success<ProjectActionsSuggestResult>({ _tag: "NoneFound" }),
      { _tag: "NoneFound" },
    ],
    [
      AsyncResult.failure<ProjectActionsSuggestResult, Error>(
        Cause.fail(new Error("Model unavailable")),
      ),
      { _tag: "Failed", message: "Model unavailable" },
    ],
    [
      AsyncResult.failure<ProjectActionsSuggestResult, Error>(Cause.interrupt()),
      { _tag: "Skipped" },
    ],
  ] as const)("stays busy until the RPC settles as %j", async (reply, outcome) => {
    setup();
    await grant(remoteId, AsyncResult.success(session([AuthSettingsWriteScope])));
    const project = state.projects[1]!;
    const response = deferred<SuggestResult>();
    state.suggest.mockReturnValueOnce(response.promise);
    await using screen = await mountSuggestionController(suggestionInput(project));

    let pending!: Promise<ProjectActionSuggestOutcome>;
    await act(() => {
      pending = screen.controller.suggest("manual");
    });
    expect(screen.controller).toMatchObject({ suggesting: true, autoAttempted: false });
    expect(state.suggest).toHaveBeenCalledExactlyOnceWith({
      environmentId: remoteId,
      input: { projectId: project.id, trigger: "manual" },
    });
    await act(async () => {
      response.resolve(reply);
      expect(await pending).toEqual(outcome);
    });
    expect(screen.controller.suggesting).toBe(false);
  });

  it("keeps automatic attempts and pending requests scoped to their project", async () => {
    setup();
    for (const id of [primaryId, remoteId]) {
      await grant(id, AsyncResult.success(session([AuthSettingsWriteScope])));
    }
    const primary = suggestionInput(state.projects[0]!);
    const remote = suggestionInput(state.projects[1]!);
    const first = deferred<SuggestResult>();
    const second = deferred<SuggestResult>();
    const none = AsyncResult.success({ _tag: "NoneFound" } as const);
    state.suggest.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await using screen = await mountSuggestionController(primary);

    let duplicate!: Promise<ProjectActionSuggestOutcome>;
    await act(() => {
      void screen.controller.suggest("auto");
      duplicate = screen.controller.suggest("auto");
    });
    expect(state.suggest).toHaveBeenCalledOnce();
    await expect(duplicate).resolves.toEqual({ _tag: "Skipped" });
    expect(screen.controller).toMatchObject({ suggesting: true, autoAttempted: true });
    await screen.select(remote);
    expect(screen.controller).toMatchObject({ suggesting: false, autoAttempted: false });
    await act(() => {
      void screen.controller.suggest("manual");
    });
    expect(screen.controller.suggesting).toBe(true);
    await act(() => second.resolve(none));
    await screen.select(primary);
    expect(screen.controller).toMatchObject({ suggesting: true, autoAttempted: true });
    await act(() => first.resolve(none));
    expect(screen.controller).toMatchObject({ suggesting: false, autoAttempted: true });
    expect(await screen.controller.suggest("auto")).toEqual({ _tag: "Skipped" });
    expect(state.suggest.mock.calls).toEqual([
      [{ environmentId: primaryId, input: { projectId: primary.project!.id, trigger: "auto" } }],
      [{ environmentId: remoteId, input: { projectId: remote.project!.id, trigger: "manual" } }],
    ]);
  });

  it("persists Undo through the actions override and preserves edited, unrelated and same-command actions", async () => {
    setup();
    const project = state.projects[0]!;
    const edited = { ...suggestedAction, id: "lint", command: "make check" };
    const sameCommand = { ...suggestedAction, id: "other-test" };
    const unrelated = { ...suggestedAction, id: "build", command: "make build" };
    const keep = [edited, sameCommand, unrelated];
    const input = suggestionInput(project, [suggestedAction, ...keep]);
    await using screen = await mountSuggestionController({
      ...input,
      settings: {
        ...input.settings,
        projectSettingsOverrides: { [project.id]: { suggestProjectActions: false } },
      },
    });

    await expect(
      screen.controller.undo(project.id, [
        suggestedAction,
        { ...edited, command: "make lint" },
        { ...suggestedAction, id: "missing", command: "make dev" },
      ]),
    ).resolves.toMatchObject({ _tag: "Success" });
    expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({
      environmentId: primaryId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [project.id]: { suggestProjectActions: false, defaultProjectScripts: keep },
          },
        },
      },
    });
    expect(state.upsertKeybinding).not.toHaveBeenCalled();
    expect(state.removeKeybinding).not.toHaveBeenCalled();
  });

  it("undoes the suggested project's actions, not the active project's, after a switch", async () => {
    setup();
    const suggestedFor = state.projects[0]!;
    const active = { ...suggestedFor, id: ProjectId.make("project-active") };
    state.projects = [suggestedFor, active];
    const mine = { ...suggestedAction, id: "build", command: "make build" };
    const activeScripts = [suggestedAction, { ...mine, command: "make all" }];
    const settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      projectSettingsOverrides: {
        [suggestedFor.id]: { defaultProjectScripts: [suggestedAction, mine] },
        [active.id]: { defaultProjectScripts: activeScripts },
      },
    };
    await using screen = await mountSuggestionController({
      ...suggestionInput(active, activeScripts),
      settings,
    });

    await expect(screen.controller.undo(suggestedFor.id, [suggestedAction])).resolves.toMatchObject(
      { _tag: "Success" },
    );

    expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({
      environmentId: primaryId,
      input: {
        patch: {
          projectSettingsOverrides: { [suggestedFor.id]: { defaultProjectScripts: [mine] } },
        },
      },
    });
  });
});

it("returns to the project overview after removal, clearing the selection but keeping the environment", async () => {
  setup();
  state.projects = [state.projects[1]!];
  await using screen = await mountPanel({ machine: remoteId, checkout: "remote:/work/remote" });
  const removeProject = [...screen.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Remove project",
  )!;

  await userEvent.click(removeProject);

  await vi.waitFor(() => {
    expect(screen.router.state.location.pathname).toBe("/settings/projects");
    expect(screen.router.state.location.search).toEqual({ machine: remoteId });
  });
});

describe("project name composition", () => {
  it.each([
    { isComposing: true, keyCode: 13 },
    { isComposing: false, keyCode: 229 },
  ])("does not save a partial name for $isComposing/$keyCode", async (composition) => {
    setup();
    await using screen = await mountPanel();
    const input = nameInput(screen);
    await userEvent.fill(input, "日本");
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...composition }),
      );
    });
    expect(state.update).not.toHaveBeenCalled();
    await expect.element(input).toHaveFocus();

    await userEvent.type(input, "語");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
    expect(state.projects.map((project) => project.title)).toEqual(["日本語", "日本語"]);
    await expect.element(nameInput(screen)).toHaveValue("日本語");

    await userEvent.fill(nameInput(screen), "日本語の名前");
    await userEvent.keyboard("{Tab}");
    await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(4));
    expect(state.projects.map((project) => project.title)).toEqual([
      "日本語の名前",
      "日本語の名前",
    ]);
  });
});
