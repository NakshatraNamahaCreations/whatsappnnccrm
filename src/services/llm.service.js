/**
 * Talks to the AI model that reads and summarises the chats.
 *
 * LLM_PROVIDER=openai (default): your own AI server running an open model with an OpenAI-compatible API,
 *   e.g. vLLM on a rented cloud GPU (see deploy/gpu-server). Settings: LLM_URL, LLM_API_KEY, AI_MODEL.
 * LLM_PROVIDER=llamacpp: llama.cpp's llama-server (optionally started by this backend, LLM_AUTOSTART=true).
 * LLM_PROVIDER=ollama: an Ollama install.
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

export const PROVIDER = (process.env.LLM_PROVIDER || "openai").toLowerCase();
const IS_REMOTE = PROVIDER === "openai";

// ---- llama.cpp (only for LLM_PROVIDER=llamacpp) ----
const DEFAULT_DIR = process.env.LOCAL_AI_DIR || (fs.existsSync("D:\\") ? "D:\\LocalAI" : path.resolve("data/local-ai"));
export const LLAMA_DIR = process.env.LLAMA_DIR || path.join(DEFAULT_DIR, "llama.cpp");
export const MODEL_FILE = process.env.LLM_MODEL_FILE || path.join(DEFAULT_DIR, "models", "qwen2.5-3b-instruct-q4_k_m.gguf");
const LLAMA_PORT = Number(process.env.LLM_PORT || 8080);

export const MODEL =
  process.env.AI_MODEL ||
  (IS_REMOTE ? "Qwen/Qwen2.5-32B-Instruct-AWQ" : PROVIDER === "ollama" ? "qwen2.5:3b" : path.basename(MODEL_FILE, ".gguf"));
// Tokens the model can read at once. Must not exceed the server's --max-model-len.
export const NUM_CTX = Number(process.env.AI_CONTEXT || (IS_REMOTE ? 16384 : 8192));
// How many chats are summarised at the same time (a GPU server handles several at once).
export const CONCURRENCY = Number(process.env.AI_CONCURRENCY || (IS_REMOTE ? 3 : 1));

const BASE = (
  PROVIDER === "ollama"
    ? process.env.OLLAMA_URL || "http://127.0.0.1:11434"
    : process.env.LLM_URL || (PROVIDER === "llamacpp" ? `http://127.0.0.1:${LLAMA_PORT}` : "")
).replace(/\/+$/, "").replace(/\/v1$/, "");
const API_KEY = process.env.LLM_API_KEY || "";
export const SERVER_LABEL = BASE ? BASE.replace(/^https?:\/\//, "") : "";

export const health = { reachable: false, modelReady: false, error: "Checking the AI server...", checkedAt: 0 };
const authHeaders = () => (API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {});

// ---------- llama.cpp server process (opt-in) ----------
let startedAt = 0;
const serverExe = () => {
  const exe = path.join(LLAMA_DIR, process.platform === "win32" ? "llama-server.exe" : "llama-server");
  return fs.existsSync(exe) ? exe : null;
};
function startLlamaServer() {
  if (process.env.LLM_AUTOSTART !== "true") return false;
  const exe = serverExe();
  if (!exe || !fs.existsSync(MODEL_FILE)) return false;
  if (Date.now() - startedAt < 120000) return true;
  startedAt = Date.now();
  const args = ["-m", MODEL_FILE, "--port", String(LLAMA_PORT), "--host", "127.0.0.1", "-c", String(NUM_CTX), "-np", "1"];
  if (process.platform === "win32") {
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const argList = args.map((a) => (String(a).includes(" ") ? q(`"${a}"`) : q(a))).join(",");
    spawn("powershell.exe", ["-NoProfile", "-Command", `Start-Process -FilePath ${q(exe)} -ArgumentList ${argList} -WindowStyle Hidden`], { stdio: "ignore", windowsHide: true });
  } else {
    spawn(exe, args, { detached: true, stdio: "ignore" }).unref();
  }
  return true;
}

// ---------- health ----------
export async function checkLLM() {
  try {
    if (IS_REMOTE && !BASE) throw Object.assign(new Error("not configured"), { setup: true });
    if (PROVIDER === "ollama") {
      const r = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(4000) });
      const { models = [] } = await r.json();
      const has = models.some((m) => m.name === MODEL || m.name === `${MODEL}:latest`);
      Object.assign(health, { reachable: true, modelReady: has, error: has ? "" : `Model "${MODEL}" is not pulled yet (ollama pull ${MODEL}).` });
    } else if (PROVIDER === "llamacpp") {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(4000) });
      Object.assign(health, { reachable: true, modelReady: r.ok, error: r.ok ? "" : "The model is loading..." });
    } else {
      // OpenAI-compatible server (vLLM): /v1/models checks the server, the key and the model in one call
      const r = await fetch(`${BASE}/v1/models`, { headers: authHeaders(), signal: AbortSignal.timeout(8000) });
      if (r.status === 401 || r.status === 403) {
        Object.assign(health, { reachable: true, modelReady: false, error: "The AI server rejected the key. Check LLM_API_KEY in backend/.env matches the server's --api-key." });
      } else if (!r.ok) {
        Object.assign(health, { reachable: true, modelReady: false, error: `The AI server answered with error ${r.status}. It may still be starting.` });
      } else {
        const { data = [] } = await r.json();
        const ids = data.map((m) => m.id);
        const has = ids.includes(MODEL);
        Object.assign(health, {
          reachable: true,
          modelReady: has,
          error: has ? "" : `The AI server is running "${ids.join(", ") || "no model"}", not "${MODEL}". Set AI_MODEL in backend/.env to the served model name.`,
        });
      }
    }
  } catch (e) {
    let error;
    if (e.setup) error = "No AI server set up yet. Start your GPU server (see deploy/gpu-server/README.md), then set LLM_URL and LLM_API_KEY in backend/.env.";
    else if (IS_REMOTE) error = `Cannot reach the AI server at ${SERVER_LABEL}. Is the GPU server running? (It may take 5-10 minutes to start.)`;
    else if (PROVIDER === "ollama") error = "Ollama is not running.";
    else error = startLlamaServer() ? "Starting the model server..." : `llama.cpp server is not running at ${SERVER_LABEL}.`;
    Object.assign(health, { reachable: false, modelReady: false, error });
  }
  health.checkedAt = Date.now();
  return health;
}
export const llmReady = () => health.reachable && health.modelReady;

// ---------- requests ----------
function body({ messages, schema, stream, maxTokens }) {
  if (PROVIDER === "ollama") {
    return { model: MODEL, messages, stream, ...(schema ? { format: schema } : {}), keep_alive: "30m", options: { temperature: 0.1, num_ctx: NUM_CTX } };
  }
  return {
    model: MODEL,
    messages,
    stream,
    temperature: 0.1,
    max_tokens: maxTokens,
    ...(schema ? { response_format: { type: "json_schema", json_schema: { name: "crm_record", schema } } } : {}),
  };
}
const endpoint = () => (PROVIDER === "ollama" ? `${BASE}/api/chat` : `${BASE}/v1/chat/completions`);

async function post(payload, signal) {
  const res = await fetch(endpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
    signal,
  });
  if (res.status === 401 || res.status === 403) throw new Error("The AI server rejected the key (LLM_API_KEY).");
  if (!res.ok) throw new Error(`AI server error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

/** One full answer. With `schema`, the server constrains the reply to JSON matching it. */
export async function llmComplete({ messages, schema, maxTokens = 3000, signal }) {
  const res = await post(body({ messages, schema, stream: false, maxTokens }), signal || AbortSignal.timeout(300000));
  const out = await res.json();
  const choice = out.choices?.[0];
  if (choice?.finish_reason === "length") throw new Error("The AI's answer was cut off (raise max tokens or AI_CONTEXT).");
  return PROVIDER === "ollama" ? out.message?.content || "" : choice?.message?.content || "";
}

/** Streams an answer; calls onToken(text) for each piece. */
export async function llmStream({ messages, maxTokens = 1500, signal }, onToken) {
  const res = await post(body({ messages, stream: true, maxTokens }), signal);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      let line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      if (PROVIDER === "ollama") {
        const evt = JSON.parse(line);
        if (evt.error) throw new Error(evt.error);
        if (evt.message?.content) onToken(evt.message.content);
      } else {
        if (!line.startsWith("data:")) continue; // server-sent events
        line = line.slice(5).trim();
        if (line === "[DONE]") return;
        const evt = JSON.parse(line);
        if (evt.error) throw new Error(evt.error.message || String(evt.error));
        const t = evt.choices?.[0]?.delta?.content;
        if (t) onToken(t);
      }
    }
  }
}
