import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ComposerPolishItem } from "./client/composer-polish-item";
import { polishTranslations } from "./client/i18n";
import { runComposerUndo } from "./client/polish-controller";
import { DictationPolishSettingsScreen } from "./client/settings-screen";
import { canUndoPolish, getLatestUndoEntry, getUndoEntry } from "./client/undo-store";
import { polishStatusRpc } from "./shared/rpc";

export default function contribute(client: PluginClientContext) {
  // Prime the daemon gateway binding so warm-standby Background Agent starts before first click.
  void client.rpc(polishStatusRpc, {}).catch(() => {});

  const removeComposerItem = client.addComposerItem({
    id: "polish",
    Component: ComposerPolishItem,
  });

  const removeSettingsScreen = client.addSettingsScreen({
    id: "dictation-polish",
    title: polishTranslations.message("settings.title"),
    icon: "Sparkles",
    Component: DictationPolishSettingsScreen,
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
    removeSettingsScreen();
    removeRevertCommand();
    removeSettingsCommand();
  };
}
