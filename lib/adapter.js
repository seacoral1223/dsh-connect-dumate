/**
 * DuMate chat adapter —— 把 DSH 的 GenerateOptions 翻成百度搭子模型网关的
 * OpenAI 兼容请求，再把 SSE 翻回 DSH 的 StreamChunk 协议。
 *
 * 通道由 getState() 每次现给：
 *   { baseURL, authHeader, models[], imageInput{} }
 * 默认是云端网关（**搭子 App 不用开着**），拿不到 token 时才退回 App 的本地代理。
 *
 * 这个模块**不 import 任何 DSH 包**：本地目录安装的 bundle 是 pnpm link，
 * Node 从工作区真实路径解析裸包名，够不到 app.asar 里的 @deepseek-ai/*，
 * 一旦 import 整个插件挂载失败。dsh-llm 的 registerAdapter 只按方法调用适配器
 * （不做 instanceof 校验），所以基类在这里用鸭子类型补齐。
 *
 * 边界：
 *  - tool-addition / tool-removal 不映射：每次请求都声明完整工具表。
 *  - 工具结果里的图片补一条 user 消息：role:'tool' 的 content 只能是字符串。
 *  - 不编造 reasoning 档位：目录里 thinking.mode 只有 never，上游没说过能选档。
 *  - usage 只在 stream_options.include_usage 时给，实测有效，所以每次流式都带上。
 */

class LlmAdapter {
  providerInfo(provider) { return { id: provider, name: provider }; }
  providerRetryPolicy(_provider) { return undefined; }
  imageRequestPricing(_provider, _model) { return undefined; }
  imageRequestTarget(_provider, _model, image) { return { width: image.width, height: image.height, maxBytes: image.bytes }; }
  async listModels(_provider) { return []; }
  async resolveModel(provider, model) { return { provider, id: model, name: model }; }
  async prepareCall(provider, model, signal) {
    return { model: await this.resolveModel(provider, model, signal), stream: options => this.stream(options) };
  }
  async *stream(_options) { throw new Error("LlmAdapter.stream 未实现"); }
}

class LlmError extends Error {
  constructor(message, code) { super(message); this.name = "LlmError"; this.code = code; }
}

const ToolCallId = id => String(id);

/**
 * DSH 的适配器契约要求每个上游请求带 attribution 头。
 * 优先向运行时要真正实现；拿不到（本地 link 安装就是这样）就退回一条写明本插件的 UA，
 * 绝不冒充 DSH 版本号。
 */
// 归属头：这串每次请求都会发给上游，所以版本号必须由构造方传进来（宿主从 package.json 读），
// 不能在这儿写死一个数字然后让它烂成谎话。
let userAgentString = "dsh-connect-dumate (Baidu DuMate bridge)";
let attributionImpl = () => ({ "user-agent": userAgentString });
let probed = false;
async function attributionHeaders() {
  if (!probed) {
    probed = true;
    try {
      const mod = await import("@deepseek-ai/dsh-llm");
      if (typeof mod.attributionHeaders === "function") attributionImpl = mod.attributionHeaders;
    } catch { /* 保持兜底 */ }
  }
  return attributionImpl();
}

/** block 发射状态机：同类增量续用同一个 block，类型一切换就闭合旧的。 */
class Emitter {
  constructor() { this.index = 0; this.pending = null; }
  open(blockType) {
    this.pending = { index: this.index++, blockType, parts: [], id: "", name: "" };
    return { type: "block-start", index: this.pending.index, blockType };
  }
  switchTo(blockType) {
    if (this.pending?.blockType === blockType) return [];
    const out = this.close();
    out.push(this.open(blockType));
    return out;
  }
  close() {
    const b = this.pending;
    if (!b) return [];
    this.pending = null;
    if (b.blockType === "text") return [{ type: "block-end", index: b.index, block: { type: "text", text: b.parts.join("") } }];
    if (b.blockType === "reasoning") return [{ type: "block-end", index: b.index, block: { type: "reasoning", text: b.parts.join("") } }];
    if (b.blockType === "tool-call") {
      return [{ type: "block-end", index: b.index, block: { type: "tool-call", id: ToolCallId(b.id), name: b.name, arguments: b.parts.join("") } }];
    }
    return [];
  }
}

/** DSH 消息 → OpenAI wire messages（异步：图片字节要走 attachments 服务）。 */
export async function toWireMessages({ messages = [], system, supportsImages, resolveImage }) {
  const out = [];
  const textOf = blocks => blocks.filter(b => b.type === "text").map(b => b.text).join("");
  const pendingImages = [];

  const imagePart = async b => {
    const ref = b.attachment || {};
    if (b.offloaded) return { type: "text", text: `[image offloaded: ${ref.mediaType ?? "image"} ${ref.attachmentId ?? "?"}]` };
    const url = resolveImage ? await resolveImage(ref) : null;
    if (!url) return { type: "text", text: `[image unavailable: ${ref.mediaType ?? "image"} ${ref.bytes ?? 0}B]` };
    return { type: "image_url", image_url: { url } };
  };
  const flushImages = () => {
    if (!pendingImages.length) return;
    out.push({ role: "user", content: [{ type: "text", text: "Images from the previous tool result:" }, ...pendingImages.splice(0)] });
  };

  if (typeof system === "string" && system.trim()) out.push({ role: "system", content: system });

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];

    if (msg.role === "system" || msg.role === "developer") {
      const text = textOf(blocks);
      if (text.trim()) out.push({ role: "system", content: text });
      continue;
    }

    if (msg.role === "tool") {
      const text = textOf(blocks);
      out.push({
        role: "tool",
        tool_call_id: msg.toolCallId ?? msg.source?.callId ?? "",
        content: text || (blocks.some(b => b.type === "image") ? "(images follow)" : msg.isError ? "Tool call failed." : ""),
      });
      if (supportsImages) for (const b of blocks) if (b.type === "image") pendingImages.push(await imagePart(b));
      continue;
    }

    flushImages();

    if (msg.role === "assistant") {
      const text = textOf(blocks);
      const reasoning = blocks.filter(b => b.type === "reasoning").map(b => b.text).join("");
      const calls = blocks.filter(b => b.type === "tool-call");
      if (!text && !reasoning && !calls.length) continue;
      const entry = { role: "assistant", content: text };
      if (reasoning) entry.reasoning_content = reasoning;
      if (calls.length) {
        entry.tool_calls = calls.map(c => ({
          id: c.id, type: "function",
          function: { name: c.name, arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}) },
        }));
      }
      out.push(entry);
      continue;
    }

    const parts = [];
    const text = textOf(blocks);
    if (text) parts.push({ type: "text", text });
    for (const b of blocks) {
      if (b.type === "image") {
        parts.push(supportsImages ? await imagePart(b) : { type: "text", text: `[image dropped: this model has no image input, ${b.attachment?.attachmentId ?? "?"}]` });
      } else if (b.type === "file") {
        const ref = b.attachment || {};
        parts.push({ type: "text", text: `[file ${ref.name ?? ref.attachmentId ?? "file"} ${ref.bytes ?? 0}B${ref.hostPath ? " at " + ref.hostPath : ""}]` });
      }
    }
    if (!parts.length) continue;
    out.push({ role: "user", content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts });
  }
  flushImages();
  return out;
}

function handleEvent(evt, emitter, toolSlots) {
  const out = [];
  const choice = Array.isArray(evt.choices) ? evt.choices[0] : null;
  if (!choice) return out;
  const delta = choice.delta || {};
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
    out.push(...emitter.switchTo("reasoning"));
    emitter.pending.parts.push(delta.reasoning_content);
    out.push({ type: "reasoning-delta", index: emitter.pending.index, text: delta.reasoning_content });
  }
  if (typeof delta.content === "string" && delta.content) {
    out.push(...emitter.switchTo("text"));
    emitter.pending.parts.push(delta.content);
    out.push({ type: "text-delta", index: emitter.pending.index, text: delta.content });
  }
  for (const tc of delta.tool_calls ?? []) {
    const slotIndex = tc.index ?? 0;
    let slot = toolSlots.get(slotIndex);
    if (!slot) {
      out.push(...emitter.switchTo("tool-call"));
      slot = { index: emitter.pending.index, id: tc.id ?? `call_${slotIndex}`, name: tc.function?.name ?? "" };
      toolSlots.set(slotIndex, slot);
    }
    if (tc.id) slot.id = tc.id;
    if (tc.function?.name && !slot.name.includes(tc.function.name)) slot.name += tc.function.name;
    emitter.pending.id = slot.id;
    emitter.pending.name = slot.name;
    const argsDelta = tc.function?.arguments ?? "";
    if (argsDelta) {
      emitter.pending.parts.push(argsDelta);
      out.push({ type: "tool-call-delta", index: slot.index, id: slot.id, name: slot.name || undefined, argumentsDelta: argsDelta });
    }
  }
  return out;
}

/** 上游 usage → DSH TokenUsage（千帆把缓存命中折进 prompt_tokens，要减出来）。 */
export function mapUsage(usage) {
  if (!usage) return null;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (usage.prompt_tokens ?? 0) - cached),
    outputTokens: usage.completion_tokens ?? 0,
    ...(usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
    ...(cached ? { cacheReadTokens: cached } : {}),
    ...(reasoning ? { reasoningTokens: reasoning } : {}),
  };
}

/**
 * 最保守的一层兜底：连 inspect() 都抛了的时候用。
 * 数字来自 2026-11-15 实测的网关目录，只保留六个常见款，够让这一组在选择器里可见；
 * 真正的目录一到手就会覆盖它。权威副本在 src/upstream.cjs 的 FALLBACK_MODELS。
 */
const FALLBACK_ROWS = [
  { key: "glm-5", displayName: "Glm-5", contextInput: 1000000, output: 128000, imageInput: false },
  { key: "glm-53", displayName: "Glm-53", contextInput: 1000000, output: 128000, imageInput: false },
  { key: "deepseek-v4-pro", displayName: "Deepseek-V4-Pro", contextInput: 1000000, output: 384000, imageInput: false },
  { key: "kimi-k31", displayName: "Kimi-K31", contextInput: 1048576, output: 1048576, imageInput: true },
  { key: "qwen3.8-max", displayName: "Qwen3.8-Max", contextInput: 983000, output: 128000, imageInput: true },
];

/**
 * HTTP/传输失败 → DSH 的规范失败码。
 *
 * 必须用 dsh-llm `error.ts` 里那张表中的名字：`dsh-llm-retry` 是按 code 判断能不能重试的，
 * 默认重试 `RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / EMPTY_RESPONSE / MALFORMED_RESPONSE / STREAM_CLOSED / QUOTA`。
 * 之前这里写的是 `RATE_LIMITED`、`UPSTREAM_ERROR` —— 不在表里，于是 429 直接判死一轮对话。
 */
function failureFromResponse(res, text) {
  const code = res.status === 429 ? "RATE_LIMIT"
    : res.status === 402 ? "QUOTA"
    : res.status === 401 || res.status === 403 ? "AUTH"
    : res.status === 408 ? "TIMEOUT"
    : res.status >= 500 ? "SERVER"
    : res.status === 400 ? "INVALID_REQUEST"
    : "UNKNOWN";
  const retryAfter = Number(res.headers.get("retry-after"));
  const requestId = res.headers.get("x-request-id") || res.headers.get("x-dumate-request-id") || null;
  const gdId = /"gd_id"\s*:\s*"(gd-[\w-]+)"/.exec(text)?.[1] ?? null;
  const message = readableFailure(res.status, code, text);
  return {
    message,
    code,
    status: res.status,
    ...(Number.isFinite(retryAfter) && retryAfter >= 0 && retryAfter < 600 ? { providerRetryAfterMs: Math.round(retryAfter * 1000) } : {}),
    ...((requestId ?? gdId) ? { requestId: requestId ?? gdId } : {}),
  };
}

/** 把上游那句中英混排的错误翻成人话，机器码留在 code 里。 */
function readableFailure(status, code, text) {
  const t = String(text || "").replace(/\s+/g, " ").slice(0, 300);
  // 两处都不写"会自动重试"这种绝对承诺：重试取决于宿主装了 dsh-llm-retry，
  // 没装就不会重试，那句话反而让人干等。
  // 另外**别在文案里混用别的分类的关键词** —— 宿主除了 code 还会按错误文本
  // 再分一次类（WorkBuddy 的已知限制里记着 model_busy 被译成 quota_exceeded 的事故）。
  // 所以限流这句不出现"配额/额度"，积分那句不出现"限流"。
  if (code === "RATE_LIMIT") return `百度搭子用户级限流（HTTP ${status}）：短时间内请求太密，稍等几十秒再试；若宿主启用了重试插件会自动退避。${t}`;
  if (code === "QUOTA") return `百度搭子积分不足（HTTP ${status}）：去设置页看余额与积分包，或换条便宜的路由。${t}`;
  if (code === "AUTH") return `百度搭子拒绝了这台机器的登录态（HTTP ${status}）：请在搭子 App 里重新登录；若用的是手动导入的 Cookie，请重新复制 bce-sessionid 与 bce-user-info 再导入一次。${t}`;
  if (code === "SERVER") return `百度搭子网关 ${status}：上游临时故障；若宿主启用了重试插件会自动退避。${t}`;
  return `百度搭子 HTTP ${status}：${t}`;
}

/** 传输层异常（连不上、超时、流被掐）。 */
function failureFromTransport(error, signal) {
  const aborted = signal?.aborted === true || error?.name === "AbortError";
  if (aborted) return { message: "百度搭子请求被取消", code: "ABORTED" };
  const timeout = /timeout|ETIMEDOUT|AbortError/i.test(String(error?.name ?? "") + String(error?.message ?? ""));
  return {
    message: `百度搭子连接失败：${String(error?.message ?? error).slice(0, 200)}`,
    code: timeout ? "TIMEOUT" : "TRANSPORT",
  };
}

export class DuMateAdapter extends LlmAdapter {
  /**
   * @param opts.getState () => {baseURL, authHeader, models, imageInput}
   * @param opts.resolveImage (ref) => Promise<dataURL|null>
   * @param opts.onRealModel (modelKey, {realModel, displayName}) 上游真实模型名回调（用来标显示名）
   * @param opts.onTokenStale () => void 401 时通知上层作废网关 token
   */
  constructor(opts) {
    super();
    this.getState = opts.getState;
    this.getLiveState = opts.getLiveState ?? opts.getState;
    this.resolveImage = opts.resolveImage;
    this.onRealModel = opts.onRealModel;
    this.onTokenStale = opts.onTokenStale;
    this.timeoutMs = opts.timeoutMs ?? 600000;
    // 版本号由宿主从 package.json 传进来：这串每次请求都发给上游，写死在源码里迟早变成谎话
    if (opts.version) userAgentString = `dsh-connect-dumate/${opts.version} (Baidu DuMate bridge)`;
  }

  providerInfo(provider) { return { id: provider, name: "百度搭子 DuMate" }; }

  /**
   * 限流/5xx/传输抖动交给 DSH 的 llm-retry 插件按这个策略退避重试。
   *
   * 刻意保守：maxRetries=3、最长等 20 秒。搭子的 429 是「用户级窗口」，
   * 猛重试只会把窗口拖得更长，而且每次重试都在替你烧积分，
   * 所以宁可让这一轮明确失败，也不无上限地磨。
   * QUOTA（积分不足）与 AUTH 不在名单里：重试它们只是白烧一次请求。
   * STREAM_CLOSED 也不在：半个答案已经吐出去了，重跑会让用户看到两段拼接的回复。
   */
  providerRetryPolicy(_provider) {
    return {
      mode: "normal",
      maxRetries: 3,
      retryableCodes: ["RATE_LIMIT", "SERVER", "TRANSPORT", "TIMEOUT", "EMPTY_RESPONSE", "MALFORMED_RESPONSE"],
      initialDelayMs: 1500,
      maxDelayMs: 20000,
      jitterRatio: 0.2,
    };
  }

  async listModels(provider) {
    // 这里既不能抛、也不能交空数组：宿主 dsh-api-session-controller/src/catalog.ts
    // 的 buildModelCatalog 对每个 provider 单独 try/catch，并且会
    // filter(group => group.models.length > 0) —— 抛错或空列表是**整组从选择器消失**，
    // 而不是只少一行。所以任何异常都退到静态兜底。
    let rows = [];
    try {
      const state = await this.getState();
      rows = (state.models ?? []).filter(m => m.enabled);
    } catch (error) {
      this.onStateError?.(error);
      rows = [];
    }
    return (rows.length ? rows : FALLBACK_ROWS).map(m => ({
      provider,
      id: m.key,
      name: m.displayName || m.key,
      inputModalities: m.imageInput ? ["text", "image"] : ["text"],
    }));
  }

  async resolveModel(provider, model) {
    let entry = null;
    try {
      const state = await this.getState();
      entry = (state.models ?? []).find(m => m.key === model) ?? null;
    } catch (error) {
      this.onStateError?.(error);
    }
    if (!entry) {
      // 目录里没有也不抛（同上：抛了整组进 failures）。
      // 按兜底行或保守默认值报，真发请求时上游会给准确错误。
      entry = FALLBACK_ROWS.find(m => m.key === model)
        ?? { key: model, displayName: model, contextInput: 200000, output: 32000, imageInput: false };
    }
    const window = Math.max(8192, entry.contextInput ?? entry.context ?? 200000);
    const info = {
      provider,
      id: model,
      name: entry.displayName || model,
      context: { contextWindow: window },
      inputModalities: entry.imageInput ? ["text", "image"] : ["text"],
    };
    if (entry.output) info.defaultMaxTokens = Math.min(entry.output, 32768);
    return info;
  }

  /** 真正发一次请求；401 时按上游提示换 token 再试一次（一次对话最多两次网络尝试）。 */
  async open(options, state) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(state.authHeader ?? {}),
      ...(await attributionHeaders()),
    };
    const body = {
      model: options.model,
      messages: await toWireMessages({
        messages: options.messages ?? [],
        system: options.system,
        supportsImages: state.imageInput?.[options.model] ?? false,
        resolveImage: this.resolveImage,
      }),
      stream: true,
      // 上游只在显式要求时于最终块给 usage（实测），而 DSH 的 token 计量要用它。
      stream_options: { include_usage: true },
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      ...(options.stop?.length ? { stop: options.stop } : {}),
      ...(options.tools?.length ? {
        tools: options.tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
        tool_choice: "auto",
      } : {}),
    };
    let res;
    try {
      res = await fetch(`${state.baseURL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST", headers, body: JSON.stringify(body),
        signal: options.signal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // 连不上/超时不抛：抛了宿主会把整个 provider 记成失败，这里按规范码交出去让重试策略处理
      return { failure: failureFromTransport(error, options.signal) };
    }
    if (res.status === 401 && this.onTokenStale) {
      await res.text().catch(() => {});
      this.onTokenStale();
      const err = new LlmError("百度搭子网关 token 已失效，已作废并在下次请求重取", "DUMATE_TOKEN_STALE");
      err.retryable = true;
      throw err;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // 429 时上游的 body 也读出来：里面那句「用户级限流」比状态码有用
      return { failure: failureFromResponse(res, text) };
    }
    return { res, body };
  }

  async *stream(options) {
    // 对话走 liveState：端口与 token 必须现读，不能拿旧通道发请求；
    // 只有目录类操作（listModels / resolveModel）才用不等网络的 getState。
    const live = this.getLiveState ?? this.getState;
    let state0;
    try { state0 = await live(); }
    catch (error) { this.onStateError?.(error); state0 = await live(); }
    if (!state0.baseURL) {
      yield { type: "finish", reason: { kind: "error", failure: { message: "拿不到百度搭子的模型网关地址：本机登录态不可用（设置页 → 百度搭子 → 诊断）", code: "AUTH" } } };
      return;
    }

    let opened;
    try {
      opened = await this.open(options, state0);
    } catch (error) {
      if (error?.code !== "DUMATE_TOKEN_STALE") throw error;
      const retry = await live();          // liveState 会重取 token
      try { opened = await this.open(options, retry); }
      catch (e2) {
        if (e2?.code !== "DUMATE_TOKEN_STALE") throw e2;
        yield { type: "finish", reason: { kind: "error", failure: { message: "百度搭子网关两次都拒绝了这台机器的登录态：请在搭子 App 里重新登录", code: "AUTH" } } };
        return;
      }
    }

    if (opened.failure) {
      // 不抛：按协议把失败挂在 finish 的 reason 上，让 llm-retry 按 code 决定要不要退避重试
      yield { type: "finish", reason: { kind: "error", failure: opened.failure } };
      return;
    }
    const res = opened.res;

    // 上游在这条头上告诉我们这次实际路由到哪个模型；只是标注，不参与决策。
    if (this.onRealModel) {
      const real = res.headers.get("x-dumate-gw-realmodel");
      const disp = res.headers.get("x-dumate-gw-realmodel-displayname");
      if (real || disp) { try { this.onRealModel(options.model, { realModel: real, displayName: disp }); } catch { /* 标注失败不影响对话 */ } }
    }

    const emitter = new Emitter();
    const toolSlots = new Map();
    let usage = null, finishReason = null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let evt; try { evt = JSON.parse(payload); } catch { continue; }
          if (evt.usage) usage = evt.usage;
          const choice = Array.isArray(evt.choices) ? evt.choices[0] : null;
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          for (const chunk of handleEvent(evt, emitter, toolSlots)) yield chunk;
        }
      }
    } catch (error) {
      // 流断了：已经吐出去的字节不能重放，所以这里给的是不可重试的 STREAM_CLOSED
      for (const chunk of emitter.close()) yield chunk;
      yield {
        type: "finish",
        reason: {
          kind: "error",
          failure: {
            message: `百度搭子响应中断：${String(error?.message ?? error).slice(0, 200)}`,
            code: "STREAM_CLOSED",
          },
        },
      };
      return;
    } finally {
      try { await reader.cancel(); } catch {}
    }

    for (const chunk of emitter.close()) yield chunk;
    const u = mapUsage(usage);
    if (u) yield { type: "usage", usage: u };
    const reason = finishReason === "tool_calls" ? { kind: "tool-calls" }
      : finishReason === "length" ? { kind: "max-tokens" }
      : { kind: "stop" };
    yield { type: "finish", reason };
  }
}

export { LlmAdapter, LlmError, ToolCallId, readableFailure };
