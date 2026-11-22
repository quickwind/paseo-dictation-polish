import type {
  PluginButton,
  PluginButtonRegistration,
  PluginClientContext,
  PluginText,
} from "@getpaseo/plugin/client";
import { polishRunRpc } from "../shared/rpc";
import { polishTranslations } from "./i18n";
import { SPARKLES_SLASH_SVG } from "./icons";
import { runComposerPolish, runComposerUndo } from "./polish-controller";
import { canUndoPolish, getUndoEntry, subscribeUndoStore } from "./undo-store";

interface PillManagerController {
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

const activeManagers = new Set<PillManagerController>();

/**
 * Notifies any mounted client entry to enable or disable per-agent Composer
 * Pills immediately without requiring a plugin reload.
 */
export function setComposerPillEnabled(enabled: boolean): void {
  for (const manager of activeManagers) {
    manager.setEnabled(enabled);
  }
}

export function createComposerPillManager(client: PluginClientContext): PillManagerController {
  const pills = new Map<string, PluginButtonRegistration<PluginText>>();
  const slots = new Map<string, symbol>();
  let enabled = false;
  let lifetime: AbortController | null = null;
  let unsubscribeUndo: (() => void) | null = null;

  const getSlotId = (agentId: string): symbol => {
    let slot = slots.get(agentId);
    if (!slot) {
      slot = Symbol(`composer-pill-slot:${agentId}`);
      slots.set(agentId, slot);
    }
    return slot;
  };

  const buildButton = (agentId: string): PluginButton<PluginText> => {
    const [composer] = client.composers({ agentId });
    const slotId = getSlotId(agentId);
    const undoEntry = composer ? getUndoEntry(composer, slotId) : undefined;
    const isUndo = composer ? canUndoPolish(composer.prompt, undoEntry) : false;

    return {
      title: isUndo
        ? polishTranslations.message("composer.undoPolish")
        : polishTranslations.message("composer.polish"),
      label: isUndo
        ? polishTranslations.message("composer.undoPolish")
        : polishTranslations.message("composer.polish"),
      icon: isUndo ? { svg: SPARKLES_SLASH_SVG } : "Sparkles",
      behavior: {
        kind: "action",
        async onPress() {
          const [currentComposer] = client.composers({ agentId });
          if (!currentComposer) {
            return;
          }

          const currentSlotId = getSlotId(agentId);
          const entry = getUndoEntry(currentComposer, currentSlotId);
          if (canUndoPolish(currentComposer.prompt, entry)) {
            await runComposerUndo({
              composer: currentComposer,
              entry,
              slotId: currentSlotId,
            });
            refreshAllPills();
            return;
          }

          let toastMessage: string | null = null;
          await runComposerPolish({
            composer: currentComposer,
            getLatestComposer: () => client.composers({ agentId })[0] ?? currentComposer,
            runPolish: (input) => client.rpc(polishRunRpc, input),
            slotId: currentSlotId,
            notify: {
              show(message) {
                toastMessage = message;
              },
              error(message) {
                toastMessage = message;
              },
            },
            messages: {
              raceAborted: client.i18n.t(polishTranslations, "toast.raceAborted"),
              fallback: (reason) =>
                client.i18n.t(polishTranslations, "toast.fallback", { reason }),
              fallbackUnknown: client.i18n.t(polishTranslations, "toast.fallbackUnknown"),
              error: client.i18n.t(polishTranslations, "toast.error"),
            },
          });

          refreshAllPills();
          if (toastMessage) {
            throw new Error(toastMessage);
          }
        },
      },
    };
  };

  const refreshAllPills = () => {
    for (const [agentId, registration] of pills.entries()) {
      try {
        registration.update(buildButton(agentId));
      } catch {
        // Ignore updates if pill was already removed during teardown.
      }
    }
  };

  const registerAgent = (agent: { id: string; workspaceId?: string | null }) => {
    if (!enabled || !lifetime || lifetime.signal.aborted || !agent.workspaceId) {
      return;
    }
    const { id: agentId, workspaceId } = agent;
    pills.get(agentId)?.remove();
    pills.set(
      agentId,
      client.addComposerPill({
        id: "polish",
        workspaceId,
        agentId,
        button: buildButton(agentId),
      }),
    );
  };

  const removeAll = () => {
    for (const pill of pills.values()) {
      pill.remove();
    }
    pills.clear();
  };

  const stop = () => {
    lifetime?.abort();
    lifetime = null;
    unsubscribeUndo?.();
    unsubscribeUndo = null;
    removeAll();
  };

  const start = () => {
    stop();
    const controller = new AbortController();
    lifetime = controller;
    unsubscribeUndo = subscribeUndoStore(refreshAllPills);

    void client.paseo.agents
      .list({ subscribe: {}, signal: controller.signal })
      .then(({ subscription }) => {
        if (controller.signal.aborted) {
          return undefined;
        }
        subscription.subscribe({
          snapshot: ({ entries }) => {
            if (controller.signal.aborted) return;
            removeAll();
            for (const { agent } of entries) {
              registerAgent(agent);
            }
          },
          update: (message) => {
            if (controller.signal.aborted || message.type !== "agent_update") return;
            const update = message.payload;
            if (update.kind === "upsert") {
              registerAgent(update.agent);
              return;
            }
            pills.get(update.agentId)?.remove();
            pills.delete(update.agentId);
          },
        });
        return undefined;
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          console.error("[paseo-dictation-polish] Composer pill observation failed", error);
        }
      });
  };

  const controller: PillManagerController = {
    setEnabled(nextEnabled: boolean) {
      if (enabled === nextEnabled) {
        return;
      }
      enabled = nextEnabled;
      if (enabled) {
        start();
      } else {
        stop();
      }
    },
    dispose() {
      enabled = false;
      stop();
      activeManagers.delete(controller);
    },
  };

  activeManagers.add(controller);
  return controller;
}
