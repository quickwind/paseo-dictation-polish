import type { PaseoApi } from "@getpaseo/client";
import { describe, expect, it, vi } from "vitest";
import {
  WarmBackgroundAgentManager,
  createPaseoBackgroundAgentGateway,
  type BackgroundAgentGateway,
} from "../server/background-agent-engine";
import { PolishService } from "../server/polish-service";
import { PreferencesSchema, type Preferences } from "../shared/preferences";

function makePreferences(overrides: Partial<Preferences> = {}): Preferences {
  const base = PreferencesSchema.parse({});
  return {
    ...base,
    ...overrides,
    backgroundAgent: {
      provider: "claude",
      model: "haiku",
      thinking: "low",
      rotateAfterUses: 1,
      ...overrides.backgroundAgent,
    },
    openaiCompatible: {
      ...base.openaiCompatible,
      ...overrides.openaiCompatible,
    },
  };
}

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

class FakeBackgroundAgentGateway implements BackgroundAgentGateway {
  private nextId = 1;
  readonly createdAgents: Array<{
    agentId: string;
    provider: string;
    model?: string;
    thinking?: string;
    systemPrompt?: string;
  }> = [];
  readonly sentPrompts: Array<{ agentId: string; prompt: string }> = [];
  readonly killedAgents: string[] = [];
  readonly liveAgents = new Set<string>();

  createHandler?: (
    input: Parameters<BackgroundAgentGateway["createAgent"]>[0],
    defaultId: string,
  ) => Promise<{ agentId: string }>;
  sendHandler?: (input: {
    agentId: string;
    prompt: string;
    signal: AbortSignal;
  }) => Promise<string>;
  killHandler?: (agentId: string) => Promise<void>;

  async createAgent(input: Parameters<BackgroundAgentGateway["createAgent"]>[0]) {
    const defaultId = `bg-agent-${this.nextId++}`;
    const result = this.createHandler
      ? await this.createHandler(input, defaultId)
      : { agentId: defaultId };
    this.createdAgents.push({ agentId: result.agentId, ...input });
    this.liveAgents.add(result.agentId);
    return result;
  }

  async sendAndWait(input: { agentId: string; prompt: string; signal: AbortSignal }) {
    this.sentPrompts.push({ agentId: input.agentId, prompt: input.prompt });
    if (this.sendHandler) {
      return this.sendHandler(input);
    }
    return "Polished text.";
  }

  async killAgent(agentId: string) {
    if (this.killHandler) {
      await this.killHandler(agentId);
    }
    this.killedAgents.push(agentId);
    this.liveAgents.delete(agentId);
  }
}

describe("WarmBackgroundAgentManager & PolishService", () => {
  it("pre-warms one background agent, reaches ready, and deduplicates concurrent warm() calls", async () => {
    const gateway = new FakeBackgroundAgentGateway();
    const createDeferredGate = createDeferred<{ agentId: string }>();
    gateway.createHandler = () => createDeferredGate.promise;

    let prefs = makePreferences();
    const manager = new WarmBackgroundAgentManager({ gateway });
    const service = new PolishService({
      getSettings: async () => prefs,
      backgroundAgentManager: manager,
    });

    const warm1 = service.warm();
    const warm2 = service.warm();

    expect((await service.getStatus()).warmState).toBe("warming");
    expect(gateway.createdAgents).toHaveLength(0);

    createDeferredGate.resolve({ agentId: "bg-agent-1" });
    const [res1, res2] = await Promise.all([warm1, warm2]);

    expect(res1).toEqual({ warmState: "ready", error: null });
    expect(res2).toEqual({ warmState: "ready", error: null });
    expect(gateway.createdAgents).toHaveLength(1);
    expect(gateway.liveAgents.size).toBe(1);

    const status = await service.getStatus();
    expect(status.engine).toBe("background-agent");
    expect(status.warmState).toBe("ready");
    expect(status.usesOnCurrentAgent).toBe(0);
    expect(status.lastError).toBeNull();
  });

  it("warms cleanly in Auto / Default mode when provider is empty and surfaces gateway errors when none are available", async () => {
    const gateway = new FakeBackgroundAgentGateway();
    const prefs = makePreferences({
      backgroundAgent: { provider: "", model: "", thinking: "low", rotateAfterUses: 1 },
    });

    const manager = new WarmBackgroundAgentManager({ gateway });
    const service = new PolishService({
      getSettings: async () => prefs,
      backgroundAgentManager: manager,
    });

    const warmRes = await service.warm();
    expect(warmRes.warmState).toBe("ready");
    expect(warmRes.error).toBeNull();
    expect(gateway.createdAgents).toHaveLength(1);
    expect(gateway.createdAgents[0].provider).toBe("");

    // When no provider is available on host, gateway error surfaces as warmState: "error"
    const emptyGateway = new FakeBackgroundAgentGateway();
    emptyGateway.createHandler = async () => {
      throw new Error("No available Paseo provider found for Background Agent.");
    };
    const failingManager = new WarmBackgroundAgentManager({ gateway: emptyGateway });
    const failingService = new PolishService({
      getSettings: async () => prefs,
      backgroundAgentManager: failingManager,
    });

    const failedWarm = await failingService.warm();
    expect(failedWarm.warmState).toBe("error");
    expect(failedWarm.error).toContain("No available Paseo provider");
  });

  it("reuses warm agent with zero cold-start, returns Polished Text first, and rotates asynchronously when rotateAfterUses=1", async () => {
    const gateway = new FakeBackgroundAgentGateway();
    const prefs = makePreferences({
      backgroundAgent: { provider: "claude", model: "haiku", thinking: "low", rotateAfterUses: 1 },
    });

    const manager = new WarmBackgroundAgentManager({ gateway });
    const service = new PolishService({
      getSettings: async () => prefs,
      backgroundAgentManager: manager,
    });

    await service.warm();
    expect(gateway.createdAgents).toHaveLength(1);

    const replacementGate = createDeferred<{ agentId: string }>();
    let createCalls = 0;
    gateway.createHandler = (_input, defaultId) => {
      createCalls += 1;
      if (createCalls === 1) {
        return replacementGate.promise;
      }
      return Promise.resolve({ agentId: defaultId });
    };
    gateway.sendHandler = async ({ agentId }) => {
      expect(agentId).toBe("bg-agent-1");
      // Return value must be produced without waiting for replacement creation
      return "Refactor the auth module and run tests.";
    };

    const result = await service.polish({
      text: "um refactor the auth module and uh run tests",
    });

    expect(result.fallback).toBe(false);
    expect(result.text).toBe("Refactor the auth module and run tests.");
    // No extra createAgent finished during the request
    expect(gateway.createdAgents).toHaveLength(1);

    // After polish returns, old agent is killed and replacement is warming ("rotating")
    await flushMicrotasks();
    expect(gateway.killedAgents).toEqual(["bg-agent-1"]);
    expect((await service.getStatus()).warmState).toBe("rotating");

    // Finish background replacement warm
    replacementGate.resolve({ agentId: "bg-agent-2" });
    await flushMicrotasks();

    const status = await service.getStatus();
    expect(status.warmState).toBe("ready");
    expect(status.usesOnCurrentAgent).toBe(0);
    expect(status.lastLatencyMs).toBeGreaterThanOrEqual(0);
    expect(status.lastFallbackReason).toBeNull();
    expect(Array.from(gateway.liveAgents)).toEqual(["bg-agent-2"]);
  });

  it("reuses the same warm agent twice when rotateAfterUses=2 before rotating and killing", async () => {
    const gateway = new FakeBackgroundAgentGateway();
    let prefs = makePreferences({
      backgroundAgent: { provider: "claude", model: "haiku", thinking: "low", rotateAfterUses: 2 },
    });

    const manager = new WarmBackgroundAgentManager({ gateway });
    const service = new PolishService({
      getSettings: async () => prefs,
      backgroundAgentManager: manager,
    });

    await service.warm();
    expect(gateway.createdAgents).toHaveLength(1);

    // 1st polish
    await service.polish({ text: "first draft" });
    await flushMicrotasks();
    expect(gateway.sentPrompts[0]?.agentId).toBe("bg-agent-1");
    expect(gateway.killedAgents).toEqual([]);
    expect(gateway.createdAgents).toHaveLength(1);
    expect((await service.getStatus()).usesOnCurrentAgent).toBe(1);
    expect((await service.getStatus()).warmState).toBe("ready");

    // Update profile & vocabulary between uses: should apply without rebuilding agent
    prefs = makePreferences({
      profile: "structured",
      vocabulary: "Paseo",
      customInstructions: "Use bullets.",
      backgroundAgent: { provider: "claude", model: "haiku", thinking: "low", rotateAfterUses: 2 },
    });

    // 2nd polish reuses same agent and triggers rotation
    await service.polish({ text: "second draft" });
    expect(gateway.sentPrompts[1]?.agentId).toBe("bg-agent-1");
    expect(gateway.sentPrompts[1]?.prompt).toContain("Polish Profile: structured");
    expect(gateway.sentPrompts[1]?.prompt).toContain("Paseo");
    expect(gateway.sentPrompts[1]?.prompt).toContain("Use bullets.");

    await flushMicrotasks();
    expect(gateway.killedAgents).toEqual(["bg-agent-1"]);
    expect(gateway.createdAgents).toHaveLength(2);
    expect((await service.getStatus()).warmState).toBe("ready");
    expect((await service.getStatus()).usesOnCurrentAgent).toBe(0);
    expect(Array.from(gateway.liveAgents)).toEqual(["bg-agent-2"]);
  });

  it("kills active warm agent and transitions to disabled when switched to openai-compatible", async () => {
    const gateway = new FakeBackgroundAgentGateway();
    let prefs = makePreferences({ engine: "background-agent" });

    const manager = new WarmBackgroundAgentManager({ gateway });
    const service = new PolishService({
      getSettings: async () => prefs,
      backgroundAgentManager: manager,
    });

    await service.warm();
    expect(Array.from(gateway.liveAgents)).toEqual(["bg-agent-1"]);

    prefs = makePreferences({ engine: "openai-compatible" });
    await manager.syncSettings(prefs);

    expect(gateway.killedAgents).toEqual(["bg-agent-1"]);
    expect(gateway.liveAgents.size).toBe(0);
    const status = await service.getStatus();
    expect(status.engine).toBe("openai-compatible");
    expect(status.warmState).toBe("disabled");
  });

  it("kills old agent and warms a new one when model or thinking changes, and rejects non-tool-free providers", async () => {
    const gateway = new FakeBackgroundAgentGateway();
    let prefs = makePreferences({
      backgroundAgent: { provider: "claude", model: "haiku", thinking: "low", rotateAfterUses: 1 },
    });

    const manager = new WarmBackgroundAgentManager({ gateway });
    await manager.warm(prefs);
    expect(gateway.createdAgents).toHaveLength(1);
    expect(gateway.createdAgents[0]?.model).toBe("haiku");

    prefs = makePreferences({
      backgroundAgent: { provider: "claude", model: "sonnet", thinking: "low", rotateAfterUses: 1 },
    });
    const res = await manager.syncSettings(prefs);

    expect(res.warmState).toBe("ready");
    expect(gateway.killedAgents).toEqual(["bg-agent-1"]);
    expect(gateway.createdAgents).toHaveLength(2);
    expect(gateway.createdAgents[1]?.provider).toBe("claude");
    expect(gateway.createdAgents[1]?.model).toBe("sonnet");
    expect(Array.from(gateway.liveAgents)).toEqual(["bg-agent-2"]);

    // Non-tool-free provider (e.g. codex) is disabled and tears down active agent
    const rejected = await manager.syncSettings(
      makePreferences({
        backgroundAgent: { provider: "codex", model: "gpt-5.4", thinking: "low", rotateAfterUses: 1 },
      }),
    );
    expect(rejected.warmState).toBe("error");
    expect(rejected.error).toContain("tool-free");
    expect(gateway.liveAgents.size).toBe(0);
  });

  it("dispose() kills active warm agent and cleans up in-flight warmup agents", async () => {
    const gateway = new FakeBackgroundAgentGateway();
    const prefs = makePreferences();
    const manager = new WarmBackgroundAgentManager({ gateway });

    await manager.warm(prefs);
    expect(gateway.liveAgents.size).toBe(1);

    await manager.dispose();
    expect(gateway.killedAgents).toEqual(["bg-agent-1"]);
    expect(gateway.liveAgents.size).toBe(0);

    // Also test dispose while warm is in flight
    const gateway2 = new FakeBackgroundAgentGateway();
    const gate = createDeferred<{ agentId: string }>();
    gateway2.createHandler = () => gate.promise;
    const manager2 = new WarmBackgroundAgentManager({ gateway: gateway2 });

    const warmPromise = manager2.warm(prefs);
    const disposePromise = manager2.dispose();
    gate.resolve({ agentId: "bg-in-flight" });

    await Promise.all([warmPromise, disposePromise]);
    expect(gateway2.killedAgents).toEqual(["bg-in-flight"]);
    expect(gateway2.liveAgents.size).toBe(0);
  });

  it("fails open on timeout, gateway error, empty output, and suspicious expansion while recording lastFallbackReason", async () => {
    const gateway = new FakeBackgroundAgentGateway();
    let prefs = makePreferences({ timeoutMs: 25 });

    const manager = new WarmBackgroundAgentManager({ gateway });
    const service = new PolishService({
      getSettings: async () => prefs,
      backgroundAgentManager: manager,
    });

    await service.warm();

    // 1. Timeout
    gateway.sendHandler = ({ signal }) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const err = new Error("Aborted");
          err.name = "AbortError";
          reject(err);
        });
      });

    const timeoutResult = await service.polish({ text: "original timeout draft" });
    expect(timeoutResult.fallback).toBe(true);
    expect(timeoutResult.fallbackReason).toBe("timeout");
    expect(timeoutResult.text).toBe("original timeout draft");
    await flushMicrotasks();
    expect(gateway.killedAgents).toContain("bg-agent-1");
    expect((await service.getStatus()).lastFallbackReason).toBe("timeout");
    expect((await service.getStatus()).warmState).toBe("ready");

    // 2. Gateway error
    prefs = makePreferences({ timeoutMs: 5000 });
    gateway.sendHandler = async () => {
      throw new Error("provider crashed");
    };

    const errorResult = await service.polish({ text: "original error draft" });
    expect(errorResult.fallback).toBe(true);
    expect(errorResult.fallbackReason).toBe("engine_error");
    expect(errorResult.text).toBe("original error draft");
    await flushMicrotasks();
    expect(gateway.killedAgents).toContain("bg-agent-2");
    expect((await service.getStatus()).lastFallbackReason).toBe("engine_error");
    expect((await service.getStatus()).warmState).toBe("ready");

    // 3. Empty output
    gateway.sendHandler = async () => "   \n  ";
    const emptyResult = await service.polish({ text: "original empty draft" });
    expect(emptyResult.fallback).toBe(true);
    expect(emptyResult.fallbackReason).toBe("empty_output");
    expect(emptyResult.text).toBe("original empty draft");
    await flushMicrotasks();
    expect(gateway.killedAgents).toContain("bg-agent-3");
    expect((await service.getStatus()).lastFallbackReason).toBe("empty_output");

    // 4. Suspicious expansion
    gateway.sendHandler = async () => "X".repeat(300);
    const expansionResult = await service.polish({ text: "short draft" });
    expect(expansionResult.fallback).toBe(true);
    expect(expansionResult.fallbackReason).toBe("suspicious_expansion");
    expect(expansionResult.text).toBe("short draft");
    await flushMicrotasks();
    expect(gateway.killedAgents).toContain("bg-agent-4");
    expect((await service.getStatus()).lastFallbackReason).toBe("suspicious_expansion");
  });
});

describe("createPaseoBackgroundAgentGateway", () => {
  it("creates background agent with mcpServers: {}, resolves default model when omitted, reads timeline fallback, and archives on kill", async () => {
    const runMock = vi.fn(async () => ({
      status: "idle" as const,
      final: null,
      error: null,
      lastMessage: null,
    }));
    const refetchMock = vi.fn(async () => ({
      entries: [
        { item: { type: "user_message" as const, text: "draft" } },
        { item: { type: "assistant_message" as const, text: "Clean polished text." } },
      ],
    }));
    const archiveMock = vi.fn(async () => ({ archivedAt: "2026-11-23T00:00:00.000Z" }));
    const createMock = vi.fn(async () => ({ id: "paseo-bg-99" }));
    const listModelsMock = vi.fn(async () => ({
      provider: "claude",
      models: [{ provider: "claude", id: "haiku", label: "Haiku", isDefault: true }],
      fetchedAt: "2026-11-23T00:00:00.000Z",
      requestId: "req-1",
    }));

    const fakePaseo = {
      providers: {
        listModels: listModelsMock,
      },
      agents: {
        create: createMock,
        ref: vi.fn(() => ({
          run: runMock,
          timeline: { refetch: refetchMock },
          archive: archiveMock,
        })),
      },
    } as unknown as PaseoApi;

    const gateway = createPaseoBackgroundAgentGateway(fakePaseo, { cwd: "/tmp/work" });

    const created = await gateway.createAgent({
      provider: "claude",
      thinking: "low",
      systemPrompt: "Polish only.",
    });

    expect(created).toEqual({ agentId: "paseo-bg-99" });
    expect(listModelsMock).toHaveBeenCalledWith("claude");
    expect(createMock).toHaveBeenCalledWith({
      background: true,
      cwd: "/tmp/work",
      title: "Dictation Polish (Standby)",
      config: {
        provider: "claude/haiku",
        modeId: "plan",
        thinkingOptionId: "low",
        systemPrompt: "Polish only.",
        options: {
          allowedTools: [],
          disallowedTools: expect.arrayContaining(["Bash", "Read", "Edit", "Write", "Glob", "Grep"]),
          extraArgs: { tools: "" },
        },
        mcpServers: {},
      },
    });

    const controller = new AbortController();
    const output = await gateway.sendAndWait({
      agentId: "paseo-bg-99",
      prompt: "polish me",
      signal: controller.signal,
    });
    expect(output).toBe("Clean polished text.");
    expect(runMock).toHaveBeenCalledWith("polish me");
    expect(refetchMock).toHaveBeenCalledWith({
      direction: "tail",
      limit: 1,
      wholeTurns: true,
    });

    await gateway.killAgent("paseo-bg-99");
    expect(archiveMock).toHaveBeenCalledTimes(1);
  });

  it("auto-selects tool-free claude via listAvailable when provider is empty, and rejects non-tool-free providers", async () => {
    const listAvailableMock = vi.fn(async () => ({
      providers: [
        { provider: "codex", available: true, error: null },
        { provider: "claude", available: true, error: null },
      ],
    }));
    const listModelsMock = vi.fn(async () => ({
      provider: "claude",
      models: [{ id: "claude-haiku-5-5", isDefault: true, isSelectable: true }],
      error: null,
    }));
    const createMock = vi.fn(async () => ({ id: "paseo-auto-1" }));

    const fakePaseo = {
      providers: {
        listAvailable: listAvailableMock,
        listModels: listModelsMock,
      },
      agents: {
        create: createMock,
        ref: vi.fn(),
      },
    } as unknown as PaseoApi;

    const gateway = createPaseoBackgroundAgentGateway(fakePaseo, { cwd: "/tmp/work" });
    const created = await gateway.createAgent({
      provider: "",
      thinking: "low",
    });

    expect(created).toEqual({ agentId: "paseo-auto-1" });
    expect(listAvailableMock).toHaveBeenCalledTimes(1);
    expect(listModelsMock).toHaveBeenCalledWith("claude");
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        background: true,
        config: expect.objectContaining({
          provider: "claude/claude-haiku-5-5",
          modeId: "plan",
          options: expect.objectContaining({
            allowedTools: [],
            extraArgs: { tools: "" },
          }),
          mcpServers: {},
        }),
      }),
    );

    await expect(
      gateway.createAgent({
        provider: "codex",
        thinking: "low",
      }),
    ).rejects.toThrow("tool-free");
  });
});
