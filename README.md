# Pi Model Router

A minimal Pi extension: a small **qualifier** model picks the execution model and reasoning effort for each new user turn. No model tiers, ranking database, provider SDKs, or custom UI.

Uses Pi's native virtual-model API. **Tested with Pi 0.99.1 and Node 22.19+ APIs.** Older Pi versions without virtual models are unsupported.

## Setup

1. Authenticate your models with Pi (`/login`). Use `pi --list-models` to find exact provider/model IDs.
2. Create `~/.pi/agent/model-router.json` (or `model-router.json` inside `PI_CODING_AGENT_DIR`):

   ```json
   {
     "qualifier": {
       "provider": "your-provider",
       "model": "your-small-model-id"
     }
   }
   ```

   Replace the placeholders with one available **physical chat model**, not a virtual router or a classifier-only model. Existing Pi credentials are reused; do not put secrets in this file. A small model that reliably produces JSON is a good starting point.

3. From this checkout, try it without changing your installed packages or defaults:

   ```sh
   pi -e ./src/index.ts --model router/auto
   ```

   For a persistent local install:

   ```sh
   pi install npm:@singleton11/pi-model-router
   ```

   Then `/reload` and select **Auto (model router)** in `/model`. Saving Auto as a startup default is your choice; the extension never changes defaults.

The virtual thinking level is `off`; **this does not disable the executor's reasoning**. Physical effort is selected automatically and shown with the dispatched model in Pi's normal footer and the router status.

Select a physical model in `/model` to bypass routing for subsequent requests. Edit the qualifier config and `/reload` to change it. An absent/invalid config only prevents Auto requests; ordinary model selection remains usable.

For embedded SDK use, set `PI_CODING_AGENT_DIR` as well as the SDK's `agentDir` if you override it: Pi's public `getAgentDir()` helper, used by this extension, reads the environment/default location.

### Status/footer troubleshooting

The router publishes only the `model-router` status; it never replaces or hides Pi's footer. If the whole footer disappears, distinguish that from missing model/effort text. With `pi-zentui` installed, try `/zentui footer` and choose **Native** to isolate its replacement footer. Custom footers may not display Pi's physical dispatch or correctly resolve virtual-model context limits. Run `/reload` after updating this extension.

## Execution candidates and scope

With no model scope, Auto considers every authenticated physical chat model in Pi's current registry. With a resolved scope, only its physical models are eligible, including any pinned effort levels. The configured qualifier can be outside the execution scope.

Use Pi's `/scoped-models` to restrict providers/models. **Include `router/auto` alongside your physical execution models.** Selecting only Auto leaves no executors; the router errors rather than broadening that scope.

For a one-off scoped launch (replace the example IDs):

```sh
pi -e ./src/index.ts --model router/auto \
  --models 'router/auto,your-provider/small-model,your-provider/strong-model'
```

Pi exposes resolved scopes, not raw CLI patterns, to extensions. A saved `enabledModels` scope that resolves to nothing is rejected. An entirely unmatched CLI-only `--models` list is indistinguishable from no scope through that API; including the registered `router/auto` prevents this ambiguity. Scopes restrict dispatch, not the qualifier's explicitly configured provider.

If the current request includes images—including historical tool-result images—only image-capable models are eligible. The router does not deliberately let Pi replace images with placeholders.

## Routing policy

| Request | Behavior |
| --- | --- |
| New user message, queued steering or follow-up | One qualifier call selects model + effort. |
| Tool/extension continuation | Keep the previous physical route. |
| Automatic retry | Keep the failed route, or previous route if absent. |
| Direct request, such as compaction | Previous route, otherwise eligible qualifier; no classification. |

Qualification is **quality-first**: assess task complexity, uncertainty, and model capability before cost. The prompt suggests medium effort for substantive implementation/debugging/review, high for difficult or higher-risk work, and low effort for trivial tasks, always within the allowed levels. Price and cache reuse are tie-breakers among comparably suitable choices, not reasons to avoid a needed upgrade. These are qualifier instructions, not enforced effort floors or a benchmarked capability ranking.

The qualifier receives bounded task/recent-conversation text and candidate metadata. It does **not** receive the full system prompt, tools, tool outputs, reasoning blocks, or image bytes. The executor receives Pi's normal context and tools; the extension never rewrites that context. Pi still owns compaction and retries.

Qualifier calls use no tools, the qualifier's lowest supported effort, a 512-token output allowance (capped by the model's output limit), no SDK retries where supported, and a **5-second deadline**. Input uses a conservative byte-based context allowance plus a fixed 32 KB cap; oversized catalogs fall back visibly rather than dropping candidates. Narrow `/scoped-models` when needed.

Only complete successful JSON selecting an eligible model and permitted effort is accepted. A new user turn can select a stronger model or higher effort; there is no repair prompt, mid-turn automatic escalation, or phase switching.

### Failure and cancellation

- Qualification fails or times out: reuse the previous eligible model/effort.
- No usable previous route: use the qualifier itself at its lowest permitted effort **only when it is an eligible executor**, respecting scope pins and image support.
- No eligible fallback: stop with an actionable error. No arbitrary model or out-of-scope dispatch.
- A sticky continuation/retry becomes ineligible: stop rather than silently switching models.
- User cancellation: propagate it without falling back. Late qualifier responses cannot trigger execution or session writes. An uncooperative provider may still finish/bill its already-started request.

Fallback produces a short UI warning (stderr in print/JSON mode). Successful decisions and fallback outcomes are stored as `model-router.decision` custom session entries: qualifier reference, outcome, duration, reported usage, reason code, selected model/effort. Prompt excerpts and raw provider errors are not copied into these records.

**Qualifier usage is not added to Pi's executor totals by these custom entries.** Count it separately when evaluating savings. A provider may not report usage for a timed-out request; a discarded late response is not retrospectively recorded.

## Development and verification

```sh
npm ci --ignore-scripts
npm run check
```

Pi host packages are peers and pinned development dependencies; they are not bundled runtime dependencies. There is no build step: Pi loads the TypeScript extension directly.

Tests make **no paid model calls**:

- Policy tests: all routing reasons, validation, fallback, scopes/pins, images, input bounds, cancellation/deadlines and late results.
- Real Pi SDK tests: load `src/index.ts` through Pi's extension loader; exercise model/effort dispatch, normal tool execution, steering/follow-up, retry, compaction, abort, reload (including during qualification), persisted resume and manual bypass with the built-in faux provider.
- Native regular/fullscreen TUI tests with a disposable terminal: Auto selection, first/current route status, manual bypass and reload restoration. These verify footer component output, not a real terminal's on-screen rendering.

Source is deliberately small: `src/index.ts` wires configuration/registration/records; `src/router.ts` contains routing policy.

### Optional live evaluation

The extension is not a benchmarked quality or savings guarantee. Before making Auto your default, try about ten representative tasks against your usual fixed-model baseline in disposable workspaces: simple edits, explanation, debugging, multi-file changes and short follow-ups. Record success, total tokens/catalog cost **including qualifier entries**, routing delay and fallback rate in a small table. For subscription models, catalog prices are not actual marginal billing.

The qualifier's learned model knowledge may be stale; catalog prices are not intelligence rankings. Model switches can lose prompt caches or trigger compaction. Auto permits your normal conversation to be sent to any eligible execution provider, and the excerpt to the qualifier provider—restrict the pool if this matters.

See [the approved MVP plan](docs/mvp-plan.md) and [the Google Doc reference](docs/google-doc.md). Local documentation and the review document are not automatically synchronized.
