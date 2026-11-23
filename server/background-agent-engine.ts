import type { PaseoApi } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { isToolFreeBackgroundProvider, type Preferences } from "../shared/preferences";
import type { WarmStandbyState } from "../shared/rpc";
import type { PolishMessages } from "./prompts";

const CLAUDE_DISALLOWED_BUILTIN_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "Agent",
  "TodoWrite",
  "Task",
  "TaskOutput",
  "TaskStop",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "Skill",
] as const;

function assertToolFreeBackgroundProvider(provider: string): void {
  const trimmed = provider.trim();
  if (trimmed && !isToolFreeBackgroundProvider(trimmed)) {
    throw new Error(
      `Provider "${trimmed}" does not support tool-free Background Agent mode. Use "claude" or switch to OpenAI-Compatible API.`,
    );
  }
}

const STANDBY_SYSTEM_PROMPT =
  "You are a text polishing engine. Follow the formatting instructions in each message strictly and output only the Polished Text.";

export interface BackgroundAgentGateway {
  createAgent(input: {
    provider: string;
    model?: string;
    thinking?: string;
    systemPrompt?: string;
  }): Promise<{ agentId: string }>;
  sendAndWait(input: {
    agentId: string;
    prompt: string;
    signal: AbortSignal;
  }): Promise<string>;
  killAgent(agentId: string): Promise<void>;
}

export interface PaseoBackgroundAgentGatewayOptions {
  readonly cwd?: string;
}

export interface WarmResult {
  readonly warmState: WarmStandbyState;
  readonly error: string | null;
}

export interface WarmStatus {
  readonly warmState: WarmStandbyState;
  readonly lastError: string | null;
  readonly usesOnCurrentAgent: number;
}

export interface WarmBackgroundAgentManagerOptions {
  readonly gateway?: BackgroundAgentGateway;
}

function createAbortError(message = "Aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function createTimeoutError(message = "Timed out"): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(createAbortError());
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      promise.catch(() => {});
      reject(createAbortError());
    };

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function resolveProviderModel(
  paseo: PaseoApi,
  provider: string,
  model?: string,
): Promise<string> {
  let trimmedProvider = provider.trim();
  const trimmedModel = model?.trim() ?? "";

  if (!trimmedProvider) {
    const available = await paseo.providers.listAvailable();
    const firstToolFree = (available.providers ?? []).find(
      (entry) => entry.available && isToolFreeBackgroundProvider(entry.provider),
    );
    if (!firstToolFree) {
      throw new Error(
        "No tool-free Paseo provider (claude) is available for Background Agent mode. Switch to OpenAI-Compatible API.",
      );
    }
    trimmedProvider = firstToolFree.provider;
  }

  assertToolFreeBackgroundProvider(trimmedProvider);

  if (trimmedProvider.includes("/")) {
    if (!trimmedModel) {
      return trimmedProvider;
    }
    const baseProvider = trimmedProvider.split("/", 1)[0];
    return `${baseProvider}/${trimmedModel}`;
  }

  if (trimmedModel) {
    return `${trimmedProvider}/${trimmedModel}`;
  }

  const result = await paseo.providers.listModels(trimmedProvider);
  const models = result.models ?? [];
  const chosen =
    models.find((entry) => entry.isDefault && entry.isSelectable !== false) ??
    models.find((entry) => entry.isSelectable !== false) ??
    models[0];

  if (!chosen) {
    throw new Error(
      result.error ?? `No model configured or available for provider "${trimmedProvider}".`,
    );
  }

  return `${trimmedProvider}/${chosen.id}`;
}

function extractAssistantTextFromTimeline(
  entries: ReadonlyArray<{ readonly item: AgentTimelineItem }>,
): string {
  let lastUserIndex = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.item.type === "user_message") {
      lastUserIndex = i;
      break;
    }
  }

  const relevantEntries = lastUserIndex >= 0 ? entries.slice(lastUserIndex + 1) : entries;
  const assistantParts: string[] = [];

  for (const entry of relevantEntries) {
    if (entry.item.type === "assistant_message") {
      assistantParts.push(entry.item.text);
    }
  }

  return assistantParts.join("\n");
}

/**
 * Formats system instructions and delimited Raw Draft into a single turn prompt
 * so profile, vocabulary, and custom instruction edits apply immediately.
 */
export function formatBackgroundAgentPrompt(messages: PolishMessages): string {
  return `${messages.systemPrompt}\n\n${messages.userPrompt}`;
}

/**
 * Creates a `BackgroundAgentGateway` backed by the Paseo host daemon SDK.
 */
export function createPaseoBackgroundAgentGateway(
  paseo: PaseoApi,
  options: PaseoBackgroundAgentGatewayOptions = {},
): BackgroundAgentGateway {
  const cwd = options.cwd ?? process.cwd();

  return {
    async createAgent({ provider, model, thinking, systemPrompt }) {
      const providerModel = await resolveProviderModel(paseo, provider, model);
      const thinkingOptionId = thinking?.trim();
      const trimmedSystemPrompt = systemPrompt?.trim();

      const handle = await paseo.agents.create({
        background: true,
        cwd,
        title: "Dictation Polish (Standby)",
        config: {
          provider: providerModel,
          modeId: "plan",
          ...(thinkingOptionId ? { thinkingOptionId } : {}),
          ...(trimmedSystemPrompt ? { systemPrompt: trimmedSystemPrompt } : {}),
          options: {
            allowedTools: [],
            disallowedTools: [...CLAUDE_DISALLOWED_BUILTIN_TOOLS],
            extraArgs: { tools: "" },
          },
          mcpServers: {},
        },
      });

      return { agentId: handle.id };
    },

    async sendAndWait({ agentId, prompt, signal }) {
      if (signal.aborted) {
        throw createAbortError();
      }

      const handle = paseo.agents.ref(agentId);
      const result = await raceWithSignal(handle.run(prompt), signal);

      if (result.status === "timeout") {
        throw createTimeoutError(result.error ?? "Background agent timed out.");
      }

      if (result.status === "error") {
        throw new Error(result.error ?? "Background agent turn failed.");
      }

      if (result.status === "permission") {
        throw new Error("Background agent requested unexpected permission.");
      }

      if (typeof result.lastMessage === "string" && result.lastMessage.trim().length > 0) {
        return result.lastMessage;
      }

      const timeline = await raceWithSignal(
        handle.timeline.refetch({ direction: "tail", limit: 1, wholeTurns: true }),
        signal,
      );
      return extractAssistantTextFromTimeline(timeline.entries);
    },

    async killAgent(agentId) {
      await paseo.agents.ref(agentId).archive();
    },
  };
}

function buildConfigFingerprint(preferences: Preferences): string {
  return JSON.stringify([
    preferences.backgroundAgent.provider.trim(),
    preferences.backgroundAgent.model.trim(),
    preferences.backgroundAgent.thinking.trim(),
  ]);
}

/**
 * Maintains at most one warm-standby Paseo background agent at steady state,
 * returning Polished Text immediately and rotating asynchronously after use.
 */
export class WarmBackgroundAgentManager {
  private gateway: BackgroundAgentGateway | null;
  private warmState: WarmStandbyState = "idle";
  private lastError: string | null = null;
  private usesOnCurrentAgent = 0;
  private activeAgentId: string | null = null;
  private activeFingerprint: string | null = null;
  private inFlightWarm: Promise<WarmResult> | null = null;
  private inFlightWarmFingerprint: string | null = null;
  private readonly pendingKills = new Set<Promise<void>>();
  private epoch = 0;
  private disposed = false;

  constructor(options: WarmBackgroundAgentManagerOptions = {}) {
    this.gateway = options.gateway ?? null;
  }

  hasGateway(): boolean {
    return this.gateway !== null;
  }

  setGateway(gateway: BackgroundAgentGateway): void {
    this.gateway = gateway;
  }

  getStatus(): WarmStatus {
    return {
      warmState: this.warmState,
      lastError: this.lastError,
      usesOnCurrentAgent: this.usesOnCurrentAgent,
    };
  }

  async warm(preferences: Preferences): Promise<WarmResult> {
    if (this.disposed) {
      return { warmState: this.warmState, error: this.lastError };
    }

    if (preferences.engine !== "background-agent") {
      await this.disable();
      return { warmState: "disabled", error: null };
    }

    const configuredProvider = preferences.backgroundAgent.provider.trim();
    if (configuredProvider && !isToolFreeBackgroundProvider(configuredProvider)) {
      this.epoch += 1;
      const oldAgentId = this.detachActiveAgent();
      this.warmState = "error";
      this.lastError = `Provider "${configuredProvider}" does not support tool-free Background Agent mode. Use "claude" or switch to OpenAI-Compatible API.`;
      if (oldAgentId) {
        void this.safeKill(oldAgentId);
      }
      return { warmState: "error", error: this.lastError };
    }

    const fingerprint = buildConfigFingerprint(preferences);

    if (
      this.activeAgentId !== null &&
      this.activeFingerprint === fingerprint &&
      this.warmState === "ready"
    ) {
      return { warmState: "ready", error: null };
    }

    if (this.inFlightWarm !== null && this.inFlightWarmFingerprint === fingerprint) {
      return this.inFlightWarm;
    }

    this.epoch += 1;
    const myEpoch = this.epoch;
    const oldAgentId = this.detachActiveAgent();
    if (oldAgentId) {
      void this.safeKill(oldAgentId);
    }

    return this.startWarmTask({
      preferences,
      fingerprint,
      expectedEpoch: myEpoch,
      stateDuringWarm: "warming",
    });
  }

  async syncSettings(preferences: Preferences): Promise<WarmResult> {
    if (this.disposed) {
      return { warmState: this.warmState, error: this.lastError };
    }

    if (preferences.engine !== "background-agent") {
      await this.disable();
      return { warmState: "disabled", error: null };
    }

    if (!this.gateway) {
      if (this.warmState === "disabled") {
        this.warmState = "idle";
      }
      this.lastError = null;
      return { warmState: this.warmState, error: null };
    }

    const configuredProvider = preferences.backgroundAgent.provider.trim();
    if (configuredProvider && !isToolFreeBackgroundProvider(configuredProvider)) {
      this.epoch += 1;
      const oldAgentId = this.detachActiveAgent();
      this.warmState = "error";
      this.lastError = `Provider "${configuredProvider}" does not support tool-free Background Agent mode. Use "claude" or switch to OpenAI-Compatible API.`;
      if (oldAgentId) {
        void this.safeKill(oldAgentId);
      }
      return { warmState: "error", error: this.lastError };
    }

    const fingerprint = buildConfigFingerprint(preferences);

    if (this.activeAgentId !== null && this.activeFingerprint === fingerprint) {
      return { warmState: this.warmState, error: this.lastError };
    }

    if (this.inFlightWarm !== null && this.inFlightWarmFingerprint === fingerprint) {
      return this.inFlightWarm;
    }

    return this.warm(preferences);
  }

  async polish(params: {
    readonly messages: PolishMessages;
    readonly preferences: Preferences;
    readonly signal: AbortSignal;
  }): Promise<string> {
    const { messages, preferences, signal } = params;

    if (this.disposed) {
      throw new Error("Background agent manager is disposed.");
    }

    if (!this.gateway) {
      throw new Error("Background agent gateway is not configured.");
    }

    const configuredProvider = preferences.backgroundAgent.provider.trim();
    if (configuredProvider && !isToolFreeBackgroundProvider(configuredProvider)) {
      this.epoch += 1;
      const oldAgentId = this.detachActiveAgent();
      this.warmState = "error";
      this.lastError = `Provider "${configuredProvider}" does not support tool-free Background Agent mode. Use "claude" or switch to OpenAI-Compatible API.`;
      if (oldAgentId) {
        void this.safeKill(oldAgentId);
      }
      throw new Error(this.lastError);
    }

    const fingerprint = buildConfigFingerprint(preferences);
    const agentId = await this.acquireAgent(preferences, fingerprint, signal);
    const turnEpoch = this.epoch;
    const prompt = formatBackgroundAgentPrompt(messages);

    let output: string;
    try {
      output = await this.gateway.sendAndWait({
        agentId,
        prompt,
        signal,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (this.activeAgentId === agentId) {
        this.detachActiveAgent();
      }
      this.lastError = errorMessage;

      if (!this.disposed && this.epoch === turnEpoch && preferences.engine === "background-agent") {
        this.triggerAsyncRotateAndKill(agentId, preferences, fingerprint, turnEpoch);
      } else {
        void this.safeKill(agentId);
      }

      throw error;
    }

    if (this.disposed || this.epoch !== turnEpoch) {
      if (this.activeAgentId === agentId) {
        this.detachActiveAgent();
      }
      void this.safeKill(agentId);
      return output;
    }

    this.usesOnCurrentAgent += 1;
    const rotateAfterUses = Math.max(1, preferences.backgroundAgent.rotateAfterUses);

    if (this.usesOnCurrentAgent >= rotateAfterUses) {
      if (this.activeAgentId === agentId) {
        this.detachActiveAgent();
      }
      this.triggerAsyncRotateAndKill(agentId, preferences, fingerprint, turnEpoch);
    }

    return output;
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      await Promise.allSettled([...this.pendingKills]);
      return;
    }

    this.disposed = true;
    this.epoch += 1;
    const oldAgentId = this.detachActiveAgent();
    const inFlight = this.inFlightWarm;

    if (oldAgentId) {
      await this.safeKill(oldAgentId);
    }

    if (inFlight) {
      await Promise.allSettled([inFlight]);
    }

    await Promise.allSettled([...this.pendingKills]);
  }

  private async disable(): Promise<void> {
    this.epoch += 1;
    const oldAgentId = this.detachActiveAgent();
    this.warmState = "disabled";
    this.lastError = null;
    if (oldAgentId) {
      await this.safeKill(oldAgentId);
    }
  }

  private detachActiveAgent(): string | null {
    const id = this.activeAgentId;
    this.activeAgentId = null;
    this.activeFingerprint = null;
    this.usesOnCurrentAgent = 0;
    return id;
  }

  private async acquireAgent(
    preferences: Preferences,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (this.activeAgentId !== null && this.activeFingerprint === fingerprint) {
      return this.activeAgentId;
    }

    if (this.inFlightWarm !== null && this.inFlightWarmFingerprint === fingerprint) {
      const warmResult = await raceWithSignal(this.inFlightWarm, signal);
      if (this.activeAgentId !== null && this.activeFingerprint === fingerprint) {
        return this.activeAgentId;
      }
      throw new Error(warmResult.error ?? "Failed to warm background agent.");
    }

    const warmResult = await raceWithSignal(this.warm(preferences), signal);
    if (this.activeAgentId !== null && this.activeFingerprint === fingerprint) {
      return this.activeAgentId;
    }
    throw new Error(warmResult.error ?? "Failed to create background agent.");
  }

  private triggerAsyncRotateAndKill(
    oldAgentId: string,
    preferences: Preferences,
    fingerprint: string,
    expectedEpoch: number,
  ): void {
    const killPromise = this.safeKill(oldAgentId);
    void this.startWarmTask({
      preferences,
      fingerprint,
      expectedEpoch,
      stateDuringWarm: "rotating",
      beforeCreate: killPromise,
    });
  }

  private startWarmTask(params: {
    readonly preferences: Preferences;
    readonly fingerprint: string;
    readonly expectedEpoch: number;
    readonly stateDuringWarm: "warming" | "rotating";
    readonly beforeCreate?: Promise<void>;
  }): Promise<WarmResult> {
    const { preferences, fingerprint, expectedEpoch, stateDuringWarm, beforeCreate } = params;
    const provider = preferences.backgroundAgent.provider.trim();

    this.warmState = stateDuringWarm;
    this.lastError = null;
    this.inFlightWarmFingerprint = fingerprint;

    let warmPromise!: Promise<WarmResult>;
    warmPromise = (async () => {
      if (beforeCreate) {
        await beforeCreate;
      }

      if (this.disposed || this.epoch !== expectedEpoch) {
        return { warmState: this.warmState, error: this.lastError };
      }

      const gateway = this.gateway;
      if (!gateway) {
        const message = "Background agent gateway is not configured.";
        if (!this.disposed && this.epoch === expectedEpoch) {
          this.warmState = "error";
          this.lastError = message;
        }
        return { warmState: this.warmState, error: message };
      }

      try {
        const { agentId } = await gateway.createAgent({
          provider,
          model: preferences.backgroundAgent.model.trim() || undefined,
          thinking: preferences.backgroundAgent.thinking.trim() || undefined,
          systemPrompt: STANDBY_SYSTEM_PROMPT,
        });

        if (this.disposed || this.epoch !== expectedEpoch) {
          await this.safeKill(agentId);
          return { warmState: this.warmState, error: this.lastError };
        }

        this.activeAgentId = agentId;
        this.activeFingerprint = fingerprint;
        this.usesOnCurrentAgent = 0;
        this.warmState = "ready";
        this.lastError = null;
        return { warmState: "ready", error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!this.disposed && this.epoch === expectedEpoch) {
          this.warmState = "error";
          this.lastError = message;
          this.activeAgentId = null;
          this.activeFingerprint = null;
          this.usesOnCurrentAgent = 0;
        }
        return { warmState: this.warmState, error: message };
      } finally {
        if (this.inFlightWarm === warmPromise) {
          this.inFlightWarm = null;
          this.inFlightWarmFingerprint = null;
        }
      }
    })();

    this.inFlightWarm = warmPromise;
    return warmPromise;
  }

  private safeKill(agentId: string): Promise<void> {
    const gateway = this.gateway;
    if (!gateway) {
      return Promise.resolve();
    }

    const task = gateway.killAgent(agentId).catch(() => {});
    this.pendingKills.add(task);
    task.finally(() => {
      this.pendingKills.delete(task);
    });
    return task;
  }
}
