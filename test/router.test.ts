import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { parseConfig, routeRequest, type RouterContext, type RoutingRecord } from "../src/router.ts";

function model(id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id, name: id, api: "openai-completions", provider: "test", baseUrl: "https://invalid.test",
    reasoning: true, input: ["text", "image"], contextWindow: 128_000, maxTokens: 8192,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }, ...overrides,
  };
}
const qualifier = model("small", { reasoning: false });
const executor = model("vendor/executor");
const auto = model("auto", { provider: "router", api: "pi-virtual" });
const config = { qualifier: { provider: qualifier.provider, model: qualifier.id } };
const decision = (target = executor, thinkingLevel = "high") =>
  fauxAssistantMessage(JSON.stringify({ provider: target.provider, model: target.id, thinkingLevel }));
const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });
function request(overrides: Partial<ModelRouteRequest> = {}): ModelRouteRequest {
  return { model: auto, thinkingLevel: "off", reason: "user", messages: [user("Fix the bug")], ...overrides };
}
function setup(response: () => AssistantMessage | Promise<AssistantMessage> = () => decision()) {
  const calls: { model: Model<Api>; input: Context; options?: ModelsSimpleStreamOptions }[] = [];
  const records: RoutingRecord[] = [];
  let available = [qualifier, executor, auto];
  const ctx: RouterContext = {
    scopedModels: [],
    modelRegistry: {
      getAvailable: () => available,
      streamSimple(model, input, options) {
        calls.push({ model, input, options });
        const stream = createAssistantMessageEventStream();
        Promise.resolve(response()).then((message) => stream.end(message));
        return stream;
      },
    },
  };
  return { ctx, calls, records, options: { onDecision: (record: RoutingRecord) => records.push(record) },
    available: (models: Model<Api>[]) => { available = models; } };
}

test("configuration requires just an exact physical qualifier reference", () => {
  assert.deepEqual(parseConfig(config), config);
  assert.deepEqual(parseConfig({ qualifier: { provider: "p", model: "vendor/name:alias" } }),
    { qualifier: { provider: "p", model: "vendor/name:alias" } });
  for (const bad of [null, [], {}, { qualifier: "p/m" }, { qualifier: { provider: "", model: "m" } },
    { qualifier: { provider: "p", model: " m" } }, { ...config, tiers: [] },
    { qualifier: { ...config.qualifier, apiKey: "secret" } }]) {
    assert.throws(() => parseConfig(bad), /Expected/);
  }
});

test("a user turn selects exact model and effort using one tool-free qualifier call", async () => {
  const h = setup();
  const result = await routeRequest(request(), h.ctx, config, h.options);
  assert.equal(result.model, executor);
  assert.equal(result.thinkingLevel, "high");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.model, qualifier);
  assert.equal(h.calls[0]!.input.tools, undefined);
  assert.equal(h.calls[0]!.options?.reasoning, undefined);
  assert.equal(h.calls[0]!.options?.maxTokens, 512);
  assert.equal(h.calls[0]!.options?.maxRetries, 0);
  const payload = JSON.parse(h.calls[0]!.input.messages[0]!.content as string);
  assert.equal(payload.candidates.length, 2);
  assert.equal(payload.candidates.some((item: { provider: string }) => item.provider === "router"), false);
  assert.equal(h.records[0]!.outcome, "selected");
  assert.deepEqual(h.records[0]!.usage, decision().usage);
  assert(!JSON.stringify(h.records).includes("Fix the bug"));
});

test("qualifier guidance prioritizes capability and task complexity over price/cache savings", async () => {
  const h = setup();
  await routeRequest(request(), h.ctx, config);
  const prompt = h.calls[0]!.input.systemPrompt!;
  assert.match(prompt, /Prioritize reliable, correct completion over token savings/);
  assert.match(prompt, /small model with off\/minimal\/low/);
  assert.match(prompt, /Default to medium for substantive implementation, debugging, and code review/);
  assert.match(prompt, /Prefer high[\s\S]*architecture, security, or unclear requirements/);
  assert.match(prompt, /Apply this guidance only within allowed thinkingLevels/);
  assert.match(prompt, /Choose model capability separately from effort/);
  assert.match(prompt, /tie-breakers only among comparably suitable model\/effort pairs/);
  assert.match(prompt, /Reassess each new task independently/);
  assert.match(prompt, /short message can imply substantial work/);
  assert.match(prompt, /Return exactly one JSON object with only these string keys: provider, model, thinkingLevel/);
  assert.doesNotMatch(prompt, /Choose the least expensive candidate and lowest allowed effort/);
});

test("a new substantive user task can upgrade a cheaper previous model and minimal effort", async () => {
  const cheap = model("cheap", { cost: { input: 0.1, output: 0.5, cacheRead: 0, cacheWrite: 0 } });
  const h = setup();
  h.available([qualifier, cheap, executor, auto]);
  const result = await routeRequest(request({
    messages: [user("Diagnose the cross-service race and review the security implications")],
    previous: { model: cheap, thinkingLevel: "minimal" },
  }), h.ctx, config, h.options);
  assert.equal(result.model, executor);
  assert.equal(result.thinkingLevel, "high");
  assert.equal(h.records[0]!.outcome, "selected");
  const payload = JSON.parse(h.calls[0]!.input.messages[0]!.content as string);
  assert.deepEqual(payload.previous, { provider: cheap.provider, model: cheap.id, thinkingLevel: "minimal" });
});

test("quality-oriented guidance still accepts cheap minimal effort for a trivial task", async () => {
  const cheap = model("cheap", { cost: { input: 0.1, output: 0.5, cacheRead: 0, cacheWrite: 0 } });
  const h = setup(() => decision(cheap, "minimal"));
  h.available([qualifier, cheap, executor, auto]);
  const result = await routeRequest(request({ messages: [user("Show the git status")] }), h.ctx, config, h.options);
  assert.equal(result.model, cheap);
  assert.equal(result.thinkingLevel, "minimal");
  assert.equal(h.records[0]!.outcome, "selected");
});

test("context projection preserves follow-up context but excludes system/tools/reasoning/images", async () => {
  const h = setup();
  const history: ModelRouteRequest["messages"] = [
    { role: "system", content: "SECRET_SYSTEM", timestamp: 0 },
    user("Build an auth module"),
    { ...fauxAssistantMessage("Plan: add password reset"), content: [
      { type: "thinking", thinking: "SECRET_REASONING" },
      { type: "text", text: "Plan: add password reset" },
    ] },
    { role: "toolResult", toolCallId: "x", toolName: "read", content: [
      { type: "text", text: "SECRET_TOOL" }, { type: "image", data: "SECRET_IMAGE", mimeType: "image/png" },
    ], isError: false, timestamp: 2 },
    user("implement that"),
  ];
  const before = structuredClone(history);
  await routeRequest(request({ messages: history }), h.ctx, config);
  assert.deepEqual(history, before);
  const text = JSON.stringify(h.calls[0]!.input);
  assert(text.includes("implement that") && text.includes("Plan: add password reset"));
  assert(!text.includes("SECRET_"));
  assert(text.includes('hasImages'));
});

test("long task/context excerpts are visibly clipped and image-only latest input stays latest", async () => {
  const h = setup();
  await routeRequest(request({ messages: [user("x".repeat(50_000))] }), h.ctx, config);
  assert(JSON.stringify(h.calls[0]!.input).includes("[... clipped ...]"));
  assert(JSON.stringify(h.calls[0]!.input).length < 10_000);
  await routeRequest(request({ messages: [user("old task"), { role: "user", timestamp: 2,
    content: [{ type: "image", data: "image", mimeType: "image/png" }] }] }), h.ctx, config);
  const payload = JSON.parse(h.calls[1]!.input.messages[0]!.content as string);
  assert.equal(payload.task, "");
  assert.equal(payload.hasImages, true);
  assert.equal(payload.recent[0].text, "old task");
});

test("scopes and sparse effort maps/pins constrain the decision, not the qualifier", async () => {
  const sparse = model("sparse", { thinkingLevelMap: { off: null, minimal: null, medium: null, high: null, xhigh: "xhigh" } });
  const h = setup(() => decision(sparse, "xhigh"));
  h.available([qualifier, sparse, executor, auto]);
  h.ctx.scopedModels = [{ model: auto }, { model: sparse, thinkingLevel: "xhigh" }];
  const result = await routeRequest(request(), h.ctx, config);
  assert.equal(result.thinkingLevel, "xhigh");
  const payload = JSON.parse(h.calls[0]!.input.messages[0]!.content as string);
  assert.deepEqual(payload.candidates.map((m: { thinkingLevels: string[] }) => m.thinkingLevels), [["xhigh"]]);
});

test("non-reasoning models use off and a pinned qualifier fallback respects its pin", async () => {
  const h = setup(() => decision(qualifier, "off"));
  assert.equal((await routeRequest(request(), h.ctx, config)).thinkingLevel, "off");
  const reasoningQualifier = model("small");
  h.available([reasoningQualifier, auto]);
  h.ctx.scopedModels = [{ model: reasoningQualifier, thinkingLevel: "high" }, { model: auto }];
  const result = await routeRequest(request(), h.ctx, config, h.options);
  assert.equal(result.thinkingLevel, "high");
  assert.equal(h.records[0]!.reason, "invalid-output");
});

for (const reason of ["continuation", "retry", "direct"] as const) {
  test(`${reason} retains the physical route without qualification`, async () => {
    const h = setup();
    const result = await routeRequest(request({ reason, previous: { model: executor, thinkingLevel: "medium" } }), h.ctx, config, h.options);
    assert.equal(result.model, executor);
    assert.equal(result.thinkingLevel, "medium");
    assert.equal(h.calls.length, 0);
    assert.equal(h.records.length, 0);
  });
}

test("retry uses failed instead of previous; missing routes use eligible qualifier only", async () => {
  const h = setup();
  const failed = { model: qualifier, thinkingLevel: "off" as const, message: fauxAssistantMessage("", { stopReason: "error" }) };
  const result = await routeRequest(request({ reason: "retry", previous: { model: executor, thinkingLevel: "high" }, failed }), h.ctx, config);
  assert.equal(result.model, qualifier);
  for (const reason of ["continuation", "retry", "direct"] as const) {
    assert.equal((await routeRequest(request({ reason }), h.ctx, config)).model, qualifier);
  }
  assert.equal(h.calls.length, 0);
});

test("sticky routes never silently change after scope/effort/auth/image incompatibility", async () => {
  const h = setup();
  for (const reason of ["continuation", "retry", "direct"] as const) {
    h.ctx.scopedModels = [{ model: qualifier }];
    await assert.rejects(routeRequest(request({ reason, previous: { model: executor, thinkingLevel: "high" } }), h.ctx, config), /no longer eligible/);
    h.ctx.scopedModels = [{ model: executor, thinkingLevel: "low" }];
    await assert.rejects(routeRequest(request({ reason, previous: { model: executor, thinkingLevel: "high" } }), h.ctx, config), /no longer eligible/);
  }
  assert.equal(h.calls.length, 0);
});

for (const output of ["not JSON", "```json\n{}\n```", "[]", "null", "{}",
  JSON.stringify({ provider: "test", model: executor.id, thinkingLevel: "invented" }),
  JSON.stringify({ provider: "test", model: "unknown", thinkingLevel: "off" }),
  JSON.stringify({ provider: "router", model: "auto", thinkingLevel: "off" }),
  JSON.stringify({ provider: "test", model: executor.id, thinkingLevel: "high", command: "unsafe" }),
]) {
  test(`invalid decision falls back without repair: ${output.slice(0, 55)}`, async () => {
    const h = setup(() => fauxAssistantMessage(output));
    const result = await routeRequest(request({ previous: { model: executor, thinkingLevel: "low" } }), h.ctx, config, h.options);
    assert.equal(result.model, executor);
    assert.equal(result.thinkingLevel, "low");
    assert.equal(h.calls.length, 1);
    assert.equal(h.records[0]!.reason, "invalid-output");
  });
}

test("provider errors, incomplete replies and thrown calls fail open once", async () => {
  for (const stopReason of ["error", "aborted", "length", "toolUse"] as const) {
    const h = setup(() => ({ ...decision(), stopReason }));
    assert.equal((await routeRequest(request(), h.ctx, config, h.options)).model, qualifier);
    assert.equal(h.records[0]!.outcome, "fallback");
  }
  const h = setup(() => { throw new Error("private provider details"); });
  await routeRequest(request(), h.ctx, config, h.options);
  assert.equal(h.records[0]!.reason, "provider-error");
  assert(!JSON.stringify(h.records).includes("private"));
});

test("missing qualifier auth falls back to previous, or errors without an arbitrary model", async () => {
  const h = setup();
  h.available([executor, auto]);
  assert.equal((await routeRequest(request({ previous: { model: executor, thinkingLevel: "high" } }), h.ctx, config, h.options)).model, executor);
  assert.equal(h.records[0]!.reason, "unavailable");
  await assert.rejects(routeRequest(request(), h.ctx, config, h.options), /no eligible fallback/);
  assert.equal(h.records.at(-1)!.outcome, "error");
  assert.equal(h.calls.length, 0);
});

test("empty physical scope and all-virtual catalog stop before calling the qualifier", async () => {
  const h = setup();
  h.ctx.scopedModels = [{ model: auto }];
  await assert.rejects(routeRequest(request(), h.ctx, config), /no eligible physical models/);
  h.ctx.scopedModels = [];
  h.available([auto]);
  await assert.rejects(routeRequest(request(), h.ctx, config), /no eligible physical models/);
  assert.equal(h.calls.length, 0);
});

test("images in old tool results require vision, including for fallback", async () => {
  const noVision = model("small", { input: ["text"] });
  const h = setup(() => decision(noVision, "off"));
  h.available([noVision, executor, auto]);
  const req = request({ messages: [{ role: "toolResult", toolName: "read", toolCallId: "t", timestamp: 1,
    content: [{ type: "image", data: "xxx", mimeType: "image/png" }], isError: false }, user("Explain") ] });
  await assert.rejects(routeRequest(req, h.ctx, config), /no eligible fallback/);
  const payload = JSON.parse(h.calls[0]!.input.messages[0]!.content as string);
  assert.deepEqual(payload.candidates.map((c: { model: string }) => c.model), [executor.id]);
});

test("oversized whole input falls back without silently dropping candidate rows", async () => {
  const tiny = model("small", { contextWindow: 2048 });
  const h = setup();
  h.available([tiny, executor]);
  await routeRequest(request({ messages: [user("x".repeat(30_000))] }), h.ctx, config, h.options);
  assert.equal(h.calls.length, 0);
  assert.equal(h.records[0]!.reason, "input-too-large");
});

test("candidate availability and effort are revalidated after qualification", async () => {
  const h = setup(() => { h.available([qualifier, auto]); return decision(); });
  const result = await routeRequest(request(), h.ctx, config, h.options);
  assert.equal(result.model, qualifier);
  assert.equal(h.records[0]!.reason, "invalid-output");
});

test("timeout aborts the qualifier, returns once, and ignores a late answer", async () => {
  let finish!: (message: AssistantMessage) => void;
  const h = setup(() => new Promise((resolve) => { finish = resolve; }));
  const result = await routeRequest(request(), h.ctx, config, { ...h.options, timeoutMs: 10 });
  assert.equal(result.model, qualifier);
  assert.equal(h.calls[0]!.options!.signal!.aborted, true);
  assert.equal(h.records[0]!.reason, "timeout");
  finish(decision());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.records.length, 1);
  assert.equal(h.calls.length, 1);
});

test("abort before or during qualification never falls back, records or dispatches late", async () => {
  const pre = new AbortController(); pre.abort();
  const first = setup();
  await assert.rejects(routeRequest(request({ signal: pre.signal }), first.ctx, config, first.options), { name: "AbortError" });
  assert.equal(first.calls.length, 0);
  let finish!: (message: AssistantMessage) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const h = setup(() => new Promise((resolve) => { finish = resolve; started(); }));
  const controller = new AbortController();
  const pending = routeRequest(request({ signal: controller.signal }), h.ctx, config, h.options);
  await ready;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(h.calls[0]!.options!.signal!.aborted, true);
  finish(decision());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.records.length, 0);
});
