import type { PluginSurfaceProps, SettingsState } from "@getpaseo/plugin/client";
import { usePaseo, useRpc, useSettings, useTranslation } from "@getpaseo/plugin/client";
import {
  Loading,
  ScrollView,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  preferencesSettings,
  type BackgroundAgentPreferences,
  type OpenAiCompatPresetId,
  type OpenAiCompatiblePreferences,
  type PolishEngineKind,
  type PolishProfile,
  type Preferences,
  type PreferencesSchema,
} from "../shared/preferences";
import {
  polishRunRpc,
  polishStatusRpc,
  polishWarmRpc,
  type PolishRunOutput,
  type WarmStandbyState,
} from "../shared/rpc";
import { polishTranslations } from "./i18n";
import {
  applyOpenAiCompatPreset,
  buildRotateAfterUsesValues,
  DEFAULT_THINKING_OPTIONS,
  getModelThinkingOptions,
  isBackgroundAgentDirty,
  isOpenAiCompatDirty,
  parseTimeoutMs,
} from "./settings-helpers";

type ReadySettingsState = Extract<SettingsState<typeof PreferencesSchema>, { status: "ready" }> & {
  saving: boolean;
  saveError: string | null;
  save(values: Preferences, revision: string): Promise<boolean>;
  reset(): Promise<boolean>;
  reload(): Promise<void>;
};

export function DictationPolishSettingsScreen(props: PluginSurfaceProps) {
  const settings = useSettings(preferencesSettings);
  const { t } = useTranslation(polishTranslations);
  const toast = useToast();

  if (settings.status === "loading") {
    return <Loading />;
  }

  if (settings.status === "invalid") {
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }}
        contentContainerStyle={{ padding: props.layout.compact ? 12 : 20 }}
      >
        <SettingsSection title={t("settings.states.invalidTitle")}>
          <SettingsCard>
            <SettingsRow
              label={t("settings.states.invalidTitle")}
              error={settings.error}
            />
            <SettingsAction
              label={t("settings.states.resetLabel")}
              hint={t("settings.states.resetHint")}
              actionLabel={t("settings.states.resetAction")}
              disabled={settings.saving}
              onPress={() => {
                void settings.reset().then((ok) => {
                  if (ok) {
                    toast.show(t("settings.states.resetDone"), { variant: "success" });
                  }
                });
              }}
            />
          </SettingsCard>
        </SettingsSection>
      </ScrollView>
    );
  }

  if (settings.status === "error") {
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }}
        contentContainerStyle={{ padding: props.layout.compact ? 12 : 20 }}
      >
        <SettingsSection title={t("settings.states.errorTitle")}>
          <SettingsCard>
            <SettingsRow
              label={t("settings.states.errorTitle")}
              error={settings.error}
            />
            <SettingsAction
              label={t("settings.states.reloadLabel")}
              hint={t("settings.states.reloadHint")}
              actionLabel={t("settings.states.reloadAction")}
              onPress={() => {
                void settings.reload();
              }}
            />
          </SettingsCard>
        </SettingsSection>
      </ScrollView>
    );
  }

  return <ReadySettingsContent {...props} settings={settings} />;
}

interface ReadySettingsContentProps extends PluginSurfaceProps {
  settings: ReadySettingsState;
}

function ReadySettingsContent({
  theme,
  host,
  layout,
  settings,
}: ReadySettingsContentProps) {
  const paseo = usePaseo();
  const getStatus = useRpc(polishStatusRpc);
  const runWarm = useRpc(polishWarmRpc);
  const runPolish = useRpc(polishRunRpc);
  const toast = useToast();
  const { t } = useTranslation(polishTranslations);

  const { values, revision, saving, saveError } = settings;

  // Draft state for Background Agent
  const [bgDraft, setBgDraft] = useState<BackgroundAgentPreferences>(values.backgroundAgent);
  const [bgInputVersion, setBgInputVersion] = useState(0);

  // Draft state for OpenAI-Compatible API
  const [oaiDraft, setOaiDraft] = useState<OpenAiCompatiblePreferences>(values.openaiCompatible);
  const [oaiInputVersion, setOaiInputVersion] = useState(0);

  // Draft state for Profile details (customInstructions, vocabulary, timeoutMs)
  const [customInstructionsDraft, setCustomInstructionsDraft] = useState(values.customInstructions);
  const [vocabularyDraft, setVocabularyDraft] = useState(values.vocabulary);
  const [timeoutDraft, setTimeoutDraft] = useState(String(values.timeoutMs));
  const [profileInputVersion, setProfileInputVersion] = useState(0);

  // Warm button state
  const [warming, setWarming] = useState(false);

  // Playground state
  const [playgroundDraft, setPlaygroundDraft] = useState(() => t("settings.playground.sampleDraft"));
  const playgroundEditedRef = useRef(false);
  const [playgroundProfile, setPlaygroundProfile] = useState<"" | PolishProfile>("");
  const [playgroundRunning, setPlaygroundRunning] = useState(false);
  const [playgroundResult, setPlaygroundResult] = useState<PolishRunOutput | null>(null);
  const [playgroundError, setPlaygroundError] = useState<string | null>(null);

  // Sync drafts when saved revision changes from host
  useEffect(() => {
    setBgDraft(values.backgroundAgent);
    setBgInputVersion((v) => v + 1);
    setOaiDraft(values.openaiCompatible);
    setOaiInputVersion((v) => v + 1);
    setCustomInstructionsDraft(values.customInstructions);
    setVocabularyDraft(values.vocabulary);
    setTimeoutDraft(String(values.timeoutMs));
    setProfileInputVersion((v) => v + 1);
  }, [revision, values]);

  // Keep default sample draft in sync with locale unless user edited it
  const localizedSample = t("settings.playground.sampleDraft");
  useEffect(() => {
    if (!playgroundEditedRef.current) {
      setPlaygroundDraft(localizedSample);
    }
  }, [localizedSample]);

  // Live Polish Engine status query
  const statusQuery = useQuery({
    queryKey: ["paseo-dictation-polish", "status", host.id],
    queryFn: () => getStatus({}),
  });

  // Available providers query (only needed when background-agent is active)
  const providersQuery = useQuery({
    queryKey: ["paseo-dictation-polish", "providers", host.id],
    queryFn: () => paseo.providers.listAvailable(),
    enabled: values.engine === "background-agent",
  });

  // Available models for the selected provider
  const selectedProvider = bgDraft.provider;
  const modelsQuery = useQuery({
    queryKey: ["paseo-dictation-polish", "models", host.id, selectedProvider],
    queryFn: () =>
      paseo.providers.listModels(
        selectedProvider as Parameters<typeof paseo.providers.listModels>[0],
      ),
    enabled: values.engine === "background-agent" && selectedProvider.trim().length > 0,
  });

  async function savePreferences(nextValues: Preferences): Promise<boolean> {
    const ok = await settings.save(nextValues, revision);
    if (ok) {
      toast.show(t("settings.states.saved"), { variant: "success" });
      void statusQuery.refetch();
    } else {
      const msg = settings.saveError
        ? t("settings.states.saveFailed", { error: settings.saveError })
        : t("settings.states.saveFailedFallback");
      toast.error(msg);
    }
    return ok;
  }

  function formatEngineLabel(engine: PolishEngineKind): string {
    return engine === "background-agent"
      ? t("settings.engineSection.engines.backgroundAgent")
      : t("settings.engineSection.engines.openaiCompatible");
  }

  function formatWarmState(state: WarmStandbyState): string {
    return t(`settings.engineSection.warmStates.${state}`);
  }

  function formatProfileLabel(profile: PolishProfile): string {
    switch (profile) {
      case "clean":
        return t("settings.profileSection.profiles.clean");
      case "structured":
        return t("settings.profileSection.profiles.structured");
      case "translate-en":
        return t("settings.profileSection.profiles.translateEn");
    }
  }

  const availableProviders = (providersQuery.data?.providers ?? []).filter((p) => p.available);
  const providerOptions = availableProviders.map((p) => ({
    label: p.provider,
    value: p.provider,
  }));
  if (
    bgDraft.provider.trim().length > 0 &&
    !providerOptions.some((opt) => opt.value === bgDraft.provider)
  ) {
    providerOptions.unshift({ label: bgDraft.provider, value: bgDraft.provider });
  }

  const providerModels = modelsQuery.data?.models ?? [];
  const modelOptions: { label: string; value: string }[] = [
    { label: t("settings.backgroundAgentSection.autoDefaultOption"), value: "" },
    ...providerModels.map((m) => ({
      label: m.label || m.id,
      value: m.id,
    })),
  ];
  if (bgDraft.model.trim().length > 0 && !modelOptions.some((opt) => opt.value === bgDraft.model)) {
    modelOptions.push({ label: bgDraft.model, value: bgDraft.model });
  }

  const modelThinkingOptions = getModelThinkingOptions(providerModels, bgDraft.model);
  const thinkingOptions =
    modelThinkingOptions.length > 0
      ? modelThinkingOptions.map((opt) => ({ label: opt.label, value: opt.id }))
      : DEFAULT_THINKING_OPTIONS.map((id) => ({
          label: t(`settings.backgroundAgentSection.thinkingOptions.${id}`),
          value: id,
        }));
  if (
    bgDraft.thinking.trim().length > 0 &&
    !thinkingOptions.some((opt) => opt.value === bgDraft.thinking)
  ) {
    thinkingOptions.push({ label: bgDraft.thinking, value: bgDraft.thinking });
  }

  const rotateOptions = buildRotateAfterUsesValues(bgDraft.rotateAfterUses).map((count) => ({
    label:
      count === 1
        ? t("settings.backgroundAgentSection.rotateUseOne")
        : t("settings.backgroundAgentSection.rotateUsesOption", { count }),
    value: String(count),
  }));

  const bgDirty = isBackgroundAgentDirty(values.backgroundAgent, bgDraft);
  const oaiDirty = isOpenAiCompatDirty(values.openaiCompatible, oaiDraft);

  const timeoutValidation = parseTimeoutMs(timeoutDraft);
  const timeoutError = timeoutValidation.ok
    ? null
    : timeoutValidation.errorKind === "invalidNumber"
      ? t("settings.profileSection.timeoutInvalidNumber")
      : t("settings.profileSection.timeoutOutOfRange");
  const profileDetailsDirty =
    customInstructionsDraft !== values.customInstructions ||
    vocabularyDraft !== values.vocabulary ||
    (timeoutValidation.ok ? timeoutValidation.value !== values.timeoutMs : true);

  const warmStateColor = (() => {
    const state = statusQuery.data?.warmState;
    if (state === "ready") return theme.colors.statusSuccess;
    if (state === "error") return theme.colors.statusDanger;
    if (state === "warming" || state === "rotating") return theme.colors.statusWarning;
    return theme.colors.foreground;
  })();

  const sectionGap = layout.compact ? 14 : 20;
  const pagePadding = layout.compact ? 12 : 20;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: pagePadding, gap: sectionGap }}
    >
      {saveError ? (
        <View
          style={[
            styles.banner,
            {
              backgroundColor: theme.colors.surface2,
              borderColor: theme.colors.statusDanger,
            },
          ]}
        >
          <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>
            {t("settings.states.saveFailed", { error: saveError })}
          </Text>
        </View>
      ) : null}

      {/* Section 1: Polish Engine & Status */}
      <SettingsSection title={t("settings.engineSection.title")}>
        <SettingsCard>
          <SettingsSelect<PolishEngineKind>
            label={t("settings.engineSection.engineLabel")}
            hint={t("settings.engineSection.engineHint")}
            value={values.engine}
            disabled={saving}
            options={[
              {
                label: t("settings.engineSection.engines.backgroundAgent"),
                value: "background-agent",
              },
              {
                label: t("settings.engineSection.engines.openaiCompatible"),
                value: "openai-compatible",
              },
            ]}
            onValueChange={(nextEngine) => {
              void savePreferences({ ...values, engine: nextEngine });
            }}
          />

          <SettingsRow label={t("settings.engineSection.statusLabel")}>
            {statusQuery.isLoading ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
                {t("settings.engineSection.statusLoading")}
              </Text>
            ) : statusQuery.isError || !statusQuery.data ? (
              <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>
                {t("settings.engineSection.statusError")}
              </Text>
            ) : (
              <View style={{ gap: 6 }}>
                <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
                  {t("settings.engineSection.statusEngine", {
                    engine: formatEngineLabel(statusQuery.data.engine),
                  })}
                </Text>
                <View
                  style={[
                    styles.statusRow,
                    { flexDirection: layout.compact ? "column" : "row" },
                  ]}
                >
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
                    {t("settings.engineSection.warmStateLabel")}:{" "}
                    <Text style={{ color: warmStateColor, fontWeight: "600" }}>
                      {formatWarmState(statusQuery.data.warmState)}
                    </Text>
                  </Text>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
                    {t("settings.engineSection.lastLatencyLabel")}:{" "}
                    <Text style={{ color: theme.colors.foreground }}>
                      {statusQuery.data.lastLatencyMs !== null
                        ? t("settings.engineSection.latencyMs", {
                            ms: String(Math.round(statusQuery.data.lastLatencyMs)),
                          })
                        : t("settings.engineSection.notAvailable")}
                    </Text>
                  </Text>
                </View>
                {statusQuery.data.lastFallbackReason ? (
                  <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
                    {t("settings.engineSection.lastFallbackLabel")}:{" "}
                    {statusQuery.data.lastFallbackReason}
                  </Text>
                ) : null}
                {statusQuery.data.lastError ? (
                  <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>
                    {t("settings.engineSection.lastErrorLabel")}: {statusQuery.data.lastError}
                  </Text>
                ) : null}
              </View>
            )}
          </SettingsRow>

          <SettingsAction
            label={t("settings.engineSection.refreshLabel")}
            hint={t("settings.engineSection.refreshHint")}
            actionLabel={t("settings.engineSection.refreshAction")}
            disabled={statusQuery.isFetching}
            onPress={() => {
              void statusQuery.refetch();
            }}
          />
        </SettingsCard>
      </SettingsSection>

      {/* Section 2A: Background Agent */}
      {values.engine === "background-agent" ? (
        <SettingsSection title={t("settings.backgroundAgentSection.title")}>
          <SettingsCard>
            {availableProviders.length > 0 ? (
              <SettingsSelect<string>
                label={t("settings.backgroundAgentSection.providerLabel")}
                hint={t("settings.backgroundAgentSection.providerHint")}
                value={bgDraft.provider}
                disabled={saving}
                options={[
                  { label: t("settings.backgroundAgentSection.autoDefaultOption"), value: "" },
                  ...providerOptions,
                ]}
                onValueChange={(nextProvider) => {
                  setBgDraft((prev) => ({
                    ...prev,
                    provider: nextProvider,
                    model: nextProvider === prev.provider ? prev.model : "",
                  }));
                }}
              />
            ) : (
              <SettingsInput
                key={`bg-provider-${bgInputVersion}`}
                label={t("settings.backgroundAgentSection.providerLabel")}
                hint={t("settings.backgroundAgentSection.providerFallbackHint")}
                placeholder={t("settings.backgroundAgentSection.providerPlaceholder")}
                initialValue={bgDraft.provider}
                disabled={saving}
                onChangeText={(text) => {
                  setBgDraft((prev) => ({ ...prev, provider: text }));
                }}
              />
            )}

            {bgDraft.provider.trim().length > 0 && providerModels.length > 0 ? (
              <SettingsSelect<string>
                label={t("settings.backgroundAgentSection.modelLabel")}
                hint={t("settings.backgroundAgentSection.modelHint")}
                value={bgDraft.model}
                disabled={saving}
                options={modelOptions}
                onValueChange={(nextModel) => {
                  setBgDraft((prev) => ({ ...prev, model: nextModel }));
                }}
              />
            ) : (
              <SettingsInput
                key={`bg-model-${bgInputVersion}`}
                label={t("settings.backgroundAgentSection.modelLabel")}
                hint={t("settings.backgroundAgentSection.modelFallbackHint")}
                placeholder={t("settings.backgroundAgentSection.modelPlaceholder")}
                initialValue={bgDraft.model}
                disabled={saving}
                onChangeText={(text) => {
                  setBgDraft((prev) => ({ ...prev, model: text }));
                }}
              />
            )}

            <SettingsSelect<string>
              label={t("settings.backgroundAgentSection.thinkingLabel")}
              hint={t("settings.backgroundAgentSection.thinkingHint")}
              value={bgDraft.thinking}
              disabled={saving}
              options={thinkingOptions}
              onValueChange={(nextThinking) => {
                setBgDraft((prev) => ({ ...prev, thinking: nextThinking }));
              }}
            />

            <SettingsSelect<string>
              label={t("settings.backgroundAgentSection.rotateLabel")}
              hint={t("settings.backgroundAgentSection.rotateHint")}
              value={String(bgDraft.rotateAfterUses)}
              disabled={saving}
              options={rotateOptions}
              onValueChange={(nextRotate) => {
                const parsed = Number.parseInt(nextRotate, 10);
                if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 20) {
                  setBgDraft((prev) => ({ ...prev, rotateAfterUses: parsed }));
                }
              }}
            />

            <SettingsAction
              label={t("settings.backgroundAgentSection.saveLabel")}
              hint={t("settings.backgroundAgentSection.saveHint")}
              actionLabel={t("settings.backgroundAgentSection.saveAction")}
              disabled={saving || !bgDirty}
              onPress={() => {
                void savePreferences({
                  ...values,
                  backgroundAgent: {
                    ...bgDraft,
                    provider: bgDraft.provider.trim(),
                    model: bgDraft.model.trim(),
                  },
                });
              }}
            />

            <SettingsAction
              label={t("settings.backgroundAgentSection.warmLabel")}
              hint={t("settings.backgroundAgentSection.warmHint")}
              actionLabel={
                warming
                  ? t("settings.backgroundAgentSection.warmingAction")
                  : t("settings.backgroundAgentSection.warmAction")
              }
              disabled={warming || saving}
              onPress={() => {
                setWarming(true);
                void runWarm({})
                  .then((res) => {
                    if (res.error) {
                      toast.error(
                        t("settings.backgroundAgentSection.warmFailed", { error: res.error }),
                      );
                    } else {
                      toast.show(
                        t("settings.backgroundAgentSection.warmSuccess", {
                          state: formatWarmState(res.warmState),
                        }),
                        { variant: "success" },
                      );
                    }
                    void statusQuery.refetch();
                  })
                  .catch((err: unknown) => {
                    const message = err instanceof Error ? err.message : String(err);
                    toast.error(
                      t("settings.backgroundAgentSection.warmFailed", { error: message }),
                    );
                    void statusQuery.refetch();
                  })
                  .finally(() => {
                    setWarming(false);
                  });
              }}
            />
          </SettingsCard>
        </SettingsSection>
      ) : null}

      {/* Section 2B: OpenAI-Compatible API */}
      {values.engine === "openai-compatible" ? (
        <SettingsSection title={t("settings.openaiCompatSection.title")}>
          <SettingsCard>
            <SettingsSelect<OpenAiCompatPresetId>
              label={t("settings.openaiCompatSection.presetLabel")}
              hint={t("settings.openaiCompatSection.presetHint")}
              value={oaiDraft.preset}
              disabled={saving}
              options={[
                { label: t("settings.openaiCompatSection.presets.opencodeGo"), value: "opencode-go" },
                { label: t("settings.openaiCompatSection.presets.openai"), value: "openai" },
                { label: t("settings.openaiCompatSection.presets.groq"), value: "groq" },
                { label: t("settings.openaiCompatSection.presets.ollama"), value: "ollama" },
                { label: t("settings.openaiCompatSection.presets.custom"), value: "custom" },
              ]}
              onValueChange={(nextPreset) => {
                setOaiDraft((prev) => applyOpenAiCompatPreset(prev, nextPreset));
                setOaiInputVersion((v) => v + 1);
              }}
            />

            <SettingsInput
              key={`oai-baseUrl-${oaiInputVersion}`}
              label={t("settings.openaiCompatSection.baseUrlLabel")}
              hint={t("settings.openaiCompatSection.baseUrlHint")}
              placeholder={t("settings.openaiCompatSection.baseUrlPlaceholder")}
              initialValue={oaiDraft.baseUrl}
              disabled={saving}
              onChangeText={(text) => {
                setOaiDraft((prev) => ({ ...prev, baseUrl: text }));
              }}
            />

            <SettingsInput
              key={`oai-model-${oaiInputVersion}`}
              label={t("settings.openaiCompatSection.modelLabel")}
              hint={t("settings.openaiCompatSection.modelHint")}
              placeholder={t("settings.openaiCompatSection.modelPlaceholder")}
              initialValue={oaiDraft.model}
              disabled={saving}
              onChangeText={(text) => {
                setOaiDraft((prev) => ({ ...prev, model: text }));
              }}
            />

            <SettingsInput
              key={`oai-envVar-${oaiInputVersion}`}
              label={t("settings.openaiCompatSection.apiKeyEnvVarLabel")}
              hint={t("settings.openaiCompatSection.apiKeyEnvVarHint")}
              placeholder={t("settings.openaiCompatSection.apiKeyEnvVarPlaceholder")}
              initialValue={oaiDraft.apiKeyEnvVar}
              disabled={saving}
              onChangeText={(text) => {
                setOaiDraft((prev) => ({ ...prev, apiKeyEnvVar: text }));
              }}
            />

            <SettingsInput
              key={`oai-apiKey-${oaiInputVersion}`}
              label={t("settings.openaiCompatSection.apiKeyLabel")}
              hint={t("settings.openaiCompatSection.apiKeyHint")}
              placeholder={t("settings.openaiCompatSection.apiKeyPlaceholder")}
              initialValue={oaiDraft.apiKey}
              secureTextEntry={true}
              disabled={saving}
              onChangeText={(text) => {
                setOaiDraft((prev) => ({ ...prev, apiKey: text }));
              }}
            />

            <SettingsAction
              label={t("settings.openaiCompatSection.saveLabel")}
              hint={t("settings.openaiCompatSection.saveHint")}
              actionLabel={t("settings.openaiCompatSection.saveAction")}
              disabled={saving || !oaiDirty}
              onPress={() => {
                void savePreferences({
                  ...values,
                  openaiCompatible: {
                    ...oaiDraft,
                    baseUrl: oaiDraft.baseUrl.trim(),
                    model: oaiDraft.model.trim(),
                    apiKeyEnvVar: oaiDraft.apiKeyEnvVar.trim(),
                  },
                });
              }}
            />
          </SettingsCard>
        </SettingsSection>
      ) : null}

      {/* Section 3: Polish Profile, Custom Instructions & Vocabulary */}
      <SettingsSection title={t("settings.profileSection.title")}>
        <SettingsCard>
          <SettingsSelect<PolishProfile>
            label={t("settings.profileSection.profileLabel")}
            hint={t("settings.profileSection.profileHint")}
            value={values.profile}
            disabled={saving}
            options={[
              { label: t("settings.profileSection.profiles.clean"), value: "clean" },
              { label: t("settings.profileSection.profiles.structured"), value: "structured" },
              { label: t("settings.profileSection.profiles.translateEn"), value: "translate-en" },
            ]}
            onValueChange={(nextProfile) => {
              void savePreferences({ ...values, profile: nextProfile });
            }}
          />

          <SettingsRow
            label={t("settings.profileSection.customInstructionsLabel")}
            hint={t("settings.profileSection.customInstructionsHint")}
          >
            <TextInput
              multiline
              value={customInstructionsDraft}
              onChangeText={setCustomInstructionsDraft}
              placeholder={t("settings.profileSection.customInstructionsPlaceholder")}
              placeholderTextColor={theme.colors.foregroundMuted}
              editable={!saving}
              style={[
                styles.multilineInput,
                {
                  color: theme.colors.foreground,
                  backgroundColor: theme.colors.surface1,
                  borderColor: theme.colors.border,
                  minHeight: 76,
                },
              ]}
            />
          </SettingsRow>

          <SettingsRow
            label={t("settings.profileSection.vocabularyLabel")}
            hint={t("settings.profileSection.vocabularyHint")}
          >
            <TextInput
              multiline
              value={vocabularyDraft}
              onChangeText={setVocabularyDraft}
              placeholder={t("settings.profileSection.vocabularyPlaceholder")}
              placeholderTextColor={theme.colors.foregroundMuted}
              editable={!saving}
              style={[
                styles.multilineInput,
                {
                  color: theme.colors.foreground,
                  backgroundColor: theme.colors.surface1,
                  borderColor: theme.colors.border,
                  minHeight: 88,
                },
              ]}
            />
          </SettingsRow>

          <SettingsInput
            key={`profile-timeout-${profileInputVersion}`}
            label={t("settings.profileSection.timeoutLabel")}
            hint={t("settings.profileSection.timeoutHint")}
            placeholder={t("settings.profileSection.timeoutPlaceholder")}
            initialValue={timeoutDraft}
            error={timeoutError}
            disabled={saving}
            onChangeText={setTimeoutDraft}
          />

          <SettingsAction
            label={t("settings.profileSection.saveLabel")}
            hint={t("settings.profileSection.saveHint")}
            actionLabel={t("settings.profileSection.saveAction")}
            disabled={saving || !profileDetailsDirty || !timeoutValidation.ok}
            onPress={() => {
              if (!timeoutValidation.ok) {
                return;
              }
              void savePreferences({
                ...values,
                customInstructions: customInstructionsDraft,
                vocabulary: vocabularyDraft,
                timeoutMs: timeoutValidation.value,
              });
            }}
          />
        </SettingsCard>
      </SettingsSection>

      {/* Section 4: Inline Test Playground */}
      <SettingsSection title={t("settings.playground.title")}>
        <SettingsCard>
          <SettingsRow
            label={t("settings.playground.draftLabel")}
            hint={t("settings.playground.draftHint")}
          >
            <TextInput
              multiline
              value={playgroundDraft}
              onChangeText={(next) => {
                playgroundEditedRef.current = true;
                setPlaygroundDraft(next);
              }}
              placeholder={t("settings.playground.sampleDraft")}
              placeholderTextColor={theme.colors.foregroundMuted}
              editable={!playgroundRunning}
              style={[
                styles.multilineInput,
                {
                  color: theme.colors.foreground,
                  backgroundColor: theme.colors.surface1,
                  borderColor: theme.colors.border,
                  minHeight: 88,
                },
              ]}
            />
          </SettingsRow>

          <SettingsSelect<"" | PolishProfile>
            label={t("settings.playground.profileOverrideLabel")}
            hint={t("settings.playground.profileOverrideHint")}
            value={playgroundProfile}
            disabled={playgroundRunning}
            options={[
              {
                label: t("settings.playground.useSavedProfile", {
                  profile: formatProfileLabel(values.profile),
                }),
                value: "",
              },
              { label: t("settings.profileSection.profiles.clean"), value: "clean" },
              { label: t("settings.profileSection.profiles.structured"), value: "structured" },
              { label: t("settings.profileSection.profiles.translateEn"), value: "translate-en" },
            ]}
            onValueChange={setPlaygroundProfile}
          />

          <View style={styles.playgroundActionRow}>
            <Pressable
              disabled={playgroundRunning || playgroundDraft.trim().length === 0}
              onPress={() => {
                setPlaygroundRunning(true);
                setPlaygroundError(null);
                void runPolish({
                  text: playgroundDraft,
                  ...(playgroundProfile ? { profileOverride: playgroundProfile } : {}),
                })
                  .then((res) => {
                    setPlaygroundResult(res);
                    void statusQuery.refetch();
                  })
                  .catch((err: unknown) => {
                    const message = err instanceof Error ? err.message : String(err);
                    setPlaygroundError(t("settings.playground.runError", { error: message }));
                  })
                  .finally(() => {
                    setPlaygroundRunning(false);
                  });
              }}
              style={({ pressed }) => [
                styles.primaryButton,
                {
                  backgroundColor:
                    playgroundRunning || playgroundDraft.trim().length === 0
                      ? theme.colors.surface2
                      : theme.colors.accent,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <Text
                style={{
                  color:
                    playgroundRunning || playgroundDraft.trim().length === 0
                      ? theme.colors.foregroundMuted
                      : theme.colors.accentForeground,
                  fontSize: 14,
                  fontWeight: "600",
                }}
              >
                {playgroundRunning
                  ? t("settings.playground.runningAction")
                  : t("settings.playground.runAction")}
              </Text>
            </Pressable>
          </View>

          {playgroundError ? (
            <SettingsRow label={t("settings.playground.resultTitle")} error={playgroundError} />
          ) : null}

          {playgroundResult ? (
            <View
              style={[
                styles.resultCard,
                {
                  backgroundColor: theme.colors.surface1,
                  borderColor: theme.colors.border,
                },
              ]}
            >
              <View
                style={[
                  styles.resultHeader,
                  { flexDirection: layout.compact ? "column" : "row" },
                ]}
              >
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 13,
                    fontWeight: "600",
                  }}
                >
                  {t("settings.playground.resultTitle")}
                </Text>
                <View style={styles.metaRow}>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                    {t("settings.playground.metaEngine", {
                      engine: formatEngineLabel(playgroundResult.engine),
                    })}
                  </Text>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                    {t("settings.playground.metaLatency", {
                      ms: String(Math.round(playgroundResult.latencyMs)),
                    })}
                  </Text>
                  {playgroundResult.fallback ? (
                    <View
                      style={[
                        styles.badge,
                        { backgroundColor: theme.colors.statusWarning },
                      ]}
                    >
                      <Text
                        style={{
                          color: theme.colors.surface0,
                          fontSize: 11,
                          fontWeight: "600",
                        }}
                      >
                        {t("settings.playground.fallbackBadge")}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </View>

              {playgroundResult.fallback && playgroundResult.fallbackReason ? (
                <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
                  {t("settings.playground.fallbackReason", {
                    reason: playgroundResult.fallbackReason,
                  })}
                </Text>
              ) : null}

              <Text style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 20 }}>
                {playgroundResult.text}
              </Text>
            </View>
          ) : null}
        </SettingsCard>
      </SettingsSection>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
  },
  statusRow: {
    gap: 12,
    flexWrap: "wrap",
  },
  multilineInput: {
    width: "100%",
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    textAlignVertical: "top",
  },
  playgroundActionRow: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: "flex-start",
  },
  primaryButton: {
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  resultCard: {
    marginHorizontal: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    gap: 8,
  },
  resultHeader: {
    justifyContent: "space-between",
    gap: 8,
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 10,
  },
  badge: {
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
});
