import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ComposerPolishItem } from "./client/composer-polish-item";
import { polishTranslations } from "./client/i18n";
import { runComposerUndo } from "./client/polish-controller";
import { canUndoPolish, getLatestUndoEntry, getUndoEntry } from "./client/undo-store";

export default function contribute(client: PluginClientContext) {
  const removeComposerItem = client.addComposerItem({
    id: "polish",
    Component: ComposerPolishItem,
  });

  const removeRevertCommand = client.addCommandCenterItem({
    id: "revert-last-polish",
    context: "global",
    title: polishTranslations.message("command.revertLastPolish"),
    icon: "Undo2",
    async onSelect({ composers }) {
      const [focusedComposer] = composers({ focused: true });
      if (!focusedComposer) {
        return;
      }
      const entry = getUndoEntry(focusedComposer) ?? getLatestUndoEntry();
      if (canUndoPolish(focusedComposer.prompt, entry)) {
        await runComposerUndo({ composer: focusedComposer, entry });
      }
    },
  });

  const removeSettingsCommand = client.addCommandCenterItem({
    id: "open-settings",
    context: "global",
    title: polishTranslations.message("command.openSettings"),
    icon: "Settings",
    onSelect({ openSettings }) {
      openSettings("dictation-polish");
    },
  });

  return () => {
    removeComposerItem();
    removeRevertCommand();
    removeSettingsCommand();
  };
}
