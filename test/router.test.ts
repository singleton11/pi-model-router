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
      findOfType: () => undefined,
      classify: async () => { throw new Error("Unexpected native classifier call"); },
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

test("configuration accepts legacy chat and strict TypeSafe decision backends", () => {
  const typesafe = { qualifier: { backend: "typesafe", model: "jev-latest",
    fallback: { provider: "test", model: "small" } } };
  assert.deepEqual(parseConfig(typesafe), typesafe);
  assert.deepEqual(parseConfig({ qualifier: { backend: "typesafe", model: "jev-latest" } }),
    { qualifier: { backend: "typesafe", model: "jev-latest" } });
  assert.deepEqual(parseConfig({ qualifier: { backend: "openai", model: "gpt-6-luna",
    endpoint: "https://gateway.example.test/v1/decisions", apiKeyEnv: "GATEWAY_KEY" } }),
    { qualifier: { backend: "openai", model: "gpt-6-luna",
      endpoint: "https://gateway.example.test/v1/decisions", apiKeyEnv: "GATEWAY_KEY" } });
  for (const bad of [
    { qualifier: { backend: "typesafe", model: "" } },
    { qualifier: { backend: "typesafe", model: "jev-latest", endpoint: "http://remote.example/v1/systemone" } },
    { qualifier: { backend: "openai", model: "gpt-6-luna", endpoint: "https://u:p@example.com/v1/decisions" } },
    { qualifier: { backend: "openai", model: "gpt-6-luna", endpoint: "https://example.com/v1/decisions#secret" } },
    { qualifier: { backend: "openai", model: "gpt-6-luna", apiKeyEnv: "OPENAI_KEY;evil" } },
    { qualifier: { backend: "typesafe", model: "jev-latest", apiKey: "secret" } },
    { qualifier: { backend: "typesafe", model: "jev-latest", fallback: { provider: "test" } } },
    { qualifier: { backend: "other", model: "jev-latest" } },
  ]) assert.throws(() => parseConfig(bad), /Expected/);
});

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

test("direct Jev uses Pi's classifier registry and credential resolution, never a raw key", async () => {
  const h = setup();
  let input: unknown;
  let signal: AbortSignal | undefined;
  Object.assign(h.ctx.modelRegistry, {
    findOfType: (type: string, provider: string, id: string) => {
      assert.deepEqual([type, provider, id], ["classifier", "typesafe", "jev-latest"]);
      return { provider, id, api: "typesafe-systemone" };
    },
    classify: async (_model: unknown, context: unknown, options: { signal?: AbortSignal }) => {
      input = context;
      signal = options.signal;
      const route = (context as { questions: { route: { criteria: Record<string, string> } } }).questions.route;
      const choice = Object.keys(route.criteria).find((key) => {
        const pair = JSON.parse(route.criteria[key]!);
        return pair.model === executor.id && pair.thinkingLevel === "high";
      });
      assert(choice);
      return { stopReason: "stop", answers: { route: { type: "choice", choice,
        confidence: 0.8, probabilities: { [choice]: 0.8, option_0: 0.2 } } },
        usage: { input: 25, output: 1, totalTokens: 26, cost: { total: 0 } } };
    },
  });
  const route = await routeRequest(request({ messages: [user("Fix the bug"),
    { role: "toolResult", toolCallId: "t", toolName: "read", timestamp: 0,
      content: [{ type: "text", text: "SECRET_TOOL" }], isError: false }] }), h.ctx,
    parseConfig({ qualifier: { backend: "typesafe", model: "jev-latest" } }), h.options);
  assert.equal(route.model, executor);
  assert.equal(route.thinkingLevel, "high");
  assert.equal(h.records[0]?.confidence, 0.8);
  assert.equal(h.records[0]?.probabilities?.length, 2);
  assert.deepEqual(h.records[0]?.probabilities?.find((entry) => entry.model === executor.id),
    { option: h.records[0]?.probabilities?.find((entry) => entry.model === executor.id)?.option,
      provider: executor.provider, model: executor.id, thinkingLevel: "high", probability: 0.8 });
  assert(signal);
  assert.equal(h.calls.length, 0);
  assert(!JSON.stringify(input).includes("SECRET_TOOL"));
  assert.equal((input as { state: { task: string } }).state.task, "Fix the bug");
  assert.deepEqual(h.records[0]?.usage, { input: 25, output: 1, totalTokens: 26, cost: { total: 0 } });
});

test("direct Jev returns only the explicit fallback when Pi cannot classify", async () => {
  const h = setup();
  const config = parseConfig({ qualifier: { backend: "typesafe", model: "jev-latest",
    fallback: { provider: "test", model: "small" } } });
  const route = await routeRequest(request(), h.ctx, config, h.options);
  assert.equal(route.model, qualifier);
  assert.equal(h.records[0]?.reason, "provider-error");
  assert.equal(h.records[0]?.outcome, "fallback");
});

test("TypeSafe calls the decision endpoint with bounded projected state and exact model/effort options", async () => {
  const h = setup();
  const typesafe = parseConfig({ qualifier: { backend: "typesafe", model: "jev-latest" } });
  let input: Record<string, unknown> = {};
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-key");
    input = JSON.parse(init?.body as string);
    const route = (input.questions as { route: { criteria: Record<string, { model: string; thinkingLevel: string }> } }).route;
    assert.equal(Object.keys(route.criteria).length > 2, true);
    const id = Object.keys(route.criteria).find((key) => route.criteria[key]?.model === executor.id &&
      route.criteria[key]?.thinkingLevel === "high");
    assert(id);
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { route: { type: "choice", choice: id,
      probabilities: { [id]: 1 }, confidence: 1 } }, usage: { input_tokens: 100, output_tokens: 12 } }), { status: 200 });
  }) as typeof fetch;
  const result = await routeRequest(request({ messages: [
    { role: "system", content: "SECRET_SYSTEM", timestamp: 0 }, user("Fix the bug"),
    { role: "toolResult", toolCallId: "t", toolName: "read", timestamp: 0,
      content: [{ type: "text", text: "SECRET_TOOL" }], isError: false },
  ] }), h.ctx, typesafe, { ...h.options, fetch: fetcher, decisionKey: "test-key" });
  assert.equal(result.model, executor);
  assert.equal(result.thinkingLevel, "high");
  assert.equal(h.calls.length, 0, "decision backend does not make a Pi chat call");
  assert(!JSON.stringify(input).includes("SECRET_"));
  assert.equal(input.model, "jev-latest");
  assert.deepEqual(h.records[0]?.usage, { input_tokens: 100, output_tokens: 12 });
  assert.equal(h.records[0]?.confidence, 1);
  assert.equal(h.records[0]?.probabilities?.length, 1);
  assert.equal(h.records[0]?.probabilities?.[0]?.model, executor.id);
  assert.equal(h.records[0]?.probabilities?.[0]?.thinkingLevel, "high");
  assert.equal(h.records[0]?.probabilities?.[0]?.probability, 1);
  assert(!JSON.stringify(h.records).includes("test-key"));
});

test("TypeSafe full endpoint override uses the System One shape, not the OpenAI shape", async () => {
  const h = setup();
  const typesafe = parseConfig({ qualifier: { backend: "typesafe", model: "jev-latest",
    endpoint: "https://gateway.example.test/v1/systemone" } });
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, "https://gateway.example.test/v1/systemone");
    const payload = JSON.parse(init?.body as string);
    assert.equal(payload.questions.route.type, "choice");
    assert.equal(payload.input, undefined);
    const choice = Object.keys(payload.questions.route.criteria).find((id) =>
      payload.questions.route.criteria[id].model === executor.id);
    return new Response(JSON.stringify({ answers: { route: { type: "choice", choice } } }));
  }) as typeof fetch;
  assert.equal((await routeRequest(request(), h.ctx, typesafe,
    { ...h.options, fetch: fetcher, decisionKey: "key" })).model, executor);
});

test("OpenAI Decisions uses its own wire format and a configurable full endpoint", async () => {
  const h = setup();
  const openai = parseConfig({ qualifier: { backend: "openai", model: "gpt-6-luna",
    endpoint: "https://gateway.example.test/v1/decisions", apiKeyEnv: "GATEWAY_KEY" } });
  let calls = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.equal(url, "https://gateway.example.test/v1/decisions");
    assert.equal(init?.redirect, "error");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer decision-test-key");
    const payload = JSON.parse(init?.body as string);
    assert.equal(payload.model, "gpt-6-luna");
    assert.equal(typeof payload.input, "string");
    assert.equal(JSON.parse(payload.input).task, "Fix the bug");
    assert.equal(payload.questions.length, 1);
    assert.equal(payload.questions[0].name, "route");
    assert.equal(payload.questions[0].type, "choice");
    const choice = payload.questions[0].choices.find((entry: { value: string; description: string }) => {
      const description = JSON.parse(entry.description);
      return description.model === executor.id && description.thinkingLevel === "high";
    });
    assert(choice);
    return new Response(JSON.stringify({ answers: [{ name: "route", type: "choice", choice: choice.value,
      confidence: 1, probabilities: [{ value: choice.value, probability: 1 }] }],
      usage: { input_tokens: 42, output_tokens: 0, total_tokens: 42 } }));
  }) as typeof fetch;
  const prior = process.env.GATEWAY_KEY;
  process.env.GATEWAY_KEY = "decision-test-key";
  try {
    const route = await routeRequest(request(), h.ctx, openai, { ...h.options, fetch: fetcher });
    assert.equal(route.model, executor);
    assert.equal(route.thinkingLevel, "high");
    assert.equal(calls, 1);
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.records[0]?.usage, { input_tokens: 42, output_tokens: 0 });
    assert.equal(h.records[0]?.confidence, 1);
    assert.equal(h.records[0]?.probabilities?.[0]?.model, executor.id);
    assert.equal(h.records[0]?.probabilities?.[0]?.thinkingLevel, "high");
    assert.equal(h.records[0]?.probabilities?.[0]?.probability, 1);
    assert(!JSON.stringify(h.records).includes("decision-test-key"));
  } finally {
    if (prior === undefined) delete process.env.GATEWAY_KEY;
    else process.env.GATEWAY_KEY = prior;
  }
});

test("decision diagnostics filter unsafe scores without changing fallback or synthesizing probabilities", async () => {
  for (const backend of ["typesafe", "openai"] as const) {
    const h = setup();
    const config = parseConfig({ qualifier: { backend, model: "decision", fallback: { provider: "test", model: "small" } } });
    const scores = { option_0: 0, option_1: 0.4, option_2: -1, option_3: 2,
      option_4: "0.5", option_5: null, option_999: 0.9, SECRET_RESPONSE: 0.8 };
    const fetcher = (async () => {
      const answer = { type: "choice", choice: "option_999", confidence: 2,
        probabilities: backend === "typesafe" ? scores
          : Object.entries(scores).map(([value, probability]) => ({ value, probability })) };
      return new Response(JSON.stringify({ answers: backend === "typesafe" ? { route: answer }
        : [{ ...answer, name: "route" }] }));
    }) as typeof fetch;
    const route = await routeRequest(request(), h.ctx, config, { ...h.options, fetch: fetcher, decisionKey: "key" });
    assert.equal(route.model, qualifier);
    assert.equal(h.records[0]?.outcome, "fallback");
    assert.equal(h.records[0]?.confidence, undefined);
    assert.deepEqual(h.records[0]?.probabilities?.map(({ option, probability }) => ({ option, probability })),
      [{ option: "option_0", probability: 0 }, { option: "option_1", probability: 0.4 }]);
    assert(!JSON.stringify(h.records).includes("SECRET_RESPONSE"));
    const absent = (async () => new Response(JSON.stringify({ answers: backend === "typesafe"
      ? { route: { type: "choice", choice: "option_0" } }
      : [{ name: "route", type: "choice", choice: "option_0" }] }))) as typeof fetch;
    await routeRequest(request(), h.ctx, config, { ...h.options, fetch: absent, decisionKey: "key" });
    assert.equal(h.records[1]?.probabilities, undefined);
    assert.equal(h.records[1]?.confidence, undefined);
  }
});

test("OpenAI refusals and non-OpenAI-shaped replies fall back without guessing", async () => {
  const h = setup();
  const openai = parseConfig({ qualifier: { backend: "openai", model: "gpt-6-luna",
    fallback: { provider: "test", model: "small" } } });
  for (const answers of [[{ name: "route", type: "refusal" }],
    { route: { type: "choice", choice: "option_0" } },
    [{ name: "other", type: "choice", choice: "option_0" }]]) {
    const fetcher = (async () => new Response(JSON.stringify({ answers }))) as typeof fetch;
    const route = await routeRequest(request(), h.ctx, openai,
      { ...h.options, fetch: fetcher, decisionKey: "test-key" });
    assert.equal(route.model, qualifier);
    assert.equal(h.records.at(-1)?.reason, "invalid-output");
  }
});

test("TypeSafe failures use only previous/explicit fallback; invalid options and disappeared routes never dispatch", async () => {
  const h = setup();
  const typesafe = parseConfig({ qualifier: { backend: "typesafe", model: "jev-latest",
    fallback: { provider: "test", model: "small" } } });
  const bad = (async () => new Response(JSON.stringify({ answers: { route: { type: "choice", choice: "option_999" } } }))) as typeof fetch;
  assert.equal((await routeRequest(request(), h.ctx, typesafe, { ...h.options, fetch: bad, decisionKey: "key" })).model, qualifier);
  assert.equal(h.records[0]?.reason, "invalid-output");
  const previous = { model: executor, thinkingLevel: "low" as const };
  assert.equal((await routeRequest(request({ previous }), h.ctx, typesafe,
    { ...h.options, fetch: bad, decisionKey: "key" })).thinkingLevel, "low");
  assert.equal((await routeRequest(request(), h.ctx, typesafe, { ...h.options, decisionKey: "" })).model, qualifier);
  // An absent key is tested with an empty environment, not a paid API call.
  const noFallback = parseConfig({ qualifier: { backend: "typesafe", model: "jev-latest" } });
  await assert.rejects(routeRequest(request(), h.ctx, noFallback,
    { ...h.options, fetch: bad, decisionKey: "key" }), /no eligible fallback/);
  assert.equal(h.records.at(-1)?.outcome, "error");
  const disappearing = (async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(init?.body as string);
    const choice = Object.keys(payload.questions.route.criteria).find((id) =>
      payload.questions.route.criteria[id].model === executor.id);
    h.available([qualifier, auto]);
    return new Response(JSON.stringify({ answers: { route: { type: "choice", choice } } }));
  }) as typeof fetch;
  assert.equal((await routeRequest(request(), h.ctx, typesafe,
    { ...h.options, fetch: disappearing, decisionKey: "key" })).model, qualifier);
  assert.equal(h.records.at(-1)?.reason, "invalid-output");
});

test("decision classifier rejects more than 255 pairs without dropping candidate options", async () => {
  const h = setup();
  h.available([qualifier, ...Array.from({ length: 256 }, (_, i) => model(`m${i}`, { reasoning: false })), auto]);
  const typesafe = parseConfig({ qualifier: { backend: "typesafe", model: "jev-latest",
    fallback: { provider: "test", model: "small" } } });
  let calls = 0;
  const route = await routeRequest(request(), h.ctx, typesafe, { ...h.options, decisionKey: "key",
    fetch: (async () => { calls++; throw new Error("not expected"); }) as typeof fetch });
  assert.equal(route.model, qualifier);
  assert.equal(calls, 0);
  assert.equal(h.records[0]?.reason, "input-too-large");
});

test("TypeSafe deadline and cancellation abort fetch without late decision records", async () => {
  const h = setup();
  const typesafe = parseConfig({ qualifier: { backend: "typesafe", model: "jev-latest",
    fallback: { provider: "test", model: "small" } } });
  let complete!: (response: Response) => void;
  let started!: () => void;
  let signal: AbortSignal | undefined;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    signal = init?.signal as AbortSignal;
    started();
    return new Promise<Response>((resolve) => { complete = resolve; });
  }) as typeof fetch;
  const controller = new AbortController();
  const pending = routeRequest(request({ signal: controller.signal }), h.ctx, typesafe,
    { ...h.options, fetch: fetcher, decisionKey: "key" });
  await ready;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(signal?.aborted, true);
  complete(new Response('{}'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.records.length, 0);
  const timed = await routeRequest(request(), h.ctx, typesafe,
    { ...h.options, fetch: fetcher, decisionKey: "key", timeoutMs: 10 });
  assert.equal(timed.model, qualifier);
  assert.equal(signal?.aborted, true);
  assert.equal(h.records[0]?.reason, "timeout");
  complete(new Response('{}'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.records.length, 1);
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
