import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// DSH core dependencies are provided by the host's module resolver when this
// plugin is loaded by DeepSeek Harness. Optional env override points at a
// non-standard core node_modules root if a host uses a custom layout.
const CORE = process.env.DSH_CORE_MODULES
  ? "file:///" + process.env.DSH_CORE_MODULES.replace(/\\/g, "/").replace(/\/$/, "") + "/"
  : "";
async function loadDeps(bare, deep) {
  try { return await import(bare); } catch {}
  if (CORE) { try { return await import(CORE + deep); } catch {} }
  return {};
}
const { defineTool } = await loadDeps("@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-tools/lib/index.js");
const { createProvider } = await loadDeps("@earendil-works/pi-ai", "@earendil-works/pi-ai/dist/index.js");
const { openAICompletionsApi } = await loadDeps("@earendil-works/pi-ai/api/openai-completions.lazy", "@earendil-works/pi-ai/dist/api/openai-completions.lazy.js");
const { PiAiAdapter } = await loadDeps("@deepseek-ai/dsh-llm-pi-ai", "@deepseek-ai/dsh-llm-pi-ai/lib/index.js");
const { resolveRetryPolicy } = await loadDeps("@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-llm/lib/index.js");

export const name = "dsh-model-relay";
export const inject = ["tools", "llm"];

// Self-contained runtime lives inside this plugin package.
const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(HERE, "runtime");
const STATE_DIR = join(homedir(), ".dsh", "model-relay");
const PID_FILE = join(STATE_DIR, "relay.pid");
const PORT_FILE = join(STATE_DIR, "relay.port");
const LOG_FILE = join(STATE_DIR, "relay.log");

// Provider route + catalogue. These are the public names from the screenshot.
const ROUTE = "orcaterm-relay";
const MODELS = [
  { id: "Deepseek-V4-Pro", name: "DeepSeek V4 Pro (OrcaTerm)", contextWindow: 131072, maxOutput: 8192 },
  { id: "DeepSeek-V4-Flash", name: "DeepSeek V4 Flash (OrcaTerm)", contextWindow: 131072, maxOutput: 8192 },
  { id: "DeepSeek-V4.1-Flash", name: "DeepSeek V4.1 Flash (OrcaTerm)", contextWindow: 131072, maxOutput: 8192 },
  { id: "Kimi-K3", name: "Kimi K3 (OrcaTerm)", contextWindow: 131072, maxOutput: 8192 },
  { id: "GLM-5.3-Flash", name: "GLM 5.3 Flash (OrcaTerm)", contextWindow: 131072, maxOutput: 8192 },
  { id: "GLM-5.3", name: "GLM 5.3 (OrcaTerm)", contextWindow: 131072, maxOutput: 8192 },
  { id: "GLM-5.2", name: "GLM 5.2 (OrcaTerm)", contextWindow: 131072, maxOutput: 8192 },
  { id: "Hy4", name: "HY4 (OrcaTerm)", contextWindow: 131072, maxOutput: 8192 },
  { id: "Hy3", name: "HY3 (OrcaTerm)", contextWindow: 131072, maxOutput: 8192 },
];

function ensureState() { if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true }); }
function findPython() {
  for (const base of [RUNTIME]) {
    const py = join(base, ".venv", "Scripts", "python.exe");
    if (existsSync(py)) return { py, cwd: base };
  }
  return { py: "python", cwd: RUNTIME };
}
function readText(p, f) { try { return readFileSync(p, "utf8").trim(); } catch { return f; } }
function readPid() { const n = parseInt(readText(PID_FILE, ""), 10); return Number.isFinite(n) ? n : null; }
function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
function baseUrl(port) { return `http://127.0.0.1:${port}`; }
function port() { return Number(readText(PORT_FILE, "8001")); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function probe(p) {
  try { const r = await fetch(`${baseUrl(p)}/health`, { signal: AbortSignal.timeout(2500) }); return { ok: r.ok, body: await r.json().catch(() => ({})) }; }
  catch (e) { return { ok: false, error: String(e) }; }
}
async function ensureRelay() {
  if (alive(readPid())) return true;
  const { py, cwd } = findPython();
  ensureState();
  const log = openSync(LOG_FILE, "a");
  const child = spawn(py, ["-m", "lightai_relay", "--config", "lightai.yaml", "--port", String(port())], {
    cwd, detached: true, stdio: ["ignore", log, log],
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  for (let i = 0; i < 20; i++) { await sleep(300); if ((await probe(port())).ok) return true; }
  return false;
}

// ---------------------------------------------------------------------------
// LLM provider adapter: streams DSH chat through our local OpenAI-compatible relay.
// ---------------------------------------------------------------------------
/** OrcaTerm wraps its answer as {"action","thinking","taskCompletion"} — often
 *  inside a ```json fence. Pull the prose out so the UI shows a normal reply. */
function parseAcp(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    if (obj && typeof obj === "object" && ("taskCompletion" in obj || "action" in obj)) {
      return {
        action: obj.action,
        thinking: typeof obj.thinking === "string" ? obj.thinking : "",
        taskCompletion: typeof obj.taskCompletion === "string" ? obj.taskCompletion : "",
      };
    }
  } catch {}
  return null;
}

function makeAdapter() {
  const toOpenAiMessages = (messages = []) => messages
    .filter((m) => m && typeof m === "object")
    .map((m) => {
      let content = m.content;
      if (Array.isArray(content)) {
        content = content.map((c) => {
          if (typeof c === "string") return c;
          if (c?.type === "text") return c.text ?? "";
          if (c?.type === "image" || c?.type === "image_url") return ""; // text-only lane
          return "";
        }).join("");
      }
      let role = m.role ?? "user";
      if (role === "system") role = "system";
      else if (role === "assistant" || role === "tool") role = role === "tool" ? "assistant" : "assistant";
      else role = "user";
      return { role, content: String(content ?? "") };
    });

  return {
    providerInfo(provider) { return { id: provider, name: "OrcaTerm 反代模型" }; },
    providerRetryPolicy() { return { mode: "normal", maxRetries: 1, retryableCodes: ["EMPTY_RESPONSE", "SERVER", "TIMEOUT", "TRANSPORT"], initialDelayMs: 500, maxDelayMs: 4000, jitterRatio: 0.2 }; },
    async listModels(provider) {
      return MODELS.map((m) => ({ provider, id: m.id, name: m.name, description: "OrcaTerm 反代模型", inputModalities: ["text"] }));
    },
    async resolveModel(provider, model) {
      const id = String(model || "").replace(/^orcaterm-relay[/:]/, "");
      const entry = MODELS.find((m) => m.id === id) ?? { id, name: id, contextWindow: 131072, maxOutput: 8192 };
      return { provider, id: entry.id, name: entry.name, inputModalities: ["text"], context: { contextWindow: entry.contextWindow }, defaultMaxTokens: entry.maxOutput };
    },
    async prepareCall(provider, model, signal) {
      const resolved = await this.resolveModel(provider, model);
      return { model: resolved, stream: (options) => this.stream(options) };
    },
    stream(options) {
      const controller = new AbortController();
      const onAbort = () => controller.abort(options.signal?.reason);
      if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener?.("abort", onAbort, { once: true });
      const iterator = this.runStream({ ...options, signal: controller.signal });
      const cleanup = () => options.signal?.removeEventListener?.("abort", onAbort);
      const step = async (method, value) => {
        try { const row = await iterator[method](value); if (row.done) cleanup(); return row; }
        catch (e) { cleanup(); throw e; }
      };
      return { [Symbol.asyncIterator]() { return this; }, next: (v) => step("next", v), return: (v) => { controller.abort(); cleanup(); return step("return", v); }, throw: (e) => { controller.abort(e); cleanup(); return step("throw", e); } };
    },
    async *runStream(options) {
      let textIndex = 0, rawText = "", rawReasoning = "", gotAny = false;
      // The upstream reports no usage, so estimate tokens (~1.7 chars/token for
      // mixed zh/en) to keep the token meter and tok/s readout meaningful.
      const estTokens = (chars) => Math.max(0, Math.round(chars / 1.7));
      const inChars = (options.messages ?? []).reduce((n, m) => {
        const c = m?.content;
        const len = typeof c === "string" ? c.length : Array.isArray(c) ? c.reduce((k, p) => k + String(p?.text ?? "").length, 0) : 0;
        return n + len + 8;
      }, 0);
      const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      // Each block closes with its assembled payload; the harness reads block.type.
      const emitBlock = function* (kind, text) {
        if (!text) return;
        yield { type: "block-start", index: textIndex, blockType: kind };
        yield kind === "reasoning"
          ? { type: "reasoning-delta", index: textIndex, text }
          : { type: "text-delta", index: textIndex, text };
        yield { type: "block-end", index: textIndex, block: { type: kind, text } };
        textIndex++;
      };
      try {
        const ready = await ensureRelay();
        if (!ready) throw new Error("OrcaTerm relay did not start");
        const resp = await fetch(`${baseUrl(port())}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: String(options.model || "Deepseek-V4-Pro").replace(/^orcaterm-relay[/:]/, ""), messages: toOpenAiMessages(options.messages), stream: true, temperature: options.temperature }),
          signal: options.signal,
        });
        if (!resp.ok || !resp.body) throw new Error(`relay HTTP ${resp.status}`);
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        const flush = async function* (line) {
          const s = line.trim();
          if (!s.startsWith("data:")) return;
          const data = s.slice(5).trim();
          if (!data || data === "[DONE]") return;
          let obj; try { obj = JSON.parse(data); } catch { return; }
          const delta = obj.choices?.[0]?.delta ?? {};
          if (delta.reasoning_content) { rawReasoning += delta.reasoning_content; gotAny = true; }
          if (delta.content) { rawText += delta.content; gotAny = true; }
        };
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            for await (const ev of flush(line)) yield ev;
          }
        }
        if (buf.trim()) for await (const ev of flush(buf)) yield ev;
        if (!gotAny) throw new Error("relay returned no content");

        // OrcaTerm answers in its own ACP JSON envelope; surface the prose only.
        const parsed = parseAcp(rawText);
        const answer = (parsed?.taskCompletion || rawText).trim();
        const thinking = (parsed?.thinking || rawReasoning).trim();
        for (const ev of emitBlock("reasoning", thinking)) yield ev;
        for (const ev of emitBlock("text", answer)) yield ev;

        usage.inputTokens = estTokens(inChars);
        usage.outputTokens = estTokens(answer.length + thinking.length);
        usage.totalTokens = usage.inputTokens + usage.outputTokens;
        yield { type: "usage", usage };
        yield { type: "finish", reason: { kind: "stop" } };
      } catch (error) {
        yield { type: "finish", reason: { kind: "error", failure: { message: error instanceof Error ? error.message : String(error), code: "SERVER" } } };
      }
    },
  };
}

export function apply(ctx) {
  const disposers = [];

  // 1) Register as a standard OpenAI provider via DSH's own PiAiAdapter.
  //    This keeps the FULL harness system prompt (jailbreak/presets), tools and
  //    skills intact — unlike a hand-rolled adapter that flattens messages.
  try {
    if (typeof createProvider === "function" && typeof PiAiAdapter === "function") {
      const ensure = async () => { await ensureRelay(); return true; };
      const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const base = `${baseUrl(port())}/v1`;
      const buildModels = () => MODELS.map((m) => ({
        id: m.id, name: m.name, api: "openai-completions", provider: ROUTE,
        baseUrl: base, input: ["text"], cost: NO_COST,
        contextWindow: m.contextWindow, maxTokens: m.maxOutput,
        compat: { maxTokensField: "max_tokens" },
      }));
      const provider = createProvider({
        id: ROUTE, name: "OrcaTerm 反代模型",
        auth: { apiKey: { name: "local relay key", async resolve() {
          await ensure();
          return { auth: { apiKey: "local" }, source: "local" };
        } } },
        models: buildModels(), api: openAICompletionsApi(),
      });
      const retryPolicy = typeof resolveRetryPolicy === "function"
        ? resolveRetryPolicy(undefined, "dsh-model-relay retryPolicy")
        : { mode: "normal", maxRetries: 2, retryableCodes: ["EMPTY_RESPONSE","SERVER","TIMEOUT","TRANSPORT"], initialDelayMs: 700, maxDelayMs: 8000, jitterRatio: 0.2 };
      const profile = {
        provider: ROUTE, displayName: "OrcaTerm 反代模型",
        streamIdleTimeoutMs: 300000, retryPolicy,
        configuredMaxTokens: new Map(), modelErrors: new Map(), piProvider: provider,
      };
      let profiles = new Map([[ROUTE, profile]]);
      const adapter = new PiAiAdapter({
        profiles: () => profiles,
        auth: {},
        resolveApiKey: async () => { await ensure(); return "local"; },
      });
      const rel = ctx.llm.registerAdapter([ROUTE], adapter);
      disposers.push(rel);
      if (ctx.llm?.registerConfigurableProviders) {
        disposers.push(ctx.llm.registerConfigurableProviders([{
          provider: ROUTE, displayName: "OrcaTerm 反代模型",
          settingsNs: ctx.fiber?.entry?.options?.id ?? name, settingsPath: [],
        }]));
      }
      if (ctx.llm?.registerModelDiscovery) {
        disposers.push(ctx.llm.registerModelDiscovery(ctx.fiber?.entry?.options?.id ?? name, async () =>
          MODELS.map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxOutput, inputModalities: ["text"] }))));
      }
      ctx.logger?.info?.("dsh-model-relay: registered standard PiAi provider at " + base);
    } else {
      // Fallback to the hand-rolled adapter if core deps are unavailable.
      const adapter = makeAdapter();
      disposers.push(ctx.llm.registerAdapter([ROUTE], adapter));
      if (ctx.llm?.registerConfigurableProviders) disposers.push(ctx.llm.registerConfigurableProviders([{
        provider: ROUTE, displayName: "OrcaTerm 反代模型", settingsNs: ctx.fiber?.entry?.options?.id ?? name, settingsPath: [],
      }]));
    }
  } catch (e) {
    ctx.logger?.warn?.("dsh-model-relay: llm registration failed:", String(e));
  }

  // 2) Keep the management tool if defineTool resolved.
  if (typeof defineTool === "function") {
    const definition = defineTool({
      name: "model_relay",
      description: "Manage the local OpenAI-compatible OrcaTerm model relay. Actions: start, stop, status, models, chat. Use for 开反代/停掉反代/反代状态/用反代问一句/model relay.",
      parameters: {
        action: { type: "string", enum: ["start", "stop", "status", "chat", "models"], required: true,
          description: "start=launch, stop=kill, status=health+mode, models=list, chat=send a message." },
        port: { type: "integer", description: "Port. Default 8001." },
        model: { type: "string", description: "chat model. Default Deepseek-V4-Pro." },
        message: { type: "string", description: "chat message." },
      },
      output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
      isConcurrencySafe: () => false,
      async execute(args) {
        ensureState();
        const p = Number(args.port ?? port());
        if (args.action === "start") {
          if (alive(readPid())) return { status: "already-running", pid: readPid(), port: p, health: await probe(p) };
          const { py, cwd } = findPython(); const log = openSync(LOG_FILE, "a");
          const child = spawn(py, ["-m", "lightai_relay", "--config", "lightai.yaml", "--port", String(p)], { cwd, detached: true, stdio: ["ignore", log, log] });
          child.unref(); writeFileSync(PID_FILE, String(child.pid)); writeFileSync(PORT_FILE, String(p));
          let h = { ok: false }; for (let i = 0; i < 20; i++) { await sleep(300); h = await probe(p); if (h.ok) break; }
          return { status: h.ok ? "started" : "launched-not-ready", pid: child.pid, port: p, baseUrl: baseUrl(p), health: h };
        }
        if (args.action === "stop") {
          const pid = readPid();
          if (!alive(pid)) { rmSync(PID_FILE, { force: true }); return { status: "not-running" }; }
          try { process.kill(pid, "SIGTERM"); } catch {} await sleep(300);
          if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
          rmSync(PID_FILE, { force: true }); return { status: "stopped", pid };
        }
        if (args.action === "status") return { pid: readPid(), processAlive: alive(readPid()), port: p, baseUrl: baseUrl(p), health: await probe(p) };
        if (args.action === "models") {
          try { const r = await fetch(`${baseUrl(p)}/v1/models`, { signal: AbortSignal.timeout(3000) }); const j = await r.json(); return { status: r.status, models: (j.data ?? []).map((m) => m.id) }; }
          catch (e) { return { error: String(e) }; }
        }
        if (args.action === "chat") {
          try {
            const r = await fetch(`${baseUrl(p)}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: args.model ?? "Deepseek-V4-Pro", messages: [{ role: "user", content: args.message ?? "你好" }], stream: false }), signal: AbortSignal.timeout(120000) });
            const j = await r.json(); return { status: r.status, model: j.model, content: j.choices?.[0]?.message?.content ?? null, error: j.error ?? null };
          } catch (e) { return { error: String(e) }; }
        }
        return { error: "unknown action" };
      },
    });
    disposers.push(ctx.tools.register(definition));
  }

  ctx.effect(() => () => { for (const d of disposers.splice(0)) { try { typeof d === "function" ? d() : d?.dispose?.(); } catch {} } });
}
