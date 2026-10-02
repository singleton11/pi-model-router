import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseConfig, routeRequest, type RouterConfig } from "./router.ts";

export default function modelRouter(pi: ExtensionAPI): void {
  if (typeof pi.registerVirtualModel !== "function") {
    throw new Error("Model router requires Pi's virtual-model API. Upgrade Pi (tested on 0.99.1).");
  }
  const path = join(getAgentDir(), "model-router.json");
  let config: RouterConfig | undefined;
  let configError: string | undefined;
  try {
    config = parseConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // Do not expose file contents or make ordinary, non-Auto sessions unusable.
    configError = `Router: configure ${path} with {"qualifier":{"provider":"exact-provider","model":"exact-model-id"}}, then /reload.`;
  }

  const isCompletedRoute = (message: AssistantMessage) =>
    message.api !== "pi-virtual" && message.stopReason !== "aborted" && message.stopReason !== "error";
  const updateStatus = (ctx: ExtensionContext, completed?: AssistantMessage) => {
    if (!ctx.hasUI) return;
    if (ctx.model?.provider !== "router" || ctx.model.id !== "auto") {
      ctx.ui.setStatus("model-router", undefined);
      return;
    }
    // message_end fires BEFORE persistence: use its message, not the previous entry.
    // Other lifecycle events reconstruct only the active branch, never abandoned routes.
    const entry = ctx.sessionManager.getBranch().findLast((entry) =>
      entry.type === "message" && entry.message.role === "assistant" && isCompletedRoute(entry.message));
    const message = completed && isCompletedRoute(completed) ? completed
      : entry?.type === "message" && entry.message.role === "assistant" ? entry.message : undefined;
    const text = message
      ? `→ ${message.provider}/${message.model} · ${message.thinkingLevel ?? "off"}`
      : "Auto · awaiting first route";
    ctx.ui.setStatus("model-router", ctx.ui.theme.fg("dim", text));
  };
  // Register once; each event supplies a current context, including startup/resume/reload.
  pi.on("session_start", (_event, ctx) => updateStatus(ctx));
  pi.on("model_select", (_event, ctx) => updateStatus(ctx));
  pi.on("session_tree", (_event, ctx) => updateStatus(ctx));
  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant") updateStatus(ctx, event.message);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("model-router", undefined);
  });

  pi.registerVirtualModel({
    provider: "router",
    id: "auto",
    name: "Auto (model router)",
    thinkingLevels: ["off"], // Virtual selection only; physical effort is automatic.
    async route(request, ctx) {
      request.signal?.throwIfAborted();
      if (ctx.hasUI && ctx.model?.provider === "router" && ctx.model.id === "auto") {
        ctx.ui.setStatus("model-router", ctx.ui.theme.fg("dim", "Classifying…"));
      }
      if (!config) throw new Error(configError);
      // Pi collapses an unresolved settings scope to []; don't mistake it for unrestricted.
      if (ctx.scopedModels.length === 0 && pi.getSettings().enabledModels?.length) {
        throw new Error("Router: the configured model scope resolved to no models. Include router/auto and available physical models in /scoped-models.");
      }
      const route = await routeRequest(request, ctx, config, {
        onDecision(record) {
          request.signal?.throwIfAborted();
          // Pi rejects stale APIs after reload/replacement. Do not swallow that error:
          // an old route must not write into or dispatch from a new session.
          pi.appendEntry("model-router.decision", record);
          if (record.outcome === "fallback") {
            const selected = record.selected!;
            const hint = record.reason === "input-too-large" ? " Narrow /scoped-models." : "";
            const notice = `Router fallback (${record.reason}): ${selected.provider}/${selected.model} · ${selected.thinkingLevel}.${hint}`;
            if (ctx.hasUI) ctx.ui.notify(notice, "warning");
            else console.error(notice);
          }
        },
      });
      request.signal?.throwIfAborted();
      pi.getSettings(); // Also assert the runtime is still active on non-qualifying paths.
      return route;
    },
  });
}
