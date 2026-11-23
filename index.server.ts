import type { PluginServerContext } from "@getpaseo/plugin/server";
import { PolishService } from "./server/polish-service";
import { PreferencesSchema, preferencesSettings, type Preferences } from "./shared/preferences";
import { polishRunRpc, polishStatusRpc } from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferencesSettings);

  const readPreferences = async (): Promise<Preferences> => {
    const state = await settings.read();
    if (state.status === "ready") {
      return state.values;
    }
    return PreferencesSchema.parse({});
  };

  const polishService = new PolishService({
    getSettings: readPreferences,
  });

  server.handle(polishRunRpc, (input) => polishService.polish(input));
  server.handle(polishStatusRpc, () => polishService.getStatus());

  return () => {};
}
