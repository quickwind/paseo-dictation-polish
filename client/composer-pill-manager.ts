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

type PillMode = "polish" | "undo";

interface ManagedPill {
  readonly workspaceId: string;
  readonly registration: PluginButtonRegistration<PluginText>;
  mode: PillMode;
}

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
  const pills = new Map<string, ManagedPill>();
  const slots = new Map<string, symbol>();
  let enabled = false;
  let lifetime: AbortController | null = null;
  let unsubscribeUndo: (() => void) | null = null;
  let delayedSyncTimer: ReturnType<typeof setTimeout> | null = null;

  const getSlotId = (agentId: string): symbol => {
    let slot = slots.get(agentId);
    if (!slot) {
      slot = Symbol(`composer-pill-slot:${agentId}`);
      slots.set(agentId, slot);
    }
    return slot;
  };

  const resolveMode = (agentId: string): PillMode => {
    const [composer] = client.composers({ agentId });
    if (!composer) {
      return "polish";
    }
    const slotId = getSlotId(agentId);
    const undoEntry = getUndoEntry(composer, slotId, composer.prompt);
    return canUndoPolish(composer.prompt, undoEntry) ? "undo" : "polish";
  };

  const buildButton = (agentId: string, mode: PillMode): PluginButton<PluginText> => {
    const isUndo = mode === "undo";

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
          const entry = getUndoEntry(currentComposer, currentSlotId, currentComposer.prompt);
          if (canUndoPolish(currentComposer.prompt, entry)) {
            await runComposerUndo({
              composer: currentComposer,
              entry,
              slotId: currentSlotId,
            });
            syncChangedPills();
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

          syncChangedPills();
          if (toastMessage) {
            throw new Error(toastMessage);
          }
        },
      },
    };
  };

  /**
   * Only updates pills whose visual mode ("polish" <-> "undo") actually changed,
   * avoiding O(N) UI updates across idle agents.
   */
  const syncChangedPills = () => {
    for (const [agentId, managed] of pills.entries()) {
      const nextMode = resolveMode(agentId);
      if (nextMode === managed.mode) {
        continue;
      }
      managed.mode = nextMode;
      try {
        managed.registration.update(buildButton(agentId, nextMode));
      } catch {
        // Ignore updates if pill was already removed during teardown.
      }
    }
  };

  const scheduleSync = () => {
    syncChangedPills();
    if (delayedSyncTimer !== null) {
      clearTimeout(delayedSyncTimer);
    }
    delayedSyncTimer = setTimeout(() => {
      delayedSyncTimer = null;
      syncChangedPills();
    }, 60);
  };

  const registerAgent = (agent: { id: string; workspaceId?: string | null }) => {
    if (!enabled || !lifetime || lifetime.signal.aborted || !agent.workspaceId) {
      return;
    }
    const { id: agentId, workspaceId } = agent;
    const existing = pills.get(agentId);
    // Avoid tearing down and recreating the pill on every agent_update stream event.
    if (existing && existing.workspaceId === workspaceId) {
      return;
    }

    existing?.registration.remove();
    const initialMode = resolveMode(agentId);
    const registration = client.addComposerPill({
      id: "polish",
      workspaceId,
      agentId,
      button: buildButton(agentId, initialMode),
    });
    pills.set(agentId, { workspaceId, registration, mode: initialMode });
  };

  const removeAll = () => {
    for (const managed of pills.values()) {
      managed.registration.remove();
    }
    pills.clear();
  };

  const stop = () => {
    if (delayedSyncTimer !== null) {
      clearTimeout(delayedSyncTimer);
      delayedSyncTimer = null;
    }
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
    unsubscribeUndo = subscribeUndoStore(scheduleSync);

    void client.paseo.agents
      .list({ subscribe: {}, signal: controller.signal })
      .then(({ subscription }) => {
        if (controller.signal.aborted) {
          return undefined;
        }
        subscription.subscribe({
          snapshot: ({ entries }) => {
            if (controller.signal.aborted) return;
            const liveIds = new Set<string>();
            for (const { agent } of entries) {
              if (agent.workspaceId) {
                liveIds.add(agent.id);
                registerAgent(agent);
              }
            }
            for (const [agentId, managed] of pills.entries()) {
              if (!liveIds.has(agentId)) {
                managed.registration.remove();
                pills.delete(agentId);
              }
            }
          },
          update: (message) => {
            if (controller.signal.aborted || message.type !== "agent_update") return;
            const update = message.payload;
            if (update.kind === "upsert") {
              registerAgent(update.agent);
              return;
            }
            const existing = pills.get(update.agentId);
            if (existing) {
              existing.registration.remove();
              pills.delete(update.agentId);
            }
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
