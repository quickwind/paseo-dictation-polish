import type { PluginComposerItemProps } from "@getpaseo/plugin/client";
import { useComposer, useRpc, useTranslation } from "@getpaseo/plugin/client";
import { Action, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { polishRunRpc } from "../shared/rpc";
import { polishTranslations } from "./i18n";
import { SPARKLES_SLASH_SVG } from "./icons";
import { runComposerPolish, runComposerUndo } from "./polish-controller";
import {
  canUndoPolish,
  clearUndoEntry,
  getUndoEntry,
  shouldClearUndoEntry,
  subscribeUndoStore,
  type PolishUndoEntry,
} from "./undo-store";

export function ComposerPolishItem(_props: PluginComposerItemProps) {
  const composer = useComposer();
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const runPolish = useRpc(polishRunRpc);
  const toast = useToast();
  const { t } = useTranslation(polishTranslations);
  const slotIdRef = useRef<symbol | null>(null);
  if (slotIdRef.current === null) {
    slotIdRef.current = Symbol("composer-polish-slot");
  }
  const slotId = slotIdRef.current;
  const observedPolishedEntryRef = useRef<PolishUndoEntry | null>(null);

  const undoEntry = useSyncExternalStore(
    subscribeUndoStore,
    () => getUndoEntry(composer, slotId),
    () => getUndoEntry(composer, slotId),
  );

  const showUndo = canUndoPolish(composer.prompt, undoEntry);

  useEffect(() => {
    if (undoEntry === undefined) {
      observedPolishedEntryRef.current = null;
      return;
    }

    if (showUndo) {
      observedPolishedEntryRef.current = undoEntry;
      return;
    }

    const hasObservedPolished = observedPolishedEntryRef.current === undoEntry;
    if (
      shouldClearUndoEntry({
        currentPrompt: composer.prompt,
        entry: undoEntry,
        hasObservedPolished,
      })
    ) {
      observedPolishedEntryRef.current = null;
      clearUndoEntry(composer, slotId);
    }
  }, [composer, slotId, undoEntry, showUndo]);

  useEffect(() => {
    return () => {
      clearUndoEntry(composer, slotId);
    };
  }, [slotId]);

  const isEmpty = composer.prompt.trim().length === 0;

  if (showUndo) {
    return (
      <Action
        title={t("composer.undoPolish")}
        icon={{ svg: SPARKLES_SLASH_SVG }}
        onPress={() =>
          runComposerUndo({
            composer,
            entry: undoEntry,
            slotId,
          }).then(() => undefined)
        }
      />
    );
  }

  return (
    <Action
      title={t("composer.polish")}
      icon="Sparkles"
      disabled={isEmpty}
      onPress={() =>
        runComposerPolish({
          composer,
          getLatestComposer: () => composerRef.current,
          runPolish,
          notify: toast,
          slotId,
          messages: {
            raceAborted: t("toast.raceAborted"),
            fallback: (reason) => t("toast.fallback", { reason }),
            fallbackUnknown: t("toast.fallbackUnknown"),
            error: t("toast.error"),
          },
        }).then(() => undefined)
      }
    />
  );
}
