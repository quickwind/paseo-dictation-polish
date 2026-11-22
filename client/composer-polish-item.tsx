import type { PluginComposerItemProps } from "@getpaseo/plugin/client";
import { useComposer, useRpc, useTranslation } from "@getpaseo/plugin/client";
import { Action, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { polishRunRpc } from "../shared/rpc";
import { polishTranslations } from "./i18n";
import { runComposerPolish, runComposerUndo } from "./polish-controller";
import {
  canUndoPolish,
  clearUndoEntry,
  getUndoEntry,
  subscribeUndoStore,
} from "./undo-store";

export function ComposerPolishItem(_props: PluginComposerItemProps) {
  const composer = useComposer();
  const runPolish = useRpc(polishRunRpc);
  const toast = useToast();
  const { t } = useTranslation(polishTranslations);
  const slotIdRef = useRef<symbol | null>(null);
  if (slotIdRef.current === null) {
    slotIdRef.current = Symbol("composer-polish-slot");
  }
  const slotId = slotIdRef.current;

  const undoEntry = useSyncExternalStore(
    subscribeUndoStore,
    () => getUndoEntry(composer, slotId),
    () => getUndoEntry(composer, slotId),
  );

  const showUndo = canUndoPolish(composer.prompt, undoEntry);

  useEffect(() => {
    if (undoEntry !== undefined && !showUndo) {
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
        icon="Undo2"
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
