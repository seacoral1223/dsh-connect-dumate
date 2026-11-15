"use strict";
/**
 * dsh-connect-dumate / upstream.cjs —— 百度搭子（DuMate）上游读写核心
 *
 * 两条可用通道（2026-11-15 实测）：
 *
 *  A. 云端模型网关（默认，**搭子 App 不用开**）
 *     1) 用本机登录 Cookie 换短期 token：GET https://console.bce.baidu.com/api/dumate/app/token/get
 *        返回 {token(36位), expired_at}，同一账号在有效期内重复请求拿到同一个值。
 *     2) 目录：GET https://dumate-svc.baidu.com/gateway/apis/v1/models  → 43 个模型（就是 App 写进
 *        opencode.json 的那一份，字段完全一致：limit / modalities / thinking）。
 *     3) 对话：POST …/gateway/apis/v1/chat/completions  Authorization: Bearer <token>
 *        支持 SSE；只有带 stream_options.include_usage 时最终块才含 usage（已实测）。
 *        响应头 x-dumate-gw-realmodel-displayname 给出上游对这次路由到的真实模型的叫法。
 *     4) 坏 token → 401 + error_code 336100 "Incorrect API Key"，据此重取一次 token 再试。
 *
 *  B. App 自带的本地代理（备胎，App 在跑时行为与 App 完全一致）
 *     POST http://127.0.0.1:<随机端口>/api/qianfanproxy/v1/chat/completions，无需鉴权头；
 *     端口与目录来自 App 每次启动重写的 opencode.json。
 *
 * 积分（与通道无关，恒走云端只读接口）：
 *     GET https://console.bce.baidu.com/api/dumate/points/{package/list,records/usage,records/charge,loginBonusInfo}
 *     POST …/points/loginBonus（唯一的写接口 = 每日签到领取）
 *
 * 铁律：
 *  - App 的 auth.json / .cookie-key 只读；解出的 Cookie 与 token 只在本进程内存里，不落盘、不进日志。
 *  - 上游没说的数字绝不编：个人版没有公开的逐模型积分倍率，所以只报余额与真实消耗。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const APP_DATA_DIRNAME = "qianfan-desktop-app";
/**
 * 内层数据目录（本机实测是 `qianfan_desk_xdg`）。
 *
 * 这个名字是 Windows 上观察到的，**不能当跨平台常量**：猜不中不会崩，但会静默拿不到
 * deviceId（云端接口可能因此被拒）和永远找不到通道 B 的 opencode.json。
 * 所以先试已知候选，再扫一次目录找「里面有 config/opencode/opencode.json 或 data/sts/device_id.json 的子目录」。
 */
const INNER_DIR_CANDIDATES = ["qianfan_desk_xdg", "xdg", "data"];

function innerDir(dir, probe) {
  for (const name of INNER_DIR_CANDIDATES) {
    const p = path.join(dir, name, ...probe);
    try { if (fs.statSync(p).isFile()) return path.join(dir, name); } catch { /* 试下一个 */ }
  }
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name, ...probe);
      try { if (fs.statSync(p).isFile()) return path.join(dir, e.name); } catch { /* 继续 */ }
    }
  } catch { /* 目录读不了就算了 */ }
  return path.join(dir, INNER_DIR_CANDIDATES[0]);
}
const PROVIDER_KEY = "QianfanPersonalQuota";
const CLOUD_API_BASE = "https://console.bce.baidu.com";
const GATEWAY_BASE = "https://dumate-svc.baidu.com/gateway/apis/v1";
const LOCAL_PROXY_PREFIX = "/api/qianfanproxy/v1";

/* ------------------------------------------------------------------ 路径与登录态 */

/**
 * 搭子 App 的用户数据目录。
 *
 * 不能只算一条路径就完事：Electron 的 userData 名字来自 App 自己 package.json 的 `name`，
 * 各平台、各版本都可能不同（本机实测 Windows 是 `%APPDATA%\qianfan-desktop-app`，
 * 里面还套了一层 `qianfan_desk_xdg`）。所以这里**列候选、逐个验**，
 * 判据用 `auth.json` 在不在 —— 目录存在不等于登录过，`auth.json` 才是「这台机器登录过搭子」的证据。
 *
 * 另外留一个 `DUMATE_USER_DATA` 环境变量：非标准安装、多套 App、或想在测试里指定目录时用它，
 * 不用改代码。
 */
const APP_DIR_CANDIDATE_NAMES = ["qianfan-desktop-app", "DuMate", "qianfan_desk_xdg"];

function userDataCandidates() {
  // 显式指定就严格生效：只认这一个目录。
  // 之前它会退回扫全机候选 —— 那样用户指错了目录，插件会悄悄用另一份登录态跑起来，
  // 报错还全都指向那个他根本没打算用的目录，最难查。
  if (process.env.DUMATE_USER_DATA) return [process.env.DUMATE_USER_DATA];
  const out = [];
  const push = dir => { if (dir && !out.includes(dir)) out.push(dir); };
  const roots = [];
  if (process.platform === "win32") {
    if (process.env.APPDATA) roots.push(process.env.APPDATA);
    if (process.env.LOCALAPPDATA) roots.push(process.env.LOCALAPPDATA);
  } else if (process.platform === "darwin") {
    roots.push(path.join(os.homedir(), "Library", "Application Support"));
  } else {
    roots.push(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"));
  }
  for (const root of roots) for (const name of APP_DIR_CANDIDATE_NAMES) push(path.join(root, name));
  return out;
}

function userDataDir() {
  const candidates = userDataCandidates();
  // 先要「有 auth.json」的；都没有再退回「存在的目录」—— 那样至少诊断信息能说清我们看过哪里
  const withAuth = candidates.find(dir => {
    try { return fs.statSync(path.join(dir, "auth.json")).isFile(); } catch { return false; }
  });
  if (withAuth) return withAuth;
  return candidates.find(dir => {
    try { return fs.statSync(dir).isDirectory(); } catch { return false; }
  }) ?? null;
}

/** 密文格式 base64(iv12 || authTag16 || ct)，AES-256-GCM，密钥 = userData/.cookie-key 的 32 字节。 */
function decryptCookies(cipher, keyBuffer) {
  const raw = Buffer.from(String(cipher || ""), "base64");
  if (raw.length < 29) throw new Error("cookie payload too short");
  const d = crypto.createDecipheriv("aes-256-gcm", keyBuffer, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  const arr = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
  if (!Array.isArray(arr)) throw new Error("cookie payload is not an array");
  return arr;
}

/** 与 App 同一种封装（iv|tag|ct），用于把用户粘进来的 Cookie 存成本机可读的密文。 */
function encryptCookies(arr, keyBuffer) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyBuffer, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(arr), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

/**
 * 手动导入时，最少要凑齐哪几个 Cookie —— 2026-11-15 逐个剔除 + 定向组合实测：
 * `bce-sessionid` + `bce-user-info` 两个就能换到网关 token；`BDUSS` 有更好但不是必需，
 * 其余 30 个全部冗余（去掉任何一个都还能拿到 token）。
 * 注意 `bce-sessionid` 是 **HttpOnly**：浏览器控制台 `document.cookie` 读不到，
 * 必须从 DevTools → Application → Cookies，或 Network 里某个请求的 Cookie 头复制。
 */
const REQUIRED_COOKIES = ["bce-sessionid", "bce-user-info"];

/**
 * 把人粘进来的各种格式统一成 cookie 数组。纯函数，可离线测。
 * 支持：① `k=v; k2=v2` 请求头原文 ② JSON 数组（EditThisCookie / DevTools 导出）
 * ③ Netscape cookies.txt（Tab 分隔六列）。
 */
function parseCookieInput(text) {
  const s = String(text ?? "").trim();
  if (!s) return { cookies: [], format: null, error: "什么都没粘" };
  // ② JSON 数组
  if (s.startsWith("[") || s.startsWith("{")) {
    try {
      const parsed = JSON.parse(s);
      const list = Array.isArray(parsed) ? parsed : parsed.cookies ?? parsed.cookies_ ?? [];
      const cookies = list
        .filter(c => c && typeof c.name === "string" && c.value !== undefined)
        .map(c => ({
          name: c.name,
          value: String(c.value),
          domain: c.domain ?? c.host ?? ".bce.baidu.com",
          path: c.path ?? "/",
          secure: c.secure === true,
          httpOnly: c.httpOnly === true,
          expirationDate: Number(c.expirationDate ?? c.expires ?? 0) || 0,
        }));
      if (!cookies.length) return { cookies: [], format: "json", error: "JSON 里没找到带 name/value 的条目" };
      return { cookies, format: "json", error: null };
    } catch (e) { return { cookies: [], format: "json", error: `JSON 解析失败：${e.message}` }; }
  }
  // ③ Netscape cookies.txt（有 tab 分隔的六列）
  if (s.includes("\t") && /^\S+\t(FTRUE|TRUE|FALSE|1|0)\t/m.test(s)) {
    const cookies = [];
    for (const line of s.split(/\r?\n/)) {
      if (!line.trim()) continue;
      // `#HttpOnly_` 前缀不是注释，是 cookies.txt 标 HttpOnly 的写法 ——
      // 把它当注释丢掉，丢的恰好是最关键的 bce-sessionid。
      let text = line;
      let httpOnly = false;
      if (text.startsWith("#HttpOnly_")) { httpOnly = true; text = text.slice("#HttpOnly_".length); }
      else if (text.startsWith("#")) continue;
      const f = text.split("\t");
      if (f.length < 7) continue;
      cookies.push({ name: f[5], value: f[6], domain: f[0], path: f[2] || "/", secure: /^(TRUE|1)$/i.test(f[3]), httpOnly, expirationDate: Number(f[4]) || 0 });
    }
    return cookies.length ? { cookies, format: "netscape", error: null } : { cookies: [], format: "netscape", error: "cookies.txt 里没有可用行" };
  }
  // ① Cookie 头原文：`k=v; k2=v2`，允许带引号值与换行分隔
  const cookies = [];
  for (const part of s.split(/[;\n]+/)) {
    const t = part.trim();
    if (!t || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const name = t.slice(0, i).trim();
    // 值**原样保留**，包括成对的双引号。`bce-user-info` 的真实值本身就带引号
    // （形如 "2026-11-14T16:21:08Z|fd…"），把它当包裹符剥掉会让值短两个字符，
    // 上游直接判定登录态无效 —— 实测踩过，报错还是那句含糊的「要求重新登录」。
    const value = t.slice(i + 1).trim();
    if (!name || !/^[\w!#$%&'*+.^~`-]+$/.test(name)) continue;
    cookies.push({ name, value, domain: ".bce.baidu.com", path: "/", secure: false, httpOnly: false, expirationDate: 0 });
  }
  return cookies.length
    ? { cookies, format: "header", error: null }
    : { cookies: [], format: "header", error: "没认出格式：支持 `k=v; k2=v2`、JSON 数组、或 cookies.txt" };
}

/** 手动导入的 cookie 够不够用：缺哪个、有没有 csrf（bce-user-info 同时当 csrftoken 用）。 */
function checkCookies(cookies) {
  const names = new Set((cookies ?? []).map(c => c.name));
  const missing = REQUIRED_COOKIES.filter(n => !names.has(n));
  return {
    ok: missing.length === 0,
    missing,
    hasSession: names.has("bce-sessionid") || names.has("bce-long-term-sessionid"),
    hasCsrf: names.has("bce-user-info"),
    hasPassport: names.has("BDUSS"),
    count: (cookies ?? []).length,
  };
}

function accountProfiles(authJson) {
  const list = Array.isArray(authJson.accountProfiles) ? authJson.accountProfiles : [];
  if (list.length) return list;
  if (authJson.cookies) return [{ profileId: "default", loginType: authJson.activeProviderType || "bce", displayName: "", encryptedCookies: authJson.cookies }];
  return [];
}

/** 取某个档的 Cookie **密文**（不是明文）：优先档内 encryptedCookies，回退顶层 active 槽。 */
function cookieCipherFor(authJson, profile) {
  if (profile?.encryptedCookies) return profile.encryptedCookies;
  if (!profile || profile.profileId === authJson.activeProfileId) return authJson.cookies;
  return "";
}

function activeProfile(authJson) {
  const list = accountProfiles(authJson);
  return list.find(p => p.profileId === authJson.activeProfileId) || list[0] || null;
}

/* ------------------------------------------------------------------ Cookie 头 */

function domainMatches(hostname, domain) {
  if (!domain) return true;
  const d = domain.startsWith(".") ? domain.slice(1) : domain;
  return hostname === d || hostname.endsWith("." + d);
}

function buildCookieHeader(cookies, hostname, nowSeconds = Date.now() / 1000) {
  return cookies
    .filter(c => domainMatches(hostname, c.domain)
      // expirationDate 为 0 / 缺失 = **会话级 Cookie，没有到期时间**，不是「已过期」。
      // 之前写成 `c.expirationDate > nowSeconds`，0 直接判过期，
      // 于是手动导入（没有到期字段）的 Cookie 被静默丢光，报错还指向「登录态无效」。
      && !(typeof c.expirationDate === "number" && c.expirationDate > 0 && c.expirationDate <= nowSeconds))
    .map(c => {
      let v = String(c.value).replace(/^["']+|["']+$/g, "");
      if (/[:|;=\s]/.test(v)) v = `"${v}"`;
      return `${c.name}=${v}`;
    })
    .join("; ");
}

function extractCsrfToken(cookies, hostname) {
  const c = cookies.find(x => x.name === "bce-user-info" && domainMatches(hostname, x.domain));
  return c ? String(c.value).replace(/^["']+|["']+$/g, "") : "";
}

function readDeviceMeta(dir) {
  const out = { deviceId: "", channel: "" };
  try { out.deviceId = JSON.parse(fs.readFileSync(path.join(innerDir(dir, ["data", "sts", "device_id.json"]), "data", "sts", "device_id.json"), "utf8")).device_id || ""; } catch {}
  try { out.channel = fs.readFileSync(path.join(dir, "channel_distributor"), "utf8").trim(); } catch {}
  return out;
}

function cloudHeaders(cookies, hostname, meta, version) {
  const h = {
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Origin: `https://${hostname}`,
    Referer: `https://${hostname}/`,
    "X-Dumate-Client-Type": "desktop",
  };
  if (meta.deviceId) h["X-Dumate-Device-Id"] = meta.deviceId;
  if (meta.channel) h["X-Dumate-Channel"] = meta.channel;
  if (version) h["dumate-version"] = version;
  const cookie = buildCookieHeader(cookies, hostname);
  if (cookie) h.Cookie = cookie;
  const csrf = extractCsrfToken(cookies, hostname);
  if (csrf) h.csrftoken = csrf;
  return h;
}

/* ------------------------------------------------------------------ 通道 B：本地代理目录 */

function readCatalog(dir, preferredUserId) {
  const base = innerDir(dir, ["config", "opencode", "opencode.json"]);
  const candidates = [];
  if (preferredUserId) candidates.push(path.join(base, preferredUserId, "config", "opencode", "opencode.json"));
  try {
    for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name === "data" || ent.name === "global") continue;
      const p = path.join(base, ent.name, "config", "opencode", "opencode.json");
      if (!candidates.includes(p)) candidates.push(p);
    }
  } catch {}
  for (const file of candidates) {
    let json;
    try { json = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    const provider = json?.provider?.[PROVIDER_KEY];
    if (!provider?.options?.baseURL) continue;
    return {
      file,
      baseURL: provider.options.baseURL,
      models: normalizeModelEntries(Object.entries(provider.models || {}).map(([key, m]) => ({ key, ...m }))),
      defaultModel: json.model || null,
    };
  }
  return null;
}

/** 两种目录（opencode.json 与网关 /models）字段一致，统一成同一个形状。 */
function normalizeModelEntries(list) {
  return list.map(m => ({
    key: m.key,
    id: m.id || m.key,
    name: m.name || m.key,
    contextInput: m.limit?.input ?? null,
    context: m.limit?.context ?? null,
    output: m.limit?.output ?? null,
    imageInput: Array.isArray(m.modalities?.input) && m.modalities.input.includes("image"),
    videoInput: Array.isArray(m.modalities?.input) && m.modalities.input.includes("video"),
    thinkingMode: m.thinking?.mode ?? null,
  }));
}

/** 内部/工具模型不进选择器：那是 App 自己的流水线（按 key 判，glm-5 的上游 id 是 model-text 这种别名）。 */
const INTERNAL_MODEL_RE = /^(model-[a-z0-9._-]+$|llm-mock$|qwen3-embedding|qwen3-reranker|dumate-image|qianfan-ocr)/i;
function isUserFacingModel(m) { return !INTERNAL_MODEL_RE.test(m.key); }

/**
 * 自动路由别名：`dm-auto-model/mm.L0`（多模态）与 `dm-auto-model/text.L0`（纯文本）的 L0/L1/L2 三档。
 * 它们不是某个厂商模型，而是搭子自己在请求时挑一个落 —— 一次一个样，
 * 所以这一行没法被诚实地「描述」（WorkBuddy 插件对同类 auto 路由就是直接隐藏）。
 * 这里不删，只是默认不启用：想要的人在设置页勾上即可。
 */
const AUTO_ROUTER_RE = /^dm-auto-model\/(mm|text)\.L\d+$/i;
function isAutoRouterModel(key) { return AUTO_ROUTER_RE.test(String(key)); }

function portOf(baseURL) { try { return Number(new URL(baseURL).port) || null; } catch { return null; } }

/** 本地代理存活探测：真实模型 + 空 messages → 400 参数拒绝，不建任务、不扣积分。 */
async function probeLocalProxy(baseURL, probeModel = "glm-5", timeoutMs = 4000) {
  const url = `${baseURL.replace(/\/$/, "")}/chat/completions`;
  try {
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: probeModel, messages: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text().catch(() => "");
    const modelRejected = r.status === 404 && /invalid_model/i.test(text);
    return { ok: r.status === 400 || r.status === 200 || modelRejected, status: r.status, text: text.slice(0, 200) };
  } catch (e) {
    return { ok: false, status: 0, error: `${e.name}: ${String(e.message).slice(0, 120)}` };
  }
}

/* ------------------------------------------------------------------ 通道 A：云端网关 token */

class GatewayToken {
  constructor({ cookies, meta, version, base = CLOUD_API_BASE, fetchImpl = null }) {
    this.hostname = new URL(base).hostname;
    this.base = base.replace(/\/$/, "");
    this.cookies = cookies;
    this.meta = meta;
    this.version = version;
    this.fetch = fetchImpl || fetch;
    this.token = null;
    this.expiresAt = 0;        // 毫秒
    this.lastError = null;
    this.inflight = null;
  }

  /** 提前 3 分钟换新的，免得正好卡在过期边界上。 */
  fresh() { return this.token && Date.now() < this.expiresAt - 180_000; }

  describe() {
    return {
      present: !!this.token,
      expiresAt: this.expiresAt || null,
      minutesLeft: this.expiresAt ? Math.max(0, Math.round((this.expiresAt - Date.now()) / 60000)) : null,
      error: this.lastError,
    };
  }

  /** @returns {Promise<string>} token；拿不到就抛，让调用方给出可读原因。 */
  async get({ force = false } = {}) {
    if (!force && this.fresh()) return this.token;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const r = await this.fetch(`${this.base}/api/dumate/app/token/get`, {
          method: "GET", headers: cloudHeaders(this.cookies, this.hostname, this.meta, this.version),
          redirect: "manual", signal: AbortSignal.timeout(20000),
        });
        if (r.status === 301 || r.status === 302) throw loginExpired();
        const j = await r.json().catch(() => null);
        const token = j?.result?.token;
        if (!token) {
          const msg = describeCloudError(j, r.status);
          this.lastError = msg.slice(0, 160);
          const err = new Error(`百度搭子没发模型网关 token：${this.lastError}`);
          err.code = "DUMATE_NO_GATEWAY_TOKEN";
          throw err;
        }
        this.token = token;
        const exp = Date.parse(j.result.expired_at || "");
        this.expiresAt = Number.isFinite(exp) ? exp : Date.now() + 30 * 60_000;
        this.lastError = null;
        return this.token;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** 401/坏 key 时调用：作废缓存，下次 get() 重新取。 */
  invalidate() { this.token = null; this.expiresAt = 0; }
}

/**
 * 把云端那句中英混排的错误翻成人话。
 *
 * 关键：`message` 经常是个**对象**（登录失效时是 `{redirect: "https://login.bce..."}`），
 * 直接 String() 会得到 `[object Object]` —— 用户看到那四个字什么都做不了。
 * 认出 redirect 形状就等于「登录态不行」，直接说该做什么。
 */
function describeCloudError(j, status) {
  const m = j?.message;
  if (m && typeof m === "object") {
    if (m.redirect) return "登录态不被接受（上游要求重新登录）：桌面版请重新登录一次；手动导入的话，重新复制 bce-sessionid 与 bce-user-info";
    const g = m.global || m.code || m.message;
    if (typeof g === "string" && g) return g;
    return `上游返回了结构化错误（HTTP ${status}），键名：${Object.keys(m).join(",")}`;
  }
  if (typeof m === "string" && m) return m;
  if (typeof j?.error === "string" && j.error) return j.error;
  if (j?.error_code !== undefined) return `error_code ${j.error_code}${j.error_message ? `：${j.error_message}` : ""}`;
  return `HTTP ${status}`;
}

function loginExpired() {
  const err = new Error("百度搭子登录态已过期：请在搭子 App 里重新登录");
  err.code = "DUMATE_LOGIN_EXPIRED";
  return err;
}

/* ------------------------------------------------------------------ 云端只读接口 */

class CloudClient {
  constructor(opts) {
    this.cookies = opts.cookies;
    this.meta = opts.meta;
    this.version = opts.version || "";
    this.base = (opts.base || CLOUD_API_BASE).replace(/\/$/, "");
    this.hostname = new URL(this.base).hostname;
    this.timeoutMs = opts.timeoutMs || 15000;
    this.lastError = null;
  }

  async request(p, method = "GET", body) {
    const url = `${this.base}/${String(p).replace(/^\/+/, "")}`;
    try {
      const r = await fetch(url, {
        method, headers: cloudHeaders(this.cookies, this.hostname, this.meta, this.version),
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (r.status === 301 || r.status === 302) throw loginExpired();
      const text = await r.text();
      let json; try { json = JSON.parse(text); } catch { json = null; }
      if (!json) {
        this.lastError = { kind: "bad-json", status: r.status, text: text.slice(0, 200) };
        const err = new Error(`百度搭子接口返回非 JSON（HTTP ${r.status}）`);
        err.code = "DUMATE_BAD_RESPONSE"; throw err;
      }
      if (json.success === false || (typeof json.code === "number" && json.code !== 0)) {
        const msg = String((json.message && (json.message.global || json.message)) || json.error || "上游返回错误");
        this.lastError = { kind: "api", status: r.status, code: json.code, message: msg.slice(0, 200) };
        const err = new Error(`百度搭子接口错误 ${json.code ?? ""}: ${msg.slice(0, 160)}`);
        err.code = "DUMATE_UPSTREAM_ERROR"; err.upstream = this.lastError; throw err;
      }
      this.lastError = null;
      return json.result !== undefined ? json.result : json.data !== undefined ? json.data : json;
    } catch (e) {
      if (e.code && String(e.code).startsWith("DUMATE_")) throw e;
      this.lastError = { kind: "network", message: String(e.message ?? e).slice(0, 200) };
      const err = new Error(`百度搭子接口请求失败：${String(e.message ?? e).slice(0, 160)}`);
      err.code = "DUMATE_NETWORK"; throw err;
    }
  }

  userInfo() { return this.request("api/dumate/user/info", "GET"); }
  packages() { return this.request("api/dumate/points/package/list?page=1&limit=100", "GET"); }
  usageRecords(startAt, endAt, page = 1, limit = 20) {
    return this.request(`api/dumate/points/records/usage?startAt=${startAt}&endAt=${endAt}&page=${page}&limit=${limit}`, "GET");
  }
  chargeRecords(startAt, endAt, page = 1, limit = 20) {
    return this.request(`api/dumate/points/records/charge?startAt=${startAt}&endAt=${endAt}&page=${page}&limit=${limit}`, "GET");
  }
  bonusInfo() { return this.request("api/dumate/points/loginBonusInfo", "GET"); }
  claimBonus() { return this.request("api/dumate/points/loginBonus", "POST", {}); }
}

/** 积分包 → 读数。上游把数字写成字符串小数，这里统一转数。 */
/**
 * 宽容取数：上游偶尔会把数字以字符串返回，甚至带千分位。
 * 原先是 Number(x) || 0 —— `"1,000"` 会变成 NaN 再变 0，于是余额直接归零且不报错。
 */
function toNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const cleaned = v.replace(/[,，\s]/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * 「可用」的判定。上游实测用 `active`，但这是逆向来的私有接口，
 * 大小写、数字枚举、换词都可能变。一律归一化后再认。
 * 返回 "active" | "expired" | "other" | "unknown"。
 */
const ACTIVE_WORDS = new Set(["active", "usable", "valid", "available", "inuse", "in_use", "normal", "1", "true"]);
const DONE_WORDS = new Set(["expired", "usedup", "used_up", "exhausted", "invalid", "disabled", "finished", "0", "2", "false"]);
function statusClass(s) {
  if (s === null || s === undefined || s === "") return "unknown";
  const w = String(s).trim().toLowerCase().replace(/[\s-]/g, "");
  if (ACTIVE_WORDS.has(w)) return "active";
  if (DONE_WORDS.has(w)) return "expired";
  return "other";
}

function summarizePackages(pkgs) {
  const now = Date.now();
  const list = (Array.isArray(pkgs?.packages) ? pkgs.packages : []).map(p => {
    const total = toNum(p.totalPoints), used = toNum(p.usedPoints);
    const expire = toNum(p.expireDate);
    const cls = statusClass(p.status);
    // 过期判定独立于 status：上游可能把过期包仍标成 active（回收有延迟），
    // 那样按 status 累加会把**已经作废的积分算进余额**，用户看到的余额虚高。
    const expiredByDate = expire > 0 && expire * 1000 <= now;
    return {
      packageId: p.packageId, packageType: p.packageType, source: p.source,
      total, used, remain: Math.max(0, total - used),
      startDate: p.startDate, expireDate: expire, status: p.status,
      usable: cls === "active" && !expiredByDate,
      expiredByDate,
    };
  });
  const active = list.filter(p => p.usable);
  // 一条静默失效的兜底：有包、但一个都没被认成可用，也没有一个明确是过期/用完 ——
  // 那多半是上游改了状态字段。必须把这个事实带出去，别让界面只显示 0。
  const unrecognized = list.filter(p => statusClass(p.status) === "other" || statusClass(p.status) === "unknown");
  return {
    available: active.reduce((a, p) => a + p.remain, 0),
    grantedTotal: active.reduce((a, p) => a + p.total, 0),
    usedTotal: active.reduce((a, p) => a + p.used, 0),
    packages: active,
    totalCount: list.length,
    // 过期但上游仍标可用的那部分，单独报出来，界面/诊断能说清「为什么比上游列表少」
    expiredHeld: list.filter(p => p.expiredByDate && statusClass(p.status) === "active")
      .reduce((a, p) => a + p.remain, 0),
    unrecognizedStatus: unrecognized.length ? [...new Set(unrecognized.map(p => String(p.status)))].slice(0, 4) : [],
    expiringSoon: active
      .filter(p => p.expireDate > 0 && p.expireDate * 1000 - now < 3 * 86400_000)
      .map(p => ({ ...p, daysLeft: Math.max(0, Math.ceil((p.expireDate * 1000 - now) / 86400_000)) })),
    raw: { totalCount: toNum(pkgs?.totalCount) },
  };
}

/* ------------------------------------------------------------------ 网关模型目录 */

async function fetchGatewayModels(token, base = GATEWAY_BASE, timeoutMs = 25000) {
  const r = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (r.status === 401) { const e = new Error("网关 token 已失效"); e.code = "DUMATE_TOKEN_STALE"; throw e; }
  if (!r.ok) { const e = new Error(`模型目录 HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`); e.code = "DUMATE_CATALOG_FAILED"; throw e; }
  const j = await r.json();
  const data = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
  return normalizeModelEntries(data.map(m => ({ key: m.id, ...m })));
}

/**
 * 读取本机所有账号档（只回元信息，绝不回 Cookie 明文/密文）。
 * 每个档都有自己的 Cookie 密文，所以可以逐个查积分 —— 这就是设置页那张账号表的数据源。
 */
function listProfiles() {
  const dir = userDataDir();
  if (!dir) return { dir: null, profiles: [], reason: "没找到 DuMate 的数据目录" };
  let authJson = null;
  try { authJson = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8")); }
  catch (e) {
    return {
      dir,
      profiles: [],
      reason: e.code === "ENOENT"
        ? `这台机器还没登录过百度搭子：${dir} 里没有 auth.json。请安装桌面版（https://www.dumate.cn/download）并登录一次，然后回到 DSH 在「设置 → 百度搭子」点刷新`
        : `${dir} 里的 auth.json 读不了（${e.message}）：文件可能损坏或正被 App 重写。请先在搭子里退出再重新登录一次；若反复如此，把这段原样贴进问题反馈`,
    };
  }
  let keyBuf = null;
  try { keyBuf = fs.readFileSync(path.join(dir, ".cookie-key")); if (keyBuf.length !== 32) keyBuf = null; } catch {}
  const active = activeProfile(authJson);
  const profiles = accountProfiles(authJson).map(p => ({
    profileId: p.profileId,
    loginType: p.loginType || "",
    displayName: p.displayName || "(未命名)",
    bceUserId: p.bceUserId || p.bceAccountId || "",
    lastLogin: p.lastLogin || 0,
    hasCookies: !!cookieCipherFor(authJson, p),
    usable: !!(keyBuf && cookieCipherFor(authJson, p)),
    active: !!(active && p.profileId === active.profileId),
  }));
  if (!profiles.length) {
    // 装了 App、auth.json 也在，但里面一个账号档都没有 —— 这正是「打开了搭子但没登录」的人。
    // 以前这种情况一句提示都不给，界面上只剩一个空模型列表，谁也看不出要做什么。
    return { dir, profiles: [], reason: "百度搭子的登录数据里没有任何账号档：多半是 App 打开过但没登录，或已经退出登录。请在桌面版里登录一次再试", authJson, keyBuf };
  }
  return { dir, profiles, reason: keyBuf ? null : "拿不到 .cookie-key（32 字节），解不开任何账号的 Cookie", authJson, keyBuf };
}

/**
 * 为指定账号档建一套云端客户端（积分 + 网关 token）。
 * @param {string|null} profileId 空 = 用 App 当前生效的那一档
 */
function clientForProfile(profileId, preloaded) {
  const bundle = preloaded || listProfiles();
  if (!bundle.authJson || !bundle.keyBuf) return null;
  const wanted = profileId ? bundle.profiles.find(p => p.profileId === profileId) : bundle.profiles.find(p => p.active) || bundle.profiles[0];
  if (!wanted || !wanted.usable) return null;
  let cookies;
  try { cookies = decryptCookies(cookieCipherFor(bundle.authJson, wanted), bundle.keyBuf); }
  catch { return null; }
  const meta = readDeviceMeta(bundle.dir);
  return {
    profile: wanted,
    cookies,
    cloud: new CloudClient({ cookies, meta }),
    gateway: new GatewayToken({ cookies, meta }),
  };
}

/**
 * 直接用一组 Cookie 建云端客户端（手动导入那条路走这里，完全不碰 App 的文件）。
 * @param {Array} cookies parseCookieInput 或解密出来的数组
 * @param {string|null} dir App 数据目录，有就读 deviceId；没有就留空
 */
function clientFromCookies(cookies, dir) {
  if (!cookies?.length) return null;
  const meta = dir ? readDeviceMeta(dir) : {};
  return {
    profile: null,
    cookies,
    cloud: new CloudClient({ cookies, meta }),
    gateway: new GatewayToken({ cookies, meta }),
  };
}

/* ------------------------------------------------------------------ 一站式自检 */

/**
 * 静态兜底目录 —— 全新机器（还没写过状态文件）或两条通道都没回来时用。
 *
 * 为什么必须有：DSH 的 buildModelCatalog 会把 models.length===0 的供应商整组丢掉
 * （参考插件 workbuddy 的 docs/DESIGN.md 里也写了这条），所以挂载首帧如果交出空数组，
 * 这一组就直接消失，而不是「先灰着等刷新」。数值全部抄自 2026-11-15 实测的网关 /models，
 * 上游以后改名/加模型不影响：真目录一旦拿到就覆盖它，并写进 lastCatalog。
 */
const FALLBACK_MODELS = [
  { key: "glm-5", id: "glm-5", contextInput: 1000000, output: 128000, imageInput: false },
  { key: "glm-53", id: "glm-53", contextInput: 1000000, output: 128000, imageInput: false },
  { key: "glm-53-flash", id: "glm-53-flash", contextInput: 1000000, output: 128000, imageInput: true },
  { key: "deepseek-v4-pro", id: "deepseek-v4-pro", contextInput: 1000000, output: 384000, imageInput: false },
  { key: "deepseek-v41-flash", id: "deepseek-v41-flash", contextInput: 1000000, output: 384000, imageInput: true },
  { key: "deepseek-v4-flash-0731", id: "deepseek-v4-flash-0731", contextInput: 200000, output: 32000, imageInput: false },
  { key: "kimi-k3", id: "kimi-k3", contextInput: 1048576, output: 1048576, imageInput: true },
  { key: "kimi-k31", id: "kimi-k31", contextInput: 1048576, output: 1048576, imageInput: true },
  { key: "qwen3.8-max", id: "qwen3.8-max", contextInput: 983000, output: 128000, imageInput: true },
  { key: "qwen38-flash", id: "qwen38-flash", contextInput: 983000, output: 128000, imageInput: true },
  { key: "qwen3.5-27b", id: "qwen3.5-27b", contextInput: 200000, output: 32000, imageInput: false },
  { key: "qwen3.5-35b-a3b", id: "qwen3.5-35b-a3b", contextInput: 200000, output: 32000, imageInput: false },
  { key: "qwen3.5-397b-a17b", id: "qwen3.5-397b-a17b", contextInput: 200000, output: 32000, imageInput: false },
  { key: "doubao-seed-2-0-pro", id: "doubao-seed-2-0-pro", contextInput: 200000, output: 32000, imageInput: false },
  { key: "ernie-4.5-turbo-vl-32k", id: "ernie-4.5-turbo-vl-32k", contextInput: 200000, output: 32000, imageInput: false },
  { key: "qwen2.5-vl-32b-instruct", id: "qwen2.5-vl-32b-instruct", contextInput: 200000, output: 32000, imageInput: false },
  { key: "dm-auto-model/text.L0", id: "dm-auto-model/text.L0", contextInput: 1000000, output: 384000, imageInput: true },
  { key: "dm-auto-model/text.L1", id: "dm-auto-model/text.L1", contextInput: 1048576, output: 1048576, imageInput: true },
  { key: "dm-auto-model/text.L2", id: "dm-auto-model/text.L2", contextInput: 983000, output: 128000, imageInput: true },
  { key: "dm-auto-model/mm.L0", id: "dm-auto-model/mm.L0", contextInput: 1000000, output: 384000, imageInput: true },
  { key: "dm-auto-model/mm.L1", id: "dm-auto-model/mm.L1", contextInput: 1000000, output: 384000, imageInput: true },
  { key: "dm-auto-model/mm.L2", id: "dm-auto-model/mm.L2", contextInput: 1000000, output: 384000, imageInput: true },
];

/**
 * 汇总本机登录态 + 选定通道。
 * @param {object} opts
 * @param {'auto'|'gateway'|'local'} [opts.mode] auto：优先云端网关（App 不用开），拿不到 token 再退回本地代理
 * @param {boolean} [opts.withFallback] 两条通道都没回来时，是否用静态兜底目录（默认 true）
 */
async function inspect(opts = {}) {
  const mode = opts.mode || "auto";
  const withFallback = opts.withFallback !== false;
  const reasons = [];
  const dir = userDataDir();
  const manualEarly = opts.manualCookies?.length ? opts.manualCookies : null;
  if (!dir && !manualEarly) {
    // 没装 App 也没手动 Cookie：只能交静态兜底目录。空目录会被宿主整组隐藏，
    // 所以宁可交一份「看得见、但要先登录」的目录，并把两条出路都写清楚。
    return {
      ok: false, mode, reasons: [
        "没在这台机器上找到百度搭子的登录数据。这个插件不注册账号、不代你登录。两条出路：",
        "① 装桌面版并登录一次（下载页 https://www.dumate.cn/download）；",
        "② 不想装桌面版就用「手动导入 Cookie」：浏览器登录 https://console.bce.baidu.com 后，从 DevTools → Application → Cookies 复制 bce-sessionid 与 bce-user-info 两个值，粘进 设置 → 百度搭子 → 账号。",
        `找过这些地方：${userDataCandidates().join("、")}`,
      ],
      channel: null, models: FALLBACK_MODELS.map(m => ({ ...m })), fallbackOnly: true, dir: null,
      cookieCount: 0, profileId: null, authSource: "none", profiles: [], gatewayTokenInfo: null, cloud: null, gateway: null,
      localCatalog: null, localProbe: null,
    };
  }

  const bundle = listProfiles();
  // 凭据来源：
  //   app    = 只认桌面版登录态
  //   manual = 只认用户粘进来的 Cookie（完全不碰 App 的文件）
  //   auto   = 有桌面版就用桌面版，拿不到再退回手动（默认）
  const source = ["app", "manual", "auto"].includes(opts.authSource) ? opts.authSource : "auto";
  const manual = opts.manualCookies?.length ? opts.manualCookies : null;
  let authSourceUsed = "app";
  let client = null;
  let chosen = null;

  if (source !== "manual") {
    const wantedId = opts.profileId || null;
    chosen = wantedId ? bundle.profiles.find(p => p.profileId === wantedId) : (bundle.profiles.find(p => p.active) || bundle.profiles[0] || null);
    client = clientForProfile(chosen?.profileId ?? null, bundle);
  }
  if (!client && manual) {
    client = clientFromCookies(manual, bundle.dir);
    authSourceUsed = "manual";
    if (source === "auto") reasons.push("桌面版登录态不可用，改用手动导入的 Cookie");
  }
  if (!client) {
    if (source === "manual") reasons.push("登录方式选的是「手动导入 Cookie」，但还没导入（或已被清除/过期）");
    else if (bundle.profiles.length) reasons.push(chosen ? `账号「${chosen.displayName}」的 Cookie 解不开（密钥不匹配或档内没有 Cookie）` : "本机没有可用的账号档");
    else if (bundle.reason) reasons.push(bundle.reason);
  } else if (authSourceUsed === "app" && bundle.reason) {
    // 用得上 App 却还有告警（比如有档没密钥）：话要说出来，别吞
    reasons.push(bundle.reason);
  }
  const cookies = client?.cookies ?? [];
  const profileIdUsed = client?.profile?.profileId ?? null;

  const cloud = client?.cloud ?? null;
  const gateway = client?.gateway ?? null;
  const localCatalog = readCatalog(dir, chosen?.bceUserId || null);
  let channel = null, models = [], gatewayToken = null, localProbe = null;

  if (mode !== "local" && gateway) {
    try {
      gatewayToken = await gateway.get();
      models = await fetchGatewayModels(gatewayToken);
      channel = { kind: "gateway", baseURL: opts.gatewayBase || GATEWAY_BASE, token: gatewayToken, authHeader: { Authorization: `Bearer ${gatewayToken}` } };
    } catch (e) {
      reasons.push(`云端网关不可用：${String(e.message ?? e).slice(0, 160)}`);
      gateway.invalidate();
    }
  }

  if (!channel && mode !== "gateway") {
    if (!localCatalog) reasons.push("也没找到本地代理目录（opencode.json）：搭子 App 可能从没启动过");
    else {
      const probeModel = (localCatalog.models.find(isUserFacingModel) || localCatalog.models[0] || {}).key || "glm-5";
      localProbe = await probeLocalProxy(localCatalog.baseURL, probeModel);
      if (localProbe.ok) {
        channel = { kind: "local", baseURL: localCatalog.baseURL, port: portOf(localCatalog.baseURL), authHeader: {} };
        models = localCatalog.models;
      } else {
        reasons.push(`本地代理没响应（${localCatalog.baseURL} → HTTP ${localProbe.status || "ERR"}）：搭子 App 现在没在运行`);
      }
    }
  }

  if (!models.length) {
    reasons.push("两条通道都没拿到模型目录");
    // 空目录 = 这一组在选择器里被整组丢掉，所以宁可先交一份静态兜底：
    // 这时模型只能等通道回来才能真正对话，但供应商至少看得见、配置页有得点。
    if (withFallback) models = FALLBACK_MODELS.map(m => ({ ...m }));
  }

  return {
    ok: !!(channel && models.length),
    mode, reasons, channel, models, dir,
    fallbackOnly: !channel && models.length > 0,
    cookieCount: cookies.length,
    authSource: authSourceUsed,
    profileId: profileIdUsed,
    profiles: bundle.profiles.map(p => ({
      // bceUserId 不带出去：这个映射会进同源接口，而那个接口的内容可能被整段贴进问题反馈。
      // 换账号档只需要 profileId，界面认人只需要 displayName。
      profileId: p.profileId, loginType: p.loginType, displayName: p.displayName,
      lastLogin: p.lastLogin, hasCookies: p.hasCookies,
      usable: p.usable, active: p.active, selected: p.profileId === profileIdUsed,
    })),
    gatewayTokenInfo: gateway ? gateway.describe() : null,
    gateway, cloud,
    localCatalog: localCatalog ? { baseURL: localCatalog.baseURL, port: portOf(localCatalog.baseURL), file: localCatalog.file, defaultModel: localCatalog.defaultModel, models: localCatalog.models } : null,
    localProbe,
  };
}

module.exports = {
  APP_DATA_DIRNAME, INNER_DIR_CANDIDATES, innerDir, PROVIDER_KEY, CLOUD_API_BASE, GATEWAY_BASE, LOCAL_PROXY_PREFIX, INTERNAL_MODEL_RE,
  userDataDir, userDataCandidates, decryptCookies, encryptCookies, accountProfiles, activeProfile, cookieCipherFor,
  parseCookieInput, checkCookies, REQUIRED_COOKIES, clientFromCookies,
  listProfiles, clientForProfile,
  domainMatches, buildCookieHeader, extractCsrfToken, readDeviceMeta, cloudHeaders,
  readCatalog, normalizeModelEntries, isUserFacingModel, isAutoRouterModel, portOf, probeLocalProxy, FALLBACK_MODELS,
  GatewayToken, CloudClient, summarizePackages, fetchGatewayModels, inspect,
};
