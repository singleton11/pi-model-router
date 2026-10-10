# Pi Model Router

A Pi extension that routes each new user turn to a physical model and supported thinking level. A configured **qualifier** uses either a Pi chat model, TypeSafe System One, or OpenAI Decisions to choose; Pi then runs the selected executor with its normal prompt, tools, and context.

No model rankings or tier database: choices use the models available in your Pi installation and any active model scope.

> **Compatibility:** Requires Pi with the native virtual-model API (tested with Pi 0.99.1) and Node.js 22.19 or newer.

## Install

First, authenticate at least one provider in Pi and confirm its models appear in `pi --list-models`.

Install the published npm package for your personal Pi setup:

```sh
pi install npm:@singleton11/pi-model-router
```

Pi packages can execute code. Review the [source](https://github.com/singleton11/pi-model-router) before installing if you want to inspect what will run.

Create `~/.pi/agent/model-router.json` (or `model-router.json` inside the directory selected by `PI_CODING_AGENT_DIR`). Choose one of three qualifier backends. For an authenticated **physical Pi chat model** (the original configuration):

```json
{
  "qualifier": {
    "provider": "your-provider",
    "model": "your-small-model-id"
  }
}
```

Use the exact provider and model IDs shown by Pi. The chat qualifier should follow instructions and return JSON reliably; existing Pi credentials are reused.

For **TypeSafe System One**:

```json
{
  "qualifier": {
    "backend": "typesafe",
    "model": "jev-latest",
    "fallback": { "provider": "your-provider", "model": "your-physical-model-id" }
  }
}
```

Use `/login typesafe` to enter your TypeSafe key privately, or set `TYPESAFE_API_KEY` before starting Pi. Direct Jev uses Pi's classifier registry and credential handling, not a chat model. With no fallback, a missing key stops the request; the optional physical fallback above lets the router continue while credentials are being configured.

For **OpenAI Decisions** (a separate wire protocol, not just a TypeSafe URL change):

```json
{
  "qualifier": {
    "backend": "openai",
    "model": "gpt-6-luna"
  }
}
```

Set `OPENAI_API_KEY` in Pi's environment. The default endpoint is `https://api.openai.com/v1/decisions`. An OpenAI-compatible gateway might require a different model ID.

For either decision backend, optional fields on `qualifier` are:

```json
{
  "qualifier": {
    "backend": "openai",
    "model": "your-gateway-model-id",
    "endpoint": "https://your-gateway.example/v1/decisions",
    "apiKeyEnv": "YOUR_GATEWAY_API_KEY",
    "fallback": { "provider": "your-provider", "model": "your-physical-model-id" }
  }
}
```

`endpoint` is a **full request URL** for the chosen protocol, not a base URL. Use a TypeSafe-compatible `/v1/systemone` endpoint with `typesafe`, or an OpenAI-compatible `/v1/decisions` endpoint with `openai`. Only HTTPS endpoints are accepted, except local HTTP on loopback; redirects are rejected to avoid forwarding bearer credentials. `apiKeyEnv` names an environment variable, not a secret value. Never put API keys in the JSON. A custom TypeSafe `endpoint` or `apiKeyEnv` uses direct HTTP instead of Pi's credential registry. `fallback` is optional: on failure the previous eligible physical route is reused first, then this explicitly configured physical model. Without either, the request fails closed. OpenAI Decisions and custom endpoints require independent API credentials.

Restart Pi (or run `/reload` in a running session), then open `/model` and select **Auto (model router)**. To verify it is active, send a new user message: the footer shows the physical model and effort chosen for execution. Choosing a physical model in `/model` bypasses routing. The extension never changes your startup model default.

### Try it without installing

To load directly from a checkout for one Pi invocation:

```sh
pi -e ./src/index.ts --model router/auto
```

## Configure eligible models

By default, Auto can choose from all authenticated physical chat models in Pi's registry. Use Pi's `/scoped-models` to limit the execution candidates. Include `router/auto` **and** the physical models you want available; a scope containing only Auto has no executor and fails closed. The qualifier can be outside the execution scope.

For a one-off scoped launch (replace the example IDs):

```sh
pi --model router/auto \
  --models 'router/auto,your-provider/small-model,your-provider/strong-model'
```

Only image-capable models are eligible when the conversation contains images, including images in historical tool results. Effort choices are limited to each model's supported thinking levels and any scope pins.

## How routing works

| Request | Behavior |
| --- | --- |
| New user message, queued steering, or follow-up | One chat or decision API call chooses an executor and effort (unless only one pair is eligible). |
| Tool/extension continuation | Retains the previous physical route. |
| Automatic retry | Retains the failed route (or previous route if unavailable). |
| Direct request, such as compaction | Uses the previous route, or the eligible configured physical fallback (the chat qualifier for legacy configuration); no classification. |

Routing is quality-first: the qualifier is instructed to consider task complexity, uncertainty, risk, and model capability before cost. The guidance suggests medium effort for substantive implementation, debugging, and review; high for difficult or higher-risk work; and low for trivial tasks, always within supported levels. Price and cache reuse are tie-breakers between comparably suitable choices—not capability rankings or enforced effort floors.

The qualifier receives bounded task and recent-conversation text plus candidate metadata. It does **not** receive the full system prompt, tools, tool outputs, reasoning blocks, or image bytes. Decision backends receive a closed set of *eligible model/effort pairs*, never arbitrary model IDs. The selected executor receives Pi's normal context and tools. A new user turn can select a stronger model or higher effort; there is no mid-turn escalation or phase switching.

Chat qualifier calls use no tools, the qualifier's lowest supported effort, and a 512-token output limit (capped by its model limit). All classifier calls have a five-second deadline. If qualification fails or times out, the router reuses the previous eligible route. If none is available, it uses only the eligible configured physical fallback (for chat, the qualifier itself). Otherwise the request stops with an error rather than silently choosing an arbitrary or out-of-scope model. User cancellation is propagated without fallback. More than 255 candidate model/effort pairs or an oversized decision payload fails classification without silently dropping options.

Successful decisions and fallback outcomes are recorded as `model-router.decision` session entries. Qualifier usage (including decision API token counts when reported) is **not** included in Pi's executor totals; account for it separately when evaluating cost or savings. Timed-out providers may not report usage, and late responses are discarded.

## Troubleshooting

- **Auto does not appear in `/model`:** Check Pi compatibility, then run `/reload` or restart Pi. Confirm the package is installed with `pi list` and enabled with `pi config`.
- **Auto reports a missing/invalid qualifier:** Check the JSON syntax, model ID, API key environment variable, and endpoint protocol in `model-router.json`; then `/reload`.
- **No eligible executor:** Expand the model scope to include `router/auto` and at least one authenticated physical chat model that supports the request (including vision for image-bearing context).
- **Footer is missing:** The router publishes only its own status and does not replace Pi's footer. If `pi-zentui` is installed, try `/zentui footer` and choose **Native** to isolate its replacement footer.

For embedded SDK use, set `PI_CODING_AGENT_DIR` as well as the SDK's `agentDir` if you override it: Pi's public `getAgentDir()` helper reads the environment/default location.

## Development

```sh
npm ci --ignore-scripts
npm run check
```

Pi host packages are peer dependencies and development dependencies; they are not bundled as runtime dependencies. Pi loads the TypeScript extension directly—there is no build step. Tests make no paid model calls. They cover routing policy, validation, fallback, scopes, effort pins, images, cancellation/deadlines, Pi SDK integration, reload/resume behavior, and native regular/fullscreen TUI footer output.

The extension entry point and package manifest are `src/index.ts` and `package.json`; `src/router.ts` contains routing policy.

## Evaluation and limitations

This extension does not guarantee better quality or lower cost. Before making Auto your default, compare representative tasks with your usual fixed-model setup. Include qualifier latency and usage, cache misses, quality, and fallback rate; catalog prices are not actual marginal costs for subscription models. Model switches may lose prompt caches or trigger compaction, and the qualifier's learned model knowledge may be stale.

Auto may send your conversation to any eligible execution provider and a bounded excerpt to the configured qualifier endpoint. An endpoint override receives both the bearer key and the excerpt; choose providers accordingly and restrict the candidate scope.
