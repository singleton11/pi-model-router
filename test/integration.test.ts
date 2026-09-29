import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { test, type TestContext } from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  Type,
  type AssistantMessage,
  type FauxResponseStep,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  AgentSessionRuntime,
  createAgentSession,
  DefaultResourceLoader,
  InteractiveMode,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const extensionPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const choice = (model = "executor", thinkingLevel = "high") =>
  fauxAssistantMessage(JSON.stringify({ provider: "faux", model, thinkingLevel }));

async function fixture(t: TestContext, echo?: () => Promise<void>, tuiMode?: "regular" | "fullscreen") {
  const dir = await mkdtemp(join(tmpdir(), "pi-router-test-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  });
  const configPath = join(dir, "model-router.json");
  await writeFile(configPath, JSON.stringify({ qualifier: { provider: "faux", model: "qualifier" } }));
  const faux = fauxProvider({ provider: "faux", models: [
    { id: "qualifier", reasoning: false, contextWindow: 128_000 },
    { id: "executor", reasoning: true, contextWindow: 128_000 },
  ] });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
    modelsPath: null, modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  await runtime.refresh({ allowNetwork: false });
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const initialSettings = settings.getSettings();
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
    additionalExtensionPaths: [extensionPath], noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: "You are a test assistant. SECRET_SYSTEM_SENTINEL", });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  let toolCalls = 0;
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime,
    resourceLoader: loader, settingsManager: settings, sessionManager: manager,
    model: faux.getModel("executor")!, thinkingLevel: "off", noTools: "builtin",
    customTools: [defineTool({ name: "echo", label: "Echo", description: "Echo a test value", parameters: Type.Object({ value: Type.String() }),
      execute: async (_id, params) => {
        toolCalls++;
        await echo?.();
        return { content: [{ type: "text", text: params.value }], details: undefined };
      } })],
  });
  let disposeSession = async () => { session.dispose(); };
  t.after(() => disposeSession());
  let footerLines: (() => string[]) | undefined;
  if (tuiMode) {
    const host = new AgentSessionRuntime(session, { cwd: dir, agentDir: dir, modelRuntime: runtime,
      settingsManager: settings, resourceLoader: loader, diagnostics: [] },
      async () => { throw new Error("Session replacement is not used by this fixture"); });
    const terminal = { columns: 100, rows: 30, kittyProtocolActive: false,
      start() {}, stop() {}, async drainInput() {}, write(_data: string) {}, moveBy(_lines: number) {},
      hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
      setTitle(_title: string) {}, setProgress(_active: boolean) {} };
    const mode = new InteractiveMode(host, { terminal, tuiMode });
    // Pi's real TUI, with a disposable terminal and no paid/network model calls.
    await mode.init();
    disposeSession = async () => { mode.stop(); await host.dispose(); };
    const internals = mode as unknown as { footerContainer: { render(width: number): string[] } };
    footerLines = () => internals.footerContainer.render(100).map(stripVTControlCharacters);
  } else {
    await session.bindExtensions({ mode: "print" });
  }
  const auto = runtime.getModel("router", "auto");
  assert(auto, "file-loaded extension registered router/auto");
  await session.setModel(auto);
  session.setScopedModels([{ model: auto }, ...faux.models.map((model) => ({ model }))]);
  const calls: { model: string; context: TranscriptContext; options?: SimpleStreamOptions }[] = [];
  function responses(steps: FauxResponseStep[]) {
    faux.setResponses(steps.map((step) => async (context, options, state, model) => {
      calls.push({ model: model.id, context: structuredClone(context), options });
      return typeof step === "function" ? step(context, options, state, model) : step;
    }));
  }
  const decisions = () => manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "model-router.decision");
  return { session, faux, runtime, manager, settings, loader, initialSettings, auto, calls, responses, decisions,
    toolsCalled: () => toolCalls, configPath, dir, footerLines };
}

test("file-loaded extension dispatches model+effort, keeps tool loops sticky, and manual selection bypasses it", async (t) => {
  const h = await fixture(t);
  h.responses([choice(), fauxAssistantMessage(fauxToolCall("echo", { value: "unchanged tool result" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Done")]);
  await h.session.prompt("Please echo a value");
  assert.equal(h.session.getLastAssistantText(), "Done");
  assert.deepEqual(h.calls.map((c) => c.model), ["qualifier", "executor", "executor"]);
  assert.equal(h.calls[1]!.options?.reasoning, "high");
  assert.equal(h.calls[2]!.options?.reasoning, "high");
  assert.equal(h.toolsCalled(), 1);
  assert.equal(h.decisions().length, 1);
  assert.equal(h.session.model?.id, "auto");
  const physical = h.session.messages.filter((m) => m.role === "assistant");
  assert(physical.every((m) => m.model === "executor" && m.thinkingLevel === "high"));
  const qualifierContext = JSON.stringify(h.calls[0]!.context);
  const executionContext = JSON.stringify(h.calls[1]!.context);
  assert(!qualifierContext.includes("SECRET_SYSTEM_SENTINEL"));
  assert(executionContext.includes("SECRET_SYSTEM_SENTINEL") && executionContext.includes("Please echo a value"));
  assert(executionContext.includes('"name":"echo"'));
  assert(!executionContext.includes("You select a physical execution model"));

  h.responses([choice("executor", "low"), fauxAssistantMessage("Next turn")]);
  await h.session.prompt("Now explain it");
  assert.equal(h.decisions().length, 2);
  assert.equal(h.calls.at(-1)!.options?.reasoning, "low");
  await h.session.setModel(h.faux.getModel("executor")!);
  h.responses([fauxAssistantMessage("Manual")]);
  await h.session.prompt("Use my selected model");
  assert.equal(h.session.getLastAssistantText(), "Manual");
  assert.equal(h.decisions().length, 2);
  assert.deepEqual(h.settings.getSettings(), h.initialSettings);
});

test("invalid qualifier JSON executes the eligible fallback and emits a bounded notice/record", async (t) => {
  const h = await fixture(t);
  const warnings: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { warnings.push(args); });
  h.responses([fauxAssistantMessage("not JSON: PRIVATE_RESPONSE"), fauxAssistantMessage("Fallback answer")]);
  await h.session.prompt("Fresh session fallback");
  assert.equal(h.session.getLastAssistantText(), "Fallback answer");
  assert.deepEqual(h.calls.map((c) => c.model), ["qualifier", "qualifier"]);
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]![0]), /Router fallback \(invalid-output\): faux\/qualifier/);
  const record = h.decisions()[0];
  assert(record?.type === "custom");
  assert.equal((record.data as { outcome: string }).outcome, "fallback");
  assert(!JSON.stringify(record).includes("PRIVATE_RESPONSE"));
});

test("queued steering and follow-up each qualify when they reach the request boundary", async (t) => {
  let enterTool!: () => void;
  let releaseTool!: () => void;
  const entered = new Promise<void>((resolve) => { enterTool = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseTool = resolve; });
  const h = await fixture(t, async () => { enterTool(); await blocked; });
  h.responses([choice(), fauxAssistantMessage(fauxToolCall("echo", { value: "x" }), { stopReason: "toolUse" }),
    choice("executor", "low"), fauxAssistantMessage("Steered"),
    choice("executor", "medium"), fauxAssistantMessage("Followed up")]);
  const pending = h.session.prompt("Start a tool call");
  await entered;
  assert.equal(await h.session.steer("Change direction"), "queued");
  assert.equal(await h.session.followUp("Then summarize"), "queued");
  releaseTool();
  await pending;
  assert.equal(h.session.getLastAssistantText(), "Followed up");
  assert.deepEqual(h.calls.map((c) => c.model), ["qualifier", "executor", "qualifier", "executor", "qualifier", "executor"]);
  assert.equal(h.decisions().length, 3);
});

test("SDK abort during an uncooperative qualifier dispatches no executor or decision entry", async (t) => {
  const h = await fixture(t);
  let started!: () => void;
  let finish!: (message: AssistantMessage) => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  h.responses([async () => { started(); return new Promise((resolve) => { finish = resolve; }); }]);
  const pending = h.session.prompt("Slow qualification");
  await ready;
  await h.session.abort();
  await pending;
  assert.equal(h.calls[0]!.options?.signal?.aborted, true);
  finish(choice());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.calls.map((c) => c.model), ["qualifier"]);
  assert.equal(h.decisions().length, 0);
});

test("reload reads config again and a missing config does not break manual sessions", async (t) => {
  const h = await fixture(t);
  await writeFile(h.configPath, JSON.stringify({ qualifier: { provider: "faux", model: "executor" } }));
  await h.session.reload();
  h.responses([choice(), fauxAssistantMessage("Reloaded")]);
  await h.session.prompt("Check new qualifier");
  assert.equal(h.session.getLastAssistantText(), "Reloaded");
  assert.deepEqual(h.calls.map((c) => c.model), ["executor", "executor"]);
  await rm(h.configPath);
  await h.session.reload();
  h.responses([]);
  await h.session.prompt("Auto requires config");
  const last = h.session.messages.at(-1);
  assert(last?.role === "assistant" && last.stopReason === "error" && last.errorMessage?.includes("model-router.json"));
  assert.equal(h.calls.length, 2);
  await h.session.setModel(h.faux.getModel("executor")!);
  h.responses([fauxAssistantMessage("Still usable manually")]);
  await h.session.prompt("Manual still works");
  assert.equal(h.session.getLastAssistantText(), "Still usable manually");
});

test("persisted sessions retain virtual selection and physical dispatch without qualifier prompt leakage", async (t) => {
  const h = await fixture(t);
  h.responses([choice(), fauxAssistantMessage("Persist me")]);
  await h.session.prompt("Persist routing");
  const file = h.manager.getSessionFile();
  assert(file);
  const saved = await readFile(file, "utf8");
  assert(saved.includes('"customType":"model-router.decision"'));
  assert(!saved.includes("You select a physical execution model"));
  const restored = SessionManager.open(file);
  const context = restored.buildSessionContext();
  const selection = restored.getBranch().filter((entry) => entry.type === "model_change").at(-1);
  assert.equal(selection?.provider, "router");
  assert.equal(selection?.modelId, "auto");
  assert(context.messages.some((m) => m.role === "assistant" && m.model === "executor" && m.thinkingLevel === "high"));
  h.session.dispose();
  await h.loader.reload();
  const { session: resumed } = await createAgentSession({ cwd: h.dir, agentDir: h.dir,
    modelRuntime: h.runtime, resourceLoader: h.loader, settingsManager: h.settings,
    sessionManager: restored, noTools: "all" });
  t.after(() => resumed.dispose());
  await resumed.bindExtensions({ mode: "print" });
  assert.equal(resumed.model?.provider, "router");
  assert.equal(resumed.model?.id, "auto");
  h.responses([choice(), fauxAssistantMessage("Resumed")]);
  await resumed.prompt("Continue the saved session");
  assert.equal(resumed.getLastAssistantText(), "Resumed");
  assert.deepEqual(h.calls.map((c) => c.model), ["qualifier", "executor", "qualifier", "executor"]);
});

test("Pi retries the failed physical executor without qualifying or escalating again", async (t) => {
  const h = await fixture(t);
  h.settings.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
  h.responses([choice(), fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 Service unavailable" }),
    fauxAssistantMessage("Recovered")]);
  await h.session.prompt("Retry a transient failure");
  assert.equal(h.session.getLastAssistantText(), "Recovered");
  assert.deepEqual(h.calls.map((c) => c.model), ["qualifier", "executor", "executor"]);
  assert.equal(h.calls.at(-1)!.options?.reasoning, "high");
  assert.equal(h.decisions().length, 1);
});

test("manual compaction uses the previous physical model with no recursive qualification", async (t) => {
  const h = await fixture(t);
  h.settings.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 512 } });
  h.responses([choice(), fauxAssistantMessage("A completed test task")]);
  await h.session.prompt("Explain the test task");
  h.responses([fauxAssistantMessage("## Goal\nComplete the test task.\n## Progress\nDone.")]);
  await h.session.compact();
  assert.deepEqual(h.calls.map((c) => c.model), ["qualifier", "executor", "executor"]);
  assert.equal(h.decisions().length, 1);
  assert(h.manager.getBranch().some((entry) => entry.type === "compaction"));
});

test("reload during qualification discards the old result and leaves the new runtime usable", async (t) => {
  const h = await fixture(t);
  let started!: () => void;
  let finish!: (message: AssistantMessage) => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  h.responses([async () => { started(); return new Promise((resolve) => { finish = resolve; }); }]);
  const pending = h.session.prompt("Old request");
  await ready;
  await h.session.reload();
  await pending;
  finish(choice());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.decisions().length, 0);
  assert.equal(h.calls.length, 1);
  h.responses([choice(), fauxAssistantMessage("New runtime")]);
  await h.session.prompt("New request");
  assert.equal(h.session.getLastAssistantText(), "New runtime");
  assert.equal(h.decisions().length, 1);
});

test("an unresolved saved scope fails closed instead of considering every provider", async (t) => {
  const h = await fixture(t);
  h.session.setScopedModels([]);
  h.settings.applyOverrides({ enabledModels: ["missing-provider/*"] });
  h.responses([]);
  await h.session.prompt("Must not escape scope");
  const last = h.session.messages.at(-1);
  assert(last?.role === "assistant" && last.errorMessage?.includes("scope resolved to no models"));
  assert.equal(h.calls.length, 0);
});

for (const tuiMode of ["regular", "fullscreen"] as const) {
  test(`real ${tuiMode} TUI keeps the footer and publishes the first/current physical route`, async (t) => {
    const h = await fixture(t, undefined, tuiMode);
    const lines = h.footerLines!;
    assert(lines().some((line) => line.includes(h.dir)), "directory footer remains visible on Auto selection");
    assert.equal(lines().at(-1), "Auto · awaiting first route");

    h.responses([choice("executor", "high"), fauxAssistantMessage("First route")]);
    await h.session.prompt("First route");
    assert.equal(lines().at(-1), "→ faux/executor · high", "message_end uses its authoritative message before persistence");
    assert(lines().some((line) => line.includes("auto → executor")), "native selection/dispatch footer remains visible");

    h.responses([choice("executor", "low"), fauxAssistantMessage("Second route")]);
    await h.session.prompt("Second route");
    assert.equal(lines().at(-1), "→ faux/executor · low", "status does not lag one reply behind");

    await h.session.setModel(h.faux.getModel("executor")!);
    assert.equal(lines().length, 2, "manual selection clears only the router status, not the native footer");
    assert(lines().some((line) => line.includes(h.dir)));
    await h.session.setModel(h.auto);
    assert.equal(lines().at(-1), "→ faux/executor · low");
    await h.session.reload();
    assert.equal(lines().at(-1), "→ faux/executor · low", "session_start restores Auto status immediately after reload");
  });
}
