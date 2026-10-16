// Live check against a local Kev server (System One compatible). Skipped unless KEV_URL is set:
//   KEV_URL=http://127.0.0.1:8009/v1/systemone KEV_MODEL=kev-latest node --test test/kev.live.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { parseConfig, routeRequest, type RouterContext, type RoutingRecord } from "../src/router.ts";

const url = process.env.KEV_URL;
const model = (id: string, cost: number): Model<Api> => ({
  id, name: id, api: "openai-completions", provider: "test", baseUrl: "https://invalid.test",
  reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 8192,
  cost: { input: cost, output: cost, cacheRead: 0, cacheWrite: 0 },
});
const cheap = model("cheap-small", 0.1);
const strong = model("strong-large", 10);
const auto = { ...model("auto", 0), provider: "router", api: "pi-virtual" } as Model<Api>;

test("router selects a valid route through a live Kev /v1/systemone server", { skip: !url }, async () => {
  const ctx: RouterContext = { scopedModels: [], modelRegistry: {
    getAvailable: () => [cheap, strong, auto], findOfType: () => undefined,
    classify: async () => { throw new Error("unexpected"); },
    streamSimple: () => { throw new Error("unexpected chat call"); } } };
  const records: RoutingRecord[] = [];
  const saved = process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_API_KEY;
  try {
    const route = await routeRequest(
      { model: auto, thinkingLevel: "off", reason: "user",
        messages: [{ role: "user", content: "Design a distributed consensus protocol and prove its safety.", timestamp: 1 }] },
      ctx, parseConfig({ qualifier: { backend: "typesafe", model: process.env.KEV_MODEL ?? "kev-latest", endpoint: url } }),
      { timeoutMs: 60_000, onDecision: (r) => records.push(r) });
    console.log(JSON.stringify(records[0], null, 1));
    assert.equal(records[0]?.outcome, "selected", `reason: ${records[0]?.reason}`);
    assert([cheap, strong].includes(route.model as Model<Api>));
    assert(records[0]?.probabilities?.length);
  } finally { if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved; }
});
