import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type {
  DesktopPreviewBridge,
  EnvironmentId,
  Iter8Note,
  Iter8Page,
  Iter8ReviewSnapshot,
  Iter8SendRefusal,
  PreviewAnnotationSubmissionResult,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { toastManager } from "~/components/ui/toast";
import { isEditableFocused } from "~/lib/editableFocus";
import { isMacPlatform, randomUUID } from "~/lib/utils";
import { createIter8Note, deleteIter8Note, sendIter8Round, updateIter8Note } from "~/rpc/iter8";
import { useAtomCommand } from "~/state/use-atom-command";
import { Iter8ReviewBar } from "./Iter8ReviewBar";
import { type Iter8PaneView, Iter8ReviewPane } from "./Iter8ReviewPane";
import {
  createNoteInput,
  groupNotesByPath,
  reviewPins,
  roundStatus,
  sendAvailability,
} from "./iter8Review.logic";
import { useIter8Review, useIter8RoundLabel } from "./useIter8Review";

export type Iter8ReviewPins = Parameters<DesktopPreviewBridge["setReviewPins"]>[1];

interface Refusal {
  readonly pageId: string;
  readonly stateKey: string;
  readonly reason: Iter8SendRefusal;
}

/** iter8 serves every page it reviews from `http://<page>.localhost:<port>`. */
function looksLikeIter8Url(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && parsed.hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** What a refusal was about: it stops applying once any of this changes. */
function refusalStateKey(snapshot: Iter8ReviewSnapshot, page: Iter8Page): string {
  const owner = snapshot.sessions.find((session) => session.ownerId === page.ownerId);
  return JSON.stringify([
    page.ownerId,
    owner?.state ?? null,
    page.rounds.map((round) => [round.id, round.stage]),
    page.notes.map((note) => [note.id, note.status, note.roundId, note.intent, note.body]),
  ]);
}

export function Iter8ReviewFrame({
  environmentId,
  url,
  children,
  pickNote,
  cancelPickNote,
  setPins,
  pinsTargetId,
  navigate,
  openExternally,
}: {
  environmentId: EnvironmentId;
  url: string;
  children: ReactNode;
  /** Null where the browser cannot pick elements: web, and server-rendered tabs. */
  pickNote: (() => Promise<PreviewAnnotationSubmissionResult | null>) | null;
  cancelPickNote: (() => void) | null;
  setPins: ((pins: Iter8ReviewPins) => void) | null;
  /** Names the guest `setPins` draws on, so a tab switch re-sends pins that did not change. */
  pinsTargetId: string | null;
  navigate: (url: string) => void;
  openExternally: (url: string) => void;
}) {
  const gt = useGT();
  const review = useIter8Review(environmentId, url);
  const roundLabel = useIter8RoundLabel();
  const canCreate = useAtomValue(createIter8Note.permissionAtom(environmentId));
  const canUpdate = useAtomValue(updateIter8Note.permissionAtom(environmentId));
  const canDelete = useAtomValue(deleteIter8Note.permissionAtom(environmentId));
  const canSend = useAtomValue(sendIter8Round.permissionAtom(environmentId));
  const createNote = useAtomCommand(createIter8Note, { reportFailure: false });
  const sendRound = useAtomCommand(sendIter8Round, { reportFailure: false });
  const [view, setView] = useState<Iter8PaneView>("notes");
  const [focusedNoteId, setFocusedNoteId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [sendingPageId, setSendingPageId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [sentNoteIds, setSentNoteIds] = useState<ReadonlySet<string>>(() => new Set());
  const pickCancelRef = useRef<(() => void) | null>(null);

  const { match, snapshot, status } = review;
  const pins = match && setPins ? reviewPins(match.page, match.path, focusedNoteId) : null;
  const pinsKey = pins === null ? null : JSON.stringify(pins);
  const pinsShown = pins !== null;
  // The caller rebuilds its bridge callbacks on every render, so the effects key on the pins.
  const currentSetPins = useEffectEvent(() => setPins);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the desktop guest draws the pins over the page, outside React
  useEffect(() => {
    const target = currentSetPins();
    if (pinsKey === null || target === null || pinsTargetId === null) return;
    const next: Iter8ReviewPins = JSON.parse(pinsKey);
    target(next);
  }, [pinsKey, pinsTargetId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the guest keeps its pins, and iter8's own overlay hidden, until told the dock is gone
  useEffect(() => {
    const target = currentSetPins();
    if (!pinsShown || target === null || pinsTargetId === null) return;
    return () => target(null);
  }, [pinsShown, pinsTargetId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a pick runs in the desktop guest and must end when the dock unmounts
  useEffect(() => () => pickCancelRef.current?.(), []);

  const paneProps = {
    environmentId,
    snapshot,
    match,
    view,
    canAddNotes: pickNote !== null,
    canUpdate,
    canDelete,
    focusedNoteId,
    onViewChange: setView,
    onSelectNote: (note: Iter8Note) => {
      setFocusedNoteId(note.id);
      const notePath = note.path ?? "/";
      if (match !== null && notePath !== match.path) navigate(match.page.origin + notePath);
    },
    onNavigate: navigate,
    onRetry: review.retry,
  };

  // Fixed slots keep the page at the same child position, so the dock appearing or going away
  // never remounts the webview.
  if (match === null || snapshot === null) {
    const failedBeforeFirstRead =
      status === "failed" && snapshot === null && looksLikeIter8Url(url);
    return (
      <>
        {null}
        {children}
        {failedBeforeFirstRead ? (
          <Iter8ReviewPane {...paneProps} failed onKeyDown={() => {}} />
        ) : null}
      </>
    );
  }

  const { page, path } = match;
  const availability = sendAvailability(snapshot, {
    ...page,
    notes: page.notes.filter((item) => !sentNoteIds.has(item.id)),
  });
  const stateKey = refusalStateKey(snapshot, page);
  const activeRefusal =
    refusal !== null && refusal.pageId === page.id && refusal.stateKey === stateKey
      ? refusal.reason
      : null;
  const sessionReason = (reason: "no-session" | "session-ended" | Iter8SendRefusal) =>
    reason === "no-session" || reason === "no-pairing"
      ? gt("No session owns this page")
      : reason === "session-ended" || reason === "session-gone"
        ? gt("The session that owns this page has ended")
        : gt("iter8 reopened this page since it loaded. Reload it, then send again.");
  const notice =
    activeRefusal !== null
      ? sessionReason(activeRefusal)
      : availability.kind === "blocked" && availability.reason !== "no-drafts"
        ? sessionReason(availability.reason)
        : null;
  const ready = availability.kind === "ready" && activeRefusal === null && canSend;
  const sending = sendingPageId === page.id;
  const shortcut = isMacPlatform(navigator.platform) ? "⌘↵" : "Ctrl+Enter";
  const sendTooltip =
    notice ??
    (availability.kind === "ready"
      ? gt("Send {count, plural, one {# note} other {# notes}} as one round ({shortcut})", {
          count: availability.draftCount,
          shortcut,
        })
      : gt("Add a note first"));
  const paths = [...new Set(["/", path, ...groupNotesByPath(page).map((group) => group.path)])];

  const send = async (idempotencyKey: string, draftIds: ReadonlyArray<string>) => {
    setSendingPageId(page.id);
    const result = await sendRound({ environmentId, input: { pageId: page.id, idempotencyKey } });
    setSendingPageId(null);
    if (result._tag === "Success") {
      if (result.value.outcome === "refused") {
        setRefusal({ pageId: page.id, stateKey, reason: result.value.reason });
      } else {
        setSentNoteIds((previous) => new Set([...previous, ...draftIds]));
      }
      return;
    }
    // An interrupted send dropped its connection mid-flight, so its outcome is unknown too.
    const toastId = toastManager.add({
      type: "error",
      title: gt("The round may not have been sent"),
      description: gt("Retrying can't send it twice."),
      actionProps: {
        children: gt("Retry"),
        onClick: () => {
          toastManager.close(toastId);
          void send(idempotencyKey, draftIds);
        },
      },
    });
  };

  const startSend = () => {
    if (!ready || sending) return;
    const draftIds = page.notes
      .filter(
        (item) =>
          item.status === "draft" && item.author.kind === "user" && !sentNoteIds.has(item.id),
      )
      .map((item) => item.id);
    void send(randomUUID(), draftIds);
  };

  const addNote = async () => {
    if (pickNote === null) return;
    if (picking) {
      cancelPickNote?.();
      return;
    }
    setPicking(true);
    pickCancelRef.current = cancelPickNote;
    const picked = await pickNote().catch(() => "failed" as const);
    pickCancelRef.current = null;
    setPicking(false);
    if (picked === "failed") {
      toastManager.add({ type: "error", title: gt("Couldn't start adding a note") });
      return;
    }
    if (picked === null) return;
    const body = picked.annotation.comment.trim();
    const input = createNoteInput(page, picked.annotation);
    if (input === null) {
      if (body !== "") {
        toastManager.add({ type: "error", title: gt("Couldn't save the note"), description: body });
      }
      return;
    }
    const result = await createNote({ environmentId, input });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({ type: "error", title: gt("Couldn't save the note"), description: body });
    }
  };

  function onDockKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      startSend();
      return;
    }
    if (isEditableFocused(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape" && picking) {
      event.preventDefault();
      cancelPickNote?.();
    } else if ((event.key === "n" || event.key === "N") && pickNote !== null && canCreate) {
      event.preventDefault();
      void addNote();
    }
  }

  return (
    <>
      <Iter8ReviewBar
        path={path}
        paths={paths}
        roundLabel={roundLabel([page], roundStatus(page))}
        notice={notice}
        sendTooltip={sendTooltip}
        sendDisabled={!ready}
        sending={sending}
        picking={picking}
        addNoteDisabled={!canCreate}
        onAddNote={pickNote === null ? null : () => void addNote()}
        onOpenExternally={() => openExternally(url)}
        onSelectPath={(next) => navigate(page.origin + next)}
        onSend={startSend}
        onKeyDown={onDockKeyDown}
      />
      {children}
      <Iter8ReviewPane {...paneProps} failed={status === "failed"} onKeyDown={onDockKeyDown} />
    </>
  );
}
