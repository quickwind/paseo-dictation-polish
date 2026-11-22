import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  WarmBackgroundAgentManager,
  createPaseoBackgroundAgentGateway,
} from "./server/background-agent-engine";
import { PolishService } from "./server/polish-service";
import { PreferencesSchema, preferencesSettings, type Preferences } from "./shared/preferences";
import { polishRunRpc, polishStatusRpc, polishWarmRpc } from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferencesSettings);
  const manager = new WarmBackgroundAgentManager();

  const readPreferences = async (): Promise<Preferences> => {
    const state = await settings.read();
    if (state.status === "ready") {
      return state.values;
    }
    return PreferencesSchema.parse({});
  };

  const ensureGateway = (paseo: PaseoApi) => {
    if (!manager.hasGateway()) {
      manager.setGateway(createPaseoBackgroundAgentGateway(paseo));
    }
  };

  const polishService = new PolishService({
    getSettings: readPreferences,
    backgroundAgentManager: manager,
  });

  const unsubscribe = settings.subscribe((next) => {
    if (next.status === "ready") {
      void manager.syncSettings(next.values);
    }
  });

  void readPreferences().then((initialPreferences) => manager.syncSettings(initialPreferences));

  server.handle(polishRunRpc, (input, context) => {
    ensureGateway(context.paseo);
    return polishService.polish(input);
  });

  server.handle(polishStatusRpc, async (_input, context) => {
    const firstBind = !manager.hasGateway();
    ensureGateway(context.paseo);
    if (firstBind) {
      const prefs = await readPreferences();
      if (
        prefs.engine === "background-agent" &&
        manager.getStatus().warmState === "idle"
      ) {
        void manager.syncSettings(prefs);
      }
    }
    return polishService.getStatus();
  });

  server.handle(polishWarmRpc, (_input, context) => {
    ensureGateway(context.paseo);
    return polishService.warm();
  });

  return async () => {
    unsubscribe();
    await manager.dispose();
  };
}
