import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { DuMateAdapter } from "./lib/adapter.js";

const require = createRequire(import.meta.url);
const upstream = require("./src/upstream.cjs");

export const name = "dsh-connect-dumate";
export const inject = ["llm"];

const PROVIDER_ID = "dumate";
const CHANNEL_TTL_MS = 30_000;          // 通道/目录重读间隔（拿 token 也算在内）
const DEFAULT_POLL_MS = 5 * 60_000;     // 积分读数刷新间隔
const POLL_STEPS_MS = [60_000, 5 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];
const MODES = new Set(["auto", "gateway", "local"]);
const AUTH_SOURCES = new Set(["auto", "app", "manual"]);

/** 插件自己的可写状态：勾选、图片开关、显示名覆盖、上游教给我们的真实模型名。 */
function stateFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "dumate-state.json");
}

/**
 * 手动导入的 Cookie 存哪。
 *
 * 与 App 同一套做法：密文进状态文件，密钥单独放 `~/.dsh/dumate-cookies.key`。
 * 说清楚这挡住什么、挡不住什么：挡住「备份/截图/贴日志时把凭文带出去」这类意外，
 * 挡不住能读你用户目录里两个文件的程序 —— 那和 App 自己的保护水平一样，不多承诺。
 */
function cookieKeyFile() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "dumate-cookies.key");
}
function cookieKey() {
  const keyFile = cookieKeyFile();
  try {
    const k = fs.readFileSync(keyFile);
    if (k.length === 32) return k;
  } catch { /* 没有就现造 */ }
  const k = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, k);
    try { fs.chmodSync(keyFile, 0o600); } catch { /* Windows 上 chmod 意义有限，失败就算了 */ }
  } catch { return null; }
  return k;
}

function loadToggles() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    return {
      disabledModels: Array.isArray(raw.disabledModels) ? raw.disabledModels : [],
      // 自动路由别名（dm-auto-model/*）默认不进选择器，勾了才进
      routerEnabled: Array.isArray(raw.routerEnabled) ? raw.routerEnabled : [],
      imageInput: raw.imageInput && typeof raw.imageInput === "object" ? raw.imageInput : {},
      displayNames: raw.displayNames && typeof raw.displayNames === "object" ? raw.displayNames : {},
      realNames: raw.realNames && typeof raw.realNames === "object" ? raw.realNames : {},
      // 上一次成功的模型目录：冷启动时 DSH 立刻会问 listModels()，
      // 那时通道还没跑完，没有这份缓存选择器就会看到一个零模型的供应商。
      lastCatalog: Array.isArray(raw.lastCatalog) ? raw.lastCatalog : [],
      catalogAt: Number(raw.catalogAt) || 0,
      // 运行期旋钮（设置页直接改这些，不用重启；patch 里的同名字段只是出厂默认）
      mode: MODES.has(raw.mode) ? raw.mode : null,
      pollIntervalMs: POLL_STEPS_MS.includes(Number(raw.pollIntervalMs)) ? Number(raw.pollIntervalMs) : null,
      activeProfileId: typeof raw.activeProfileId === "string" ? raw.activeProfileId : null,
      autoCheckIn: raw.autoCheckIn === true,
      lastAutoCheckInDate: typeof raw.lastAutoCheckInDate === "string" ? raw.lastAutoCheckInDate : null,
      // 手动导入的 Cookie：只存密文与元信息。明文不落盘、不进 snapshot、不进日志。
      manualCookiesCipher: typeof raw.manualCookiesCipher === "string" ? raw.manualCookiesCipher : null,
      manualCookiesAt: Number(raw.manualCookiesAt) || 0,
      manualCookieNames: Array.isArray(raw.manualCookieNames) ? raw.manualCookieNames : [],
      authSource: AUTH_SOURCES.has(raw.authSource) ? raw.authSource : null,
    };
  } catch {
    return { disabledModels: [], routerEnabled: [], imageInput: {}, displayNames: {}, realNames: {}, lastCatalog: [], catalogAt: 0 };
  }
}

function saveToggles(toggles) {
  const file = stateFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(toggles, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return { ok: true, file };
  } catch (error) {
    return { ok: false, file, error: String(error?.message ?? error) };
  }
}

/**
 * 后端 id → 上游亲口给过的名字。
 * 上游只在响应头里给名字，而且不是每行都给；但同一个后端只要在任何一行给过，
 * 这个名字对其它落到同一后端的行同样成立 —— 借来用，说的还是上游的原话，不是我起名。
 */
function backendNamesOf(realNames) {
  const map = {};
  for (const entry of Object.values(realNames ?? {})) {
    if (entry?.realModel && entry.displayName && !map[entry.realModel]) map[entry.realModel] = entry.displayName;
  }
  return map;
}

/**
 * 目录键 → 展示名。规则（项目约定 2026-11-15 定）：**主名用真实模型名，括号里放中转站返回的 id**。
 *
 * 括号不能省：实测 glm-5、ernie-4.5-turbo-vl-32k、qwen2.5-vl-32b-instruct、
 * deepseek-v4-flash-0731、deepseek-v41-flash 五个 id 都落到同一个后端
 * （deepseek-v4.1-flash-low-latency-1017），只留真实名的话选择器里就是五行同名，选哪个都分不清。
 * 真实名一律来自响应头 x-dumate-gw-realmodel-displayname（或同后端借来的）；
 * 没学到之前先显示 id 原文，绝不自己起名。
 */
function labelFor(key, toggles) {
  if (toggles.displayNames[key]) return { name: toggles.displayNames[key], source: "override" };
  const real = toggles.realNames?.[key];
  if (!real?.realModel) return { name: String(key), source: "id" };
  // 只用上游说过的名字（本行给过，或同一后端在别的行给过）。
  // 上游没给过名字就退回 id 原文 —— 把 n2p5sdmw_qwen35-35b-a3b 这种内部后端串当「模型名」显示，
  // 看着像名字，其实上游从没这么叫过，那是另一种编造。完整后端 id 留在设置页那行「后端:」。
  const main = backendNamesOf(toggles.realNames)[real.realModel] ?? real.displayName ?? null;
  if (!main || String(main) === String(key)) return { name: String(key), source: main ? "upstream" : "id" };
  return { name: `${main} (${key})`, source: "upstream" };
}

function bundleVersion() {
  // 归属头里的版本号必须来自清单本身，不能靠手改常量（改一次忘一次，最后发给上游的是谎话）
  try {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    return JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8")).version ?? "";
  } catch { return ""; }
}

/** 本机当天的日期串（签到按天判断用，走本地时区不是 UTC）。 */
function localDateKey(d = new Date()) {
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 把 Node 请求体读成字符串，超大直接拒（这个面只收小 JSON 指令）。 */
function readBody(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > limit) { reject(new Error("body-too-large")); req.destroy(); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{enabled?:boolean, mode?:'auto'|'gateway'|'local', pollIntervalMs?:number, providerId?:string}} config
 */
export function apply(ctx, config = {}) {
  const providerId = typeof config.providerId === "string" && config.providerId ? config.providerId : PROVIDER_ID;
  const enabled = config.enabled !== false;
  const toggles = loadToggles();

  /**
   * 运行期旋钮：设置页写的是状态文件，patch 里的同名字段只当出厂默认。
   * 这样「换通道 / 改刷新间隔 / 换账号档」都不用重启 DSH —— 上一版每次改都得重启，
   * 而重启会连带把别的插件的 JS 世代也换掉，代价太大。
   */
  const knobs = () => ({
    mode: toggles.mode ?? (MODES.has(config.mode) ? config.mode : "auto"),
    pollIntervalMs: toggles.pollIntervalMs ?? (POLL_STEPS_MS.includes(Number(config.pollIntervalMs)) ? Number(config.pollIntervalMs) : DEFAULT_POLL_MS),
    profileId: toggles.activeProfileId ?? null,
    autoCheckIn: toggles.autoCheckIn === true,
    authSource: toggles.authSource ?? (AUTH_SOURCES.has(config.authSource) ? config.authSource : "auto"),
  });
  const runtime = {
    channel: null, channelAt: 0, channelError: null, inflight: null,
    credit: null, creditAt: 0, creditError: null,
    lastUpstreamError: null,
    pillView: null,
    accounts: null,
    // 桌面版登录态在不在，由第一次自检回填；设置页要靠它决定「App 那条路能不能选」
    appAvailable: false,
    checks: [],
  };

  /* ---------------------------------------------------------------- 通道与目录 */

  async function refreshChannel({ force = false } = {}) {
    if (!force && runtime.channel && Date.now() - runtime.channelAt < CHANNEL_TTL_MS) return runtime.channel;
    if (runtime.inflight) return runtime.inflight;
    runtime.inflight = doRefreshChannel().finally(() => { runtime.inflight = null; });
    return runtime.inflight;
  }

  async function doRefreshChannel() {
    if (!enabled) return runtime.channel;
    const prevSig = catalogSignature(runtime.channel?.models);
    const beforeOk = runtime.channel?.ok === true;
    try {
      const k = knobs();
      const next = await upstream.inspect({
        mode: k.mode,
        profileId: k.profileId,
        authSource: k.authSource,
        // 手动 Cookie 每次现解、只在这一刻存在于内存，用完随对象一起被回收
        manualCookies: k.authSource === "app" ? null : manualCookies(),
      });
      runtime.appAvailable = !!next.dir && (next.profiles?.length ?? 0) > 0;
      runtime.channel = next;
      runtime.channelAt = Date.now();
      runtime.channelError = null;
      // 目录是能活过重启的事实：每次成功都把它存下来，下次冷启动先拿它顶上。
      if (next.channel && next.models?.length) {
        const fingerprint = catalogFingerprint(next.models);
        if (fingerprint !== toggles.catalogFingerprint) {
          toggles.catalogFingerprint = fingerprint;
          toggles.lastCatalog = next.models;
          toggles.catalogAt = Date.now();
          const saved = saveToggles(toggles);
          if (!saved.ok) ctx.logger.warn(`dsh-connect-dumate: 模型目录没存下（${saved.error}），下次冷启动会先空一次`);
        }
      }
      if (beforeOk !== next.ok) {
        ctx.logger.info(next.ok
          ? `dsh-connect-dumate: 已接通（${next.channel?.kind === "gateway" ? "云端网关，搭子 App 无需开着" : "搭子本地代理"}）`
          : `dsh-connect-dumate: 通道不可用 —— ${next.reasons.join("；")}`);
      }
      const nextSig = catalogSignature(next.models);
      // 关键：从「空」变成「非空」也要通知。DSH 的选择器对空分组是直接隐藏的
      // （dsh-client-ui-model-selection README：Empty groups are hidden；
      //  buildModelCatalog 过滤 models.length > 0），
      // 首帧如果撞上目录还没读回来，这一组就一直看不见，除非有人再拉一次。
      if (nextSig && nextSig !== prevSig) {
        try { ctx.emit("llm/models-updated", providerId); } catch { /* 事件不可用时下次刷新自然带上 */ }
      }
      return next;
    } catch (error) {
      runtime.channelError = String(error?.message ?? error);
      runtime.lastUpstreamError = runtime.channelError;
      return runtime.channel;
    }
  }

  /* ---------------------------------------------------------------- 积分读数 */

  async function refreshCredit({ force = false } = {}) {
    // 关掉就别再动上游了。「禁用」如果只关模型注册、后台照旧每 5 分钟打一次积分接口，
    // 那用户看到的「已禁用」和实际行为是两回事（发布前必须一致）。
    if (!enabled) return null;
    if (!force && runtime.credit && Date.now() - runtime.creditAt < knobs().pollIntervalMs) return runtime.credit;
    const ch = await refreshChannel({ force: !runtime.channel });
    if (!ch?.cloud) {
      runtime.creditError = ch?.reasons?.join("；") || "本机没有可用的百度搭子登录态";
      return runtime.credit;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    try {
      const [packages, bonus, usage24h, usage7d, info] = await Promise.all([
        ch.cloud.packages(),
        ch.cloud.bonusInfo().catch(() => null),
        ch.cloud.usageRecords(nowSec - 86400, nowSec, 1, 1).catch(() => null),
        ch.cloud.usageRecords(nowSec - 7 * 86400, nowSec, 1, 20).catch(() => null),
        ch.cloud.userInfo().catch(() => null),
      ]);
      const sum = upstream.summarizePackages(packages);
      runtime.credit = {
        ok: true,
        at: Date.now(),
        account: info?.displayName || ch.profiles.find(p => p.active)?.displayName || "(未命名账号)",
        accountId: info?.bceAccountId || info?.bceUserId || "",
        available: sum.available,
        grantedTotal: sum.grantedTotal,
        usedTotal: sum.usedTotal,
        packages: sum.packages,
        expiringSoon: sum.expiringSoon,
        consumed24h: Number(usage24h?.consumedPoints ?? 0),
        consumed7d: Number(usage7d?.consumedPoints ?? 0),
        recentUsage: (usage7d?.list ?? []).slice(0, 12).map(r => ({
          at: r.createdAt,
          points: Number(r.pointsChange ?? 0),
          conversation: r.conversationName || "",
          kind: r.skillAPICode ? "技能使用" : "模型调用",
        })),
        bonus: bonus ? {
          hasIssued: bonus.hasIssued === true,
          totalTimes: bonus.totalTimes ?? 0,
          totalPoints: bonus.totalPoints ?? 0,
          signInDays: bonus.signInDays ?? [],
          todaySigned: (bonus.signInDays ?? []).includes(localDateKey()),
        } : null,
      };
      runtime.creditAt = Date.now();
      runtime.creditError = null;
      runtime.lastUpstreamError = null;
    } catch (error) {
      runtime.creditError = String(error?.message ?? error);
      runtime.lastUpstreamError = JSON.stringify(error?.upstream ?? { message: runtime.creditError });
    }
    return runtime.credit;
  }

  /* ---------------------------------------------------------------- 模型视图 */

  /** 模型视图：通道给的最新目录优先，没有就用上次存下来的（冷启动时选择器要立刻有东西可列）。 */
  function modelViews() {
    const source = runtime.channel?.models?.length ? runtime.channel.models : (toggles.lastCatalog ?? []);
    return source
      .filter(m => upstream.isUserFacingModel(m))
      // 顺序按 key 做数字感知排序：上游数组顺序会抖，选择器却按目录顺序渲染。
      .slice().sort((a, b) => compareModelKeys(a.key, b.key))
      .map(m => ({
        key: m.key,
        upstreamId: m.id,
        displayName: labelFor(m.key, toggles).name,
        nameSource: labelFor(m.key, toggles).source,
        realModel: toggles.realNames[m.key]?.realModel ?? null,
        realObservedAt: toggles.realNames[m.key]?.observedAt ?? null,
        contextInput: m.contextInput ?? null,
        context: m.context ?? null,
        output: m.output ?? null,
        catalogImageInput: m.imageInput === true,
        imageInput: toggles.imageInput[m.key] ?? m.imageInput ?? false,
        isRouter: upstream.isAutoRouterModel(m.key),
        enabled: upstream.isAutoRouterModel(m.key)
          ? (toggles.routerEnabled.includes(m.key) && !toggles.disabledModels.includes(m.key))
          : !toggles.disabledModels.includes(m.key),
        fromCache: !runtime.channel?.models?.length,
      }));
  }

  /**
   * 目录优先，网络靠后：只要手上已经有目录（本次现读的或缓存的）就**立刻答**，
   * 绝不让 listModels 挂在网络上 —— 宿主对每个 provider 是 try/catch，
   * 上游慢或挂会把整组拖进 failures。只有「手里什么都没有」的首帧才等一次刷新，
   * 而且最多等 3 秒，等不到就用静态兜底。
   */
  async function getState({ awaitChannel = false } = {}) {
    if (awaitChannel) {
      // 对话路径：端口/token 必须是现读的，不能拿旧通道发请求。
      await refreshChannel().catch(() => {});
    } else {
      const haveSomething = (runtime.channel?.models?.length ?? 0) > 0 || (toggles.lastCatalog?.length ?? 0) > 0;
      if (!haveSomething) {
        if (runtime.inflight) {
          try { await Promise.race([runtime.inflight, new Promise(r => setTimeout(r, 3000))]); } catch { /* 用兜底答 */ }
        } else {
          await refreshChannel().catch(() => {});
        }
      } else if (Date.now() - runtime.channelAt >= CHANNEL_TTL_MS) {
        void refreshChannel().catch(() => {});        // 过期就后台刷，这一帧仍然用旧数据答
      }
    }
    const views = modelViews();
    return {
      baseURL: runtime.channel?.channel?.baseURL ?? "",
      authHeader: runtime.channel?.channel?.authHeader ?? {},
      channelKind: runtime.channel?.channel?.kind ?? null,
      port: runtime.channel?.channel?.port ?? null,
      running: runtime.channel?.ok === true,
      models: views,
      imageInput: Object.fromEntries(views.map(m => [m.key, m.imageInput])),
    };
  }

  /* ---------------------------------------------------------------- 注册供应商 */

  if (enabled) {
    const adapter = new DuMateAdapter({
      version: bundleVersion(),
      getState: () => getState(),
      getLiveState: () => getState({ awaitChannel: true }),
      resolveImage: async ref => {
        const attachments = ctx.get("attachments");
        if (!attachments || !ref?.attachmentId) return null;
        try {
          const stored = await attachments.readImage({
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType ?? "image/png",
            bytes: ref.bytes ?? 0,
            width: ref.width ?? 0,
            height: ref.height ?? 0,
          });
          const data = stored?.data;
          if (!data) return null;
          const b64 = data instanceof Uint8Array ? Buffer.from(data).toString("base64") : String(data);
          return `data:${stored.ref?.mediaType ?? ref.mediaType ?? "image/png"};base64,${b64}`;
        } catch (error) {
          ctx.logger.warn(`dsh-connect-dumate: 图片读不出（${String(error?.message ?? error).slice(0, 120)}），这条按文字占位发送`);
          return null;
        }
      },
      // 上游在响应头里告诉我们这次真正路由到哪个模型；只有它给过名字，我们才用它。
      // 自动路由档位（dm-auto-model/*）不记：那一行本来就是「每次让上游挑」，
      // 记下来的名字会让人误以为它固定指向某个模型。
      onRealModel: (key, info) => {
        if (upstream.isAutoRouterModel(key)) return;
        const prev = toggles.realNames[key];
        if (prev?.realModel === info.realModel && prev?.displayName === info.displayName) return;
        toggles.realNames[key] = {
          realModel: info.realModel ?? null,
          displayName: info.displayName ?? null,
          observedAt: Date.now(),
        };
        const saved = saveToggles(toggles);
        if (!saved.ok) ctx.logger.warn(`dsh-connect-dumate: 真实模型名没存下（${saved.error}），本次只在内存里`);
      },
      onTokenStale: () => { runtime.channel?.gateway?.invalidate(); runtime.channelAt = 0; },
      // 目录异常也要出声，不能静默变成「供应商不见了」。
      onStateError: error => {
        runtime.channelError = String(error?.message ?? error);
        runtime.lastUpstreamError = runtime.channelError;
        ctx.logger.warn(`dsh-connect-dumate: 目录/通道异常，本轮用缓存或兜底目录应答（${runtime.channelError.slice(0, 160)}）`);
      },
    });

    // 生成器形式：注册在 effect 体内发生，yield 出去的才是卸载时要跑的 disposer。
    // （写成 ctx.effect(() => handle()) 会在挂载那一刻就把 handle 调用掉。）
    ctx.effect(function* () {
      const registration = ctx.llm.registerAdapter([providerId], adapter);
      yield () => registration();
    });

    // settingsNs 必须等于 Loader entry id：Models 页正是按这个键找回命名空间的。
    const settingsNs = ctx.fiber?.entry?.options?.id ?? "dsh-connect-dumate";
    try {
      ctx.effect(function* () {
        const directory = ctx.llm.registerConfigurableProviders([{
          provider: providerId,
          displayName: "百度搭子 DuMate",
          settingsNs,
          settingsPath: [],
          // declared=false：这一条是本适配器自己的路由，不是「用户自己在配置里加的门面」
          // （dsh-llm 的类型注释：false means the adapter draws the distinction and
          //  this route is one of its own）。端点每次现读，所以这里不写 defaultBaseURL。
          declared: false,
        }]);
        yield () => directory();
      });
    } catch (error) {
      ctx.logger.warn(`dsh-connect-dumate: 供应商目录条目注册失败（${String(error?.message ?? error).slice(0, 120)}），模型仍可用`);
    }
    try {
      ctx.llm.registerModelDiscovery(settingsNs, async () => {
        await refreshChannel({ force: true });
        return modelViews().filter(m => m.enabled).map(m => ({
          id: m.key,
          name: m.displayName,
          // contextWindow 一定是正整数：宿主对「解析不出窗口」的模型是**按 provider 失败**处理的，
          // 一行坏数据能把整组拖没（参考插件的注释原话）。
          contextWindow: Math.max(8192, Number(m.contextInput ?? m.context ?? 200000) || 200000),
          ...(m.output ? { maxTokens: m.output } : {}),
          inputModalities: m.imageInput ? ["text", "image"] : ["text"],
        }));
      });
    } catch (error) {
      ctx.logger.warn(`dsh-connect-dumate: 模型发现注册失败（${String(error?.message ?? error).slice(0, 120)}）`);
    }

    ctx.effect(function* () {
      void (async () => {
        await refreshChannel({ force: true });
        await refreshCredit({ force: true });
        runtime.checks = buildChecks();
      })().catch(error => ctx.logger.warn(`dsh-connect-dumate: 启动自检失败 ${String(error?.message ?? error)}`));
      // 定时器按最小档跑，真正的节流在 pollTick 里按当前旋钮判断：
      // 这样在设置页把间隔从 5 分钟改成 60 分钟，不用重建定时器也不会立刻多打一次。
      const timer = setInterval(() => { void pollTick().catch(() => {}); }, Math.min(...POLL_STEPS_MS));
      yield () => clearInterval(timer);
    });
  }

  /**
   * 一轮轮询：读积分，然后按开关决定要不要自动签到。
   * 自动签到默认关；开起来也一天最多领一次，且先读状态再决定 —— 重启不会多领。
   */
  async function pollTick() {
    const credit = await refreshCredit({});
    const k = knobs();
    if (!k.autoCheckIn || !credit?.bonus) return credit;
    const today = localDateKey();
    if (credit.bonus.todaySigned || toggles.lastAutoCheckInDate === today) return credit;
    const result = await claimCheckIn();
    if (result.ok) {
      toggles.lastAutoCheckInDate = today;
      const saved = saveToggles(toggles);
      if (!saved.ok) ctx.logger.warn(`dsh-connect-dumate: 自动签到已领但日期没记下来（${saved.error}），今天可能再领一次（上游会拒）`);
      ctx.logger.info(`dsh-connect-dumate: 自动签到${result.granted ? "已领取今日积分" : "上游未发放（今天可能已签）"}`);
    } else {
      ctx.logger.warn(`dsh-connect-dumate: 自动签到失败 —— ${result.error}`);
    }
    return runtime.credit;
  }

  /* ---------------------------------------------------------------- 把手 */

  /**
   * 诊断表。**每次读取现算**，不在启动自检时算一次就冻住 ——
   * 之前「选择器内启用数」这类由勾选决定的行会停在旧值：
   * 实测点完「推荐」启用数已是 11，诊断表还显示 5，排障时这种陈旧数字比没有更坏。
   */
  function buildChecks() {
    const ch = runtime.channel;
    const login = loginInfo();
    const enabledCount = modelViews().filter(m => m.enabled).length;
    return [
      ["选定模式", `${knobs().mode}（运行期可改；出厂默认来自 patch）`],
      ["实际通道", ch?.channel?.kind === "gateway" ? "云端网关（搭子 App 可以不开）" : ch?.channel?.kind === "local" ? "搭子本地代理" : "无"],
      ["网关地址", ch?.channel?.baseURL ?? "未取到"],
      ["积分上游", "https://console.bce.baidu.com/api/dumate/…"],
      ["网关 token", ch?.gatewayTokenInfo?.present ? `有效，剩 ${ch.gatewayTokenInfo.minutesLeft} 分钟` : `无（${ch?.gatewayTokenInfo?.error ?? "未取"}）`],
      ["登录账号", runtime.credit?.account ?? ch?.profiles?.find(p => p.active)?.displayName ?? "未登录"],
      ["Cookie 条数", String(ch?.cookieCount ?? 0)],
      ["目录模型总数", String(ch?.models?.length ?? 0)],
      ["目录来源", ch?.models?.length ? "本次现读" : (toggles.lastCatalog?.length ? `上次缓存（${new Date(toggles.catalogAt || 0).toLocaleString("zh-CN")}）` : "无")],
      ["选择器内启用数", String(enabledCount)],
      ["积分刷新间隔", `${Math.round(knobs().pollIntervalMs / 1000)} 秒`],
      ["最近上游错误", runtime.lastUpstreamError ?? "无"],
      ["浏览器胶囊判定", runtime.pillView ? `${runtime.pillView.raw}（${new Date(runtime.pillView.at).toLocaleTimeString("zh-CN")}）` : "浏览器还没回报过（页面没开或没加载到本插件的客户端）"],
      ["登录方式", `${knobs().authSource}（本次实际用的：${ch?.authSource ?? "还没自检"}）`],
      ["手动 Cookie", login.manual.present
        ? `已导入 ${login.manual.count} 条（${login.manual.names.join(", ") || "无名"}），${new Date(login.manual.addedAt).toLocaleString("zh-CN")}；够用=${login.manual.sufficient ? "是" : `缺 ${login.manual.missing.join("、")}`}`
        : "没导入"],
      ["找过的 App 目录", (upstream.userDataCandidates?.() ?? []).map(tidyPath).join("、") || "这台机器没有可用的候选路径"],
      // 跨平台排障必须看得见「最终命中了哪个目录」，否则只能从 reasons 串里捞
      ["命中的 App 目录", tidyPath(ch?.dir ?? upstream.userDataDir() ?? "") || "没找到"],
    ];
  }

  /**
   * 把家目录缩成 ~。
   * 理由不是好看：诊断页那一块是**设计来让人整段贴进问题反馈**的，
   * 绝对路径里带着这台机器的用户名，贴出去就等于把身份一起发走。
   */
  function tidyPath(p) {
    const home = os.homedir();
    const s = String(p ?? "");
    return home && s.startsWith(home) ? "~" + s.slice(home.length).replace(/\\/g, "/") : s;
  }
  const tidyText = s => tidyPath(String(s ?? "").replace(new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "~"));

  async function snapshot(view) {
    // 浏览器半段每次读取都会把它的可见性判定带回来（canTell/selected/visible）。
    // 「胶囊怎么不见了」这件事，只有它自己知道答案，别让下次排查靠猜。
    if (typeof view === "string" && view) {
      runtime.pillView = { at: Date.now(), raw: view.slice(0, 120) };
    }
    const ch = runtime.channel;
    // 直接问宿主：这个路由到底有没有被登记进供应商表、listModels 现在给几条。
    // 「选择器里看不见」这件事靠猜没用，把宿主的答复原样带回来。
    let hostView = null;
    try {
      const providers = await ctx.llm.listProviders();
      hostView = {
        providerCount: Array.isArray(providers) ? providers.length : null,
        dumateListed: Array.isArray(providers) ? providers.some(p => p?.id === providerId) : null,
        dumateName: Array.isArray(providers) ? (providers.find(p => p?.id === providerId)?.name ?? null) : null,
        models: (await ctx.llm.listModels(providerId).catch(() => null))?.map(m => m.id) ?? null,
      };
    } catch (error) {
      hostView = { error: String(error?.message ?? error).slice(0, 200) };
    }
    return {
      ok: ch?.ok === true,
      hostView,
      mode: knobs().mode,
      // 浏览器半段靠它判断「当前会话选中的是不是本插件的 provider」
      providerId,
      reasons: !enabled
        ? ["插件已禁用（config.enabled=false）：不会向任何上游发请求，也不会注册模型路由"]
        : (ch?.reasons ?? ["还没自检过"]).map(tidyText),
      channelKind: ch?.channel?.kind ?? null,
      baseURL: ch?.channel?.baseURL ?? null,
      port: ch?.channel?.port ?? null,
      gatewayToken: ch?.gatewayTokenInfo ?? null,
      account: runtime.credit?.account ?? ch?.profiles?.find(p => p.active)?.displayName ?? null,
      // 账号主键（accountId / bceUserId）不外发：同源接口是「可能被整段贴出去」的面，
      // 昵称已经够让人认出是哪个号了，主键只是多给一条定位线索。
      accountIdHidden: runtime.credit?.accountId ? "已隐藏" : "",
      profiles: ch?.profiles ?? [],
      models: modelViews(),
      // 「选择器里到底有几个」用宿主的答复，不拿自己的 enabled 数自证 ——
      // 这两件事一旦不一致，就是过滤逻辑真的坏了，得让它俩当面比。
      pickerCount: Array.isArray(hostView?.models) ? hostView.models.length : null,
      catalogSource: runtime.channel?.models?.length ? "live" : (toggles.lastCatalog?.length ? "cache" : "none"),
      catalogAt: Number(toggles.catalogAt) || null,
      credit: runtime.credit,
      creditAt: runtime.creditAt,
      creditError: runtime.creditError,
      lastUpstreamError: runtime.lastUpstreamError,
      pollIntervalMs: knobs().pollIntervalMs,
      autoCheckIn: knobs().autoCheckIn,
      // 探测时间以每条记录自己的 observedAt 为准：顶层字段会被旧版进程的写入丢掉。
      realNamesObservedAt: (() => {
        const stamps = Object.values(toggles.realNames ?? {}).map(v => Number(v?.observedAt) || 0);
        return stamps.length ? Math.max(...stamps) : (Number(toggles.realNamesObservedAt) || null);
      })(),
      lastAutoCheckInDate: toggles.lastAutoCheckInDate ?? null,
      accounts: runtime.accounts,
      login: loginInfo(),
      checks: buildChecks(),
      stateFile: tidyPath(stateFile()),
    };
  }

  async function claimCheckIn() {
    const ch = await refreshChannel({ force: true });
    if (!ch?.cloud) return { ok: false, error: "本机没有可用的百度搭子登录态" };
    try {
      const granted = await ch.cloud.claimBonus();
      await refreshCredit({ force: true });
      return { ok: true, granted: granted === true, credit: runtime.credit };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error).slice(0, 200) };
    }
  }

  /** 勾选 / 图片开关 / 显示名覆盖：点一下即生效并落盘。 */
  function setModelFlags({ key, enabled, imageInput, displayName }) {
    if (typeof key !== "string" || !key) return { ok: false, error: "缺 key" };
    const router = upstream.isAutoRouterModel(key);
    if (enabled === false) {
      if (!toggles.disabledModels.includes(key)) toggles.disabledModels.push(key);
      if (router) toggles.routerEnabled = toggles.routerEnabled.filter(k => k !== key);
    } else if (enabled === true) {
      toggles.disabledModels = toggles.disabledModels.filter(k => k !== key);
      // 路由别名要显式点亮：光把它从 disabledModels 里摘掉还不够（默认就是关的）
      if (router && !toggles.routerEnabled.includes(key)) toggles.routerEnabled.push(key);
    }
    if (imageInput === true || imageInput === false) toggles.imageInput[key] = imageInput;
    if (typeof displayName === "string") {
      if (displayName.trim()) toggles.displayNames[key] = displayName.trim();
      else delete toggles.displayNames[key];
    }
    const saved = saveToggles(toggles);
    return { ok: saved.ok, error: saved.ok ? null : saved.error, file: saved.file, models: modelViews() };
  }

  /** 运行期旋钮的写入：只认白名单值，落盘失败要如实说。 */
  function setKnobs(patch = {}) {
    const before = { ...toggles };
    if (MODES.has(patch.mode)) toggles.mode = patch.mode;
    if (POLL_STEPS_MS.includes(Number(patch.pollIntervalMs))) toggles.pollIntervalMs = Number(patch.pollIntervalMs);
    if (patch.activeProfileId === null) toggles.activeProfileId = null;
    else if (typeof patch.activeProfileId === "string") toggles.activeProfileId = patch.activeProfileId;
    if (patch.autoCheckIn === true || patch.autoCheckIn === false) toggles.autoCheckIn = patch.autoCheckIn;
    const saved = saveToggles(toggles);
    if (!saved.ok) { Object.assign(toggles, before); return { ok: false, error: saved.error }; }
    // 改了账号档或通道 = 手上的数据全部作废，强制重读
    if (before.activeProfileId !== toggles.activeProfileId || before.mode !== toggles.mode) {
      runtime.channelAt = 0; runtime.creditAt = 0;
    }
    return { ok: true, knobs: knobs() };
  }

  /**
   * 一键设置启用集。
   *
   * - `recommended`：**每个互不相同的后端只留一行**。实测有五个 id 落到同一个后端
   *   （glm-5 / ernie-4.5-turbo-vl-32k / qwen2.5-vl-32b-instruct / deepseek-v4-flash-0731 /
   *   deepseek-v41-flash 全是 deepseek-v4.1-flash-low-latency-1017），
   *   全开着就是选择器里五个名字不同、行为一样的行；同组里留上下文窗口最大的那行，
   *   并列时按 key 排第一（确定性，不随目录顺序抖）。自动路由档位一律关。
   * - `all` / `none`：整组开关，省得一行行点。
   */
  function applyDefaults(kind) {
    const views = modelViews();
    const userRows = views.filter(m => !m.isRouter);
    if (kind === "all") {
      toggles.disabledModels = [];
      toggles.routerEnabled = views.filter(m => m.isRouter).map(m => m.key);
    } else if (kind === "none") {
      toggles.disabledModels = views.map(m => m.key);
      toggles.routerEnabled = [];
    } else {
      const groups = new Map();
      for (const m of userRows) {
        const backend = m.realModel || m.key;
        const prev = groups.get(backend);
        const size = Number(m.contextInput ?? m.context ?? 0);
        if (!prev || size > prev.size || (size === prev.size && m.key < prev.key)) groups.set(backend, { key: m.key, size });
      }
      const keep = new Set([...groups.values()].map(g => g.key));
      toggles.disabledModels = views.filter(m => !keep.has(m.key)).map(m => m.key);
      toggles.routerEnabled = [];
    }
    const saved = saveToggles(toggles);
    if (!saved.ok) return { ok: false, error: saved.error };
    // 人主动点出来的批量改动直接广播一次：签名去重是给 5 分钟轮询用的，
    // 这里要是因为「集合大小没变」而不广播，选择器就会停在旧的一套上。
    try { ctx.emit("llm/models-updated", providerId); } catch { /* 事件不可用时下次刷新自然带上 */ }
    return { ok: true, kept: modelViews().filter(m => m.enabled).map(m => m.key) };
  }

  /**
   * 逐账号读积分（设置页那张表）。
   * 只在人点开时才发请求 —— 每档一次余额 + 一次签到状态，
   * 让它在后台按刷新间隔自动跑等于替用户多烧 N 倍请求量。
   */
  async function readAllAccounts() {
    const bundle = upstream.listProfiles();
    const rows = [];
    for (const p of bundle.profiles) {
      const row = { profileId: p.profileId, displayName: p.displayName, usable: p.usable, active: p.active, selected: p.profileId === knobs().profileId || (!knobs().profileId && p.active) };
      if (!p.usable) { row.error = "这一档的 Cookie 解不开（多半是 App 重装后换了密钥），需要在搭子里重新登录"; rows.push(row); continue; }
      try {
        const client = upstream.clientForProfile(p.profileId, bundle);
        const [packages, bonus, info] = await Promise.all([
          client.cloud.packages(),
          client.cloud.bonusInfo().catch(() => null),
          client.cloud.userInfo().catch(() => null),
        ]);
        const sum = upstream.summarizePackages(packages);
        row.available = sum.available;
        row.packages = sum.packages.map(q => ({ type: q.packageType, source: q.source, remain: q.remain, total: q.total, expireDate: q.expireDate }));
        row.account = info?.displayName || p.displayName;
        row.bonus = bonus ? { todaySigned: (bonus.signInDays ?? []).includes(localDateKey()), totalTimes: bonus.totalTimes ?? 0, totalPoints: bonus.totalPoints ?? 0 } : null;
      } catch (error) {
        row.error = String(error?.message ?? error).slice(0, 160);
      }
      rows.push(row);
    }
    runtime.accounts = { at: Date.now(), rows, reason: bundle.reason ?? null };
    return runtime.accounts;
  }

  /**
   * 恢复默认：把勾选、图片开关、显示名覆盖、路由别名白名单、自动签到全部退回出厂状态。
   * 只动本插件自己的状态文件，不碰上游、不碰 DSH 配置。
   * 之所以要有这个按钮：这些开关都是点一下即生效的，试完想回到起点不该手改 JSON。
   */
  function resetToggles() {
    toggles.disabledModels = [];
    toggles.imageInput = {};
    toggles.displayNames = {};
    toggles.routerEnabled = [];
    toggles.autoCheckIn = false;
    toggles.lastAutoCheckInDate = null;
    const saved = saveToggles(toggles);
    return { ok: saved.ok, error: saved.ok ? null : saved.error, file: saved.file };
  }

  /**
   * 解出用户手动导入的 Cookie —— **只在内存里存在**，每次要用现解，不缓存在字段上，
   * 免得快照、日志、错误信息里无意间把它带出去。
   */
  function manualCookies() {
    if (!toggles.manualCookiesCipher) return null;
    const key = cookieKey();
    if (!key) return null;
    try { return upstream.decryptCookies(toggles.manualCookiesCipher, key); }
    catch { return null; }
  }

  /**
   * 本次实际用的是哪份凭据。取的是最近一次自检里上游认下的那条路，
   * 不是配置里写了什么 —— 配置说 auto、桌面版又可用时，真正在用的就是 app。
   */
  function authSourceUsedNow() {
    return runtime.channel?.authSource ?? null;
  }

  /** 登录方式与手动 Cookie 的对外形状：只有名字、时间、够不够，绝不带值。 */
  function loginInfo() {
    const cookies = manualCookies();
    const check = cookies ? upstream.checkCookies(cookies) : null;
    return {
      authSource: knobs().authSource,
      // 配置值与**实际生效值**分开报：两者不一致时界面要能看出来，否则用户会被 auto 骗
      inUse: authSourceUsedNow(),
      manual: {
        present: !!cookies,
        readable: cookies !== null || !toggles.manualCookiesCipher,
        count: cookies?.length ?? 0,
        names: toggles.manualCookieNames,
        addedAt: toggles.manualCookiesAt || null,
        sufficient: check?.ok ?? false,
        missing: check?.missing ?? upstream.REQUIRED_COOKIES,
      },
      // 注意这里必须是值，不是函数引用 —— 函数在 JSON.stringify 里会被整个丢掉，
      // 界面拿到的就是 undefined，看起来像「没装 App」。
      app: { available: runtime.appAvailable },
    };
  }

  async function importManualCookies(text) {
    const parsed = upstream.parseCookieInput(text);
    if (parsed.error) return { ok: false, error: parsed.error };
    const check = upstream.checkCookies(parsed.cookies);
    if (!check.ok) {
      return {
        ok: false,
        error: `粘进来的 ${parsed.cookies.length} 条里缺 ${check.missing.join("、")}。最少要 bce-sessionid 与 bce-user-info 两个；`
          + "bce-sessionid 是 HttpOnly，浏览器控制台 document.cookie 读不到，得从 DevTools → Application → Cookies 或某个请求的 Cookie 头里复制",
        parsed: { format: parsed.format, count: parsed.cookies.length, missing: check.missing },
      };
    }
    const key = cookieKey();
    if (!key) return { ok: false, error: "造不出本地密钥文件（~/.dsh/dumate-cookies.key），先确认 DSH 数据目录可写" };
    // 先拿它去换一个真 token，成功才存 —— 存一份换不到东西的 Cookie 只会让人以为登录好了
    let verified = null;
    try {
      const probe = upstream.clientFromCookies(parsed.cookies, upstream.userDataDir());
      verified = await probe.gateway.get({ force: true });
    } catch (e) {
      return { ok: false, error: `Cookie 格式没问题，但上游不给网关 token：${String(e?.message ?? e).slice(0, 140)}`, parsed: { format: parsed.format, count: parsed.cookies.length } };
    }
    toggles.manualCookiesCipher = upstream.encryptCookies(parsed.cookies, key);
    toggles.manualCookieNames = parsed.cookies.map(c => c.name);
    toggles.manualCookiesAt = Date.now();
    const saved = saveToggles(toggles);
    if (!saved.ok) {
      toggles.manualCookiesCipher = null; toggles.manualCookieNames = []; toggles.manualCookiesAt = 0;
      return { ok: false, error: `验证通过了但存不下来：${saved.error}` };
    }
    runtime.channelAt = 0; runtime.creditAt = 0;
    await refreshNow();
    // 说清楚这份 Cookie 现在**到底有没有被用上**。auto + 桌面版可用时它只是备胎，
    // 而导入 Cookie 的人多半正是想换一个账号 —— 不写这句，他会以为已经换上了。
    const src = knobs().authSource;
    const inUse = authSourceUsedNow();
    const note = inUse === "manual"
      ? "当前正在使用手动导入的 Cookie。"
      : `已存下，但本次实际用的是「${inUse === "app" ? "桌面版登录态" : "无"}」——登录方式选的是 ${src}。想强制用手动 Cookie，把登录方式改成「只用手动导入 Cookie」。`;
    return { ok: true, verified: true, inUse, note, format: parsed.format, count: parsed.cookies.length, names: toggles.manualCookieNames };
  }

  function clearManualCookies() {
    toggles.manualCookiesCipher = null;
    toggles.manualCookieNames = [];
    toggles.manualCookiesAt = 0;
    const saved = saveToggles(toggles);
    runtime.channelAt = 0; runtime.creditAt = 0;
    return { ok: saved.ok, error: saved.ok ? null : saved.error };
  }

  async function refreshNow() {
    await refreshChannel({ force: true });
    await refreshCredit({ force: true });
    return snapshot();
  }

  /* ---------------------------------------------------------------- 命令 */

  ctx.inject(["commands"], (scoped) => {
    scoped.commands.register({
      name: "dumate",
      description: "百度搭子：连接通道、积分余额、签到状态与模型目录（只读）",
      input: { hint: "models | refresh | doctor" },
      handler: async ({ rawInput }) => {
        const sub = String(rawInput ?? "").trim().toLowerCase();
        if (sub === "models" || sub === "refresh") {
          const ch = await refreshChannel({ force: true });
          if (sub === "refresh") await refreshCredit({ force: true });
          const views = modelViews();
          const lines = views.map(m => `· ${m.displayName} (${m.key})${m.enabled ? "" : "〔未启用〕"}${m.imageInput ? "〔图片〕" : ""} ctx=${fmtTokens(m.contextInput ?? m.context)}${m.realModel ? ` → ${m.realModel}` : ""}`);
          return {
            kind: "success",
            text: `通道：${ch?.channel?.kind === "gateway" ? "云端网关（搭子 App 可以不开）" : ch?.channel?.kind === "local" ? `本地代理 ${ch.channel.baseURL}` : "不可用"}\n`
              + `token：${ch?.gatewayTokenInfo?.present ? `剩 ${ch.gatewayTokenInfo.minutesLeft} 分钟` : "无"}\n`
              + `模型 ${views.length}：\n${lines.join("\n")}\n`,
          };
        }
        if (sub === "doctor") {
          await refreshNow();
          const s = await snapshot();
          return {
            kind: "success",
            text: JSON.stringify({
              ok: s.ok, mode: s.mode, channelKind: s.channelKind, baseURL: s.baseURL, reasons: s.reasons,
              hostView: s.hostView,
              gatewayToken: s.gatewayToken, account: s.account,
              profiles: s.profiles.map(p => ({ name: p.displayName, active: p.active, hasCookies: p.hasCookies })),
              enabledModels: s.models.filter(m => m.enabled).length, totalModels: s.models.length,
              catalogSource: s.catalogSource, catalogAt: s.catalogAt,
              creditError: s.creditError, lastUpstreamError: s.lastUpstreamError,
              checks: s.checks, stateFile: s.stateFile,
              // 登录方式与手动 Cookie 的机器可读形状（只有名字与状态，没有值）——
              // 检查表里有人话版本，这一份是给贴进问题反馈时能对着看的
              login: s.login,
            }, null, 1) + "\n",
          };
        }
        const credit = await refreshCredit({ force: sub === "now" });
        if (!credit) return { kind: "error", text: `读不到积分：${runtime.creditError ?? runtime.channel?.reasons?.join("；") ?? "未知原因"}` };
        return { kind: "success", text: renderCredit(credit, runtime.channel) };
      },
    });
  });

  /* ---------------------------------------------------------------- 工具 */

  const textOutput = { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] };

  ctx.inject(["tools"], (scoped) => {
    scoped.tools.register({
      name: "dumate_credits",
      description: "只读查询本机百度搭子账号的积分余额、积分包构成与今日签到状态。",
      parameters: { type: "object", properties: {} },
      output: textOutput,
      async execute() {
        // 禁用不是错误状态，别抛一句「读不到积分：未知」把人绕进去 —— 直接说清是开关的事。
        if (!enabled) return "百度搭子插件当前已禁用（config.enabled=false），不会向上游发任何请求。要在 设置 → 百度搭子 里启用，或改回配置后重启 DSH。";
        const credit = await refreshCredit({});
        if (!credit) throw new Error(`读不到积分：${runtime.creditError ?? runtime.channel?.reasons?.map(tidyText).join("；") ?? "未知"}`);
        return renderCredit(credit, runtime.channel);
      },
    });

    scoped.tools.register({
      name: "dumate_models",
      description: "只读列出本机百度搭子当前可用的模型（来自云端模型网关目录），含上下文窗口与图片输入能力。",
      parameters: { type: "object", properties: {} },
      output: textOutput,
      async execute() {
        if (!enabled) return "百度搭子插件当前已禁用（config.enabled=false）。启用后再问。";
        const ch = await refreshChannel({ force: true });
        const views = modelViews();
        const text = views.map(m => `${m.key}\t${m.displayName}\tenabled=${m.enabled}\timage=${m.imageInput}\tctx=${fmtTokens(m.contextInput ?? m.context)}${m.realModel ? `\treal=${m.realModel}` : ""}`).join("\n");
        return `通道：${ch?.channel?.kind ?? "无"}（${ch?.channel?.baseURL ?? "-"}）｜token ${ch?.gatewayTokenInfo?.present ? `剩 ${ch.gatewayTokenInfo.minutesLeft} 分钟` : "无"}\n${text || "（目录为空）"}`;
      },
    });

    // 本插件唯一会花钱的能力之一：只能由人显式调用。
    scoped.tools.register({
      name: "dumate_claim_checkin",
      description: "领取百度搭子当日签到积分（真实到账，每天一次）。",
      parameters: { type: "object", properties: {} },
      output: textOutput,
      async execute() {
        if (!enabled) return "百度搭子插件当前已禁用（config.enabled=false），签到也不会执行。";
        const result = await claimCheckIn();
        if (!result.ok) throw new Error(result.error ?? "领取失败");
        return result.granted
          ? "今日签到积分已领取。"
          : `上游没有发放（今天可能已领过）。当前余额 ${fmtNum(runtime.credit?.available)} 积分。`;
      },
    });
  });

  /* ---------------------------------------------------------------- 同源 HTTP 面（给浏览器半段） */

  ctx.inject(["webServer"], (scoped) => {
    const ownOrigin = (() => { try { return scoped.webServer.getOrigin(); } catch { return null; } })();
    const sameOrigin = request => {
      const reqOrigin = request.headers.get("origin");
      // 同源 GET 浏览器通常不带 Origin；POST 必须带且等于自家地址，否则等于给本机任意网页开了写口。
      if (!reqOrigin) return true;
      return !ownOrigin || reqOrigin === ownOrigin;
    };
    const json = (value, status = 200) => new Response(JSON.stringify(value), {
      status, headers: { "Content-Type": "application/json; charset=utf-8" },
    });

    const disposeState = scoped.webServer.register({
      kind: "exact",
      path: "/api/dumate/state",
      resource: async request => (sameOrigin(request)
        ? json(await snapshot(new URL(request.url, "http://local").searchParams.get("view")))
        : json({ error: "forbidden-origin" }, 403)),
    });

    const disposeAction = scoped.webServer.register({      kind: "exact",
      path: "/api/dumate/action",
      handler: async (req, res) => {
        const write = (status, payload) => {
          res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(payload));
        };
        if (req.method !== "POST") return write(405, { ok: false, error: "method-not-allowed" });
        const originHeader = req.headers.origin;
        if (originHeader && ownOrigin && originHeader !== ownOrigin) return write(403, { ok: false, error: "forbidden-origin" });
        let body;
        try { const raw = await readBody(req); body = raw ? JSON.parse(raw) : {}; }
        catch { return write(400, { ok: false, error: "bad-json" }); }

        try {
          if (body.action === "refresh") { await refreshNow(); return write(200, { ok: true, state: await snapshot() }); }
          if (body.action === "model") {
            const r = setModelFlags({ key: body.key, enabled: body.enabled, imageInput: body.imageInput, displayName: body.displayName });
            return write(200, r.ok ? { ok: true, state: await snapshot() } : { ok: false, error: r.error });
          }
          if (body.action === "claim") {
            const r = await claimCheckIn();
            return write(200, r.ok ? { ok: true, granted: r.granted, state: await snapshot() } : { ok: false, error: r.error });
          }
          if (body.action === "knobs") {
            const r = setKnobs({ mode: body.mode, pollIntervalMs: body.pollIntervalMs, activeProfileId: body.activeProfileId, autoCheckIn: body.autoCheckIn });
            if (!r.ok) return write(200, { ok: false, error: r.error });
            await refreshNow();
            return write(200, { ok: true, state: await snapshot() });
          }
          if (body.action === "accounts") {
            // 逐账号读余额：只在人点开时才发这一批请求
            await readAllAccounts();
            return write(200, { ok: true, state: await snapshot() });
          }
          if (body.action === "name") {
            const r = setModelFlags({ key: body.key, displayName: body.displayName });
            return write(200, r.ok ? { ok: true, state: await snapshot() } : { ok: false, error: r.error });
          }
          if (body.action === "reset") {
            const r = resetToggles();
            if (!r.ok) return write(200, { ok: false, error: r.error });
            runtime.channelAt = 0;
            await refreshNow();
            return write(200, { ok: true, state: await snapshot() });
          }
          if (body.action === "defaults") {
            const kind = ["recommended", "all", "none"].includes(body.kind) ? body.kind : "recommended";
            const r = applyDefaults(kind);
            if (!r.ok) return write(200, { ok: false, error: r.error });
            return write(200, { ok: true, kept: r.kept.length, state: await snapshot() });
          }
          if (body.action === "login") {
            if (body.kind === "import") {
              const r = await importManualCookies(body.text);
              // 回执字段一律透传，别在这里重新拼一份 —— 上一版就是这么把 note/inUse 拼丢的，
              // 于是「存了但没用上」这件事用户在界面上永远看不到。
              return write(200, r.ok
                ? { ok: true, verified: r.verified, inUse: r.inUse, note: r.note, format: r.format, count: r.count, names: r.names, state: await snapshot() }
                : { ok: false, error: r.error, parsed: r.parsed });
            }
            if (body.kind === "clear") {
              const r = clearManualCookies();
              if (!r.ok) return write(200, { ok: false, error: r.error });
              await refreshNow();
              return write(200, { ok: true, state: await snapshot() });
            }
            if (body.kind === "source") {
              if (!AUTH_SOURCES.has(body.value)) return write(200, { ok: false, error: `登录方式只认 ${[...AUTH_SOURCES].join("/")}` });
              toggles.authSource = body.value;
              const saved = saveToggles(toggles);
              if (!saved.ok) return write(200, { ok: false, error: saved.error });
              runtime.channelAt = 0; runtime.creditAt = 0;
              await refreshNow();
              return write(200, { ok: true, state: await snapshot() });
            }
            return write(200, { ok: false, error: `login 只支持 import/clear/source` });
          }
          return write(200, { ok: false, error: `unknown action: ${String(body.action ?? "")}` });
        } catch (error) {
          return write(500, { ok: false, error: String(error?.message ?? error).slice(0, 200) });
        }
      },
    });

    // 生成器形式：注册在体内发生，yield 出去的才是卸载时要跑的 disposer。
    // 写成 ctx.effect(() => dispose()) 会在挂载那一刻就把路由拆掉（v0.1 就踩过）。
    ctx.effect(function* () {
      yield () => { disposeState(); disposeAction(); };
    });
  });
  // UI 半段只走上面这个同源面：ctx 是 Cordis 代理，插件不能往它身上挂自定义属性。
}

/**
 * 目录签名：只取会影响选择器的字段。顺序无关（先按 key 排），
 * 免得上游数组顺序抖一下就多发一次 models-updated。
 */
function catalogSignature(models) {
  if (!Array.isArray(models) || !models.length) return "";
  return models
    .map(m => `${m.key}|${m.id}|${m.imageInput ? 1 : 0}|${m.contextInput ?? m.context ?? 0}|${m.output ?? 0}`)
    .sort()
    .join(";");
}

/** 落盘用的指纹：比签名多带上顺序，因为缓存读回来要照原顺序再排一次。 */
function catalogFingerprint(models) {
  return JSON.stringify((models ?? []).map(m => [m.key, m.id, m.imageInput, m.contextInput ?? m.context ?? null, m.output ?? null]));
}

/** 上游给的顺序不稳，按「数字感知」的键名排，让选择器每次看到的次序一样。 */
function compareModelKeys(a, b) {
  const pa = String(a).split(/(\d+)/), pb = String(b).split(/(\d+)/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "", y = pb[i] ?? "";
    if (x === y) continue;
    const nx = Number(x), ny = Number(y);
    if (String(x).match(/^\d+$/) && String(y).match(/^\d+$/)) return nx - ny;
    return x < y ? -1 : 1;
  }
  return 0;
}

function fmtTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "?";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 ? 2 : 0)}M`;
  if (v >= 1000) return `${Math.round(v / 1000)}K`;
  return String(v);
}

function fmtNum(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "?";
}

function fmtDate(sec) {
  const s = Number(sec);
  if (!s || s > 4102444800) return "长期";
  const d = new Date(s * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function renderCredit(c, ch) {
  const lines = [];
  if (ch?.channel?.kind) {
    lines.push(`通道：${ch.channel.kind === "gateway" ? "云端网关（搭子 App 可以不开）" : `本地代理 ${ch.channel.baseURL}`}`);
  }
  lines.push(`百度搭子 · ${c.account}`);
  lines.push(`可用积分 ${fmtNum(c.available)}（24 小时花掉 ${fmtNum(c.consumed24h)}，7 天 ${fmtNum(c.consumed7d)}）`);
  for (const p of c.packages ?? []) lines.push(`· ${p.packageType}/${p.source}：余 ${fmtNum(p.remain)} / ${fmtNum(p.total)}，到期 ${fmtDate(p.expireDate)}`);
  if (c.bonus) lines.push(`签到：今日${c.bonus.todaySigned ? "已签" : "未签"}，累计 ${c.bonus.totalTimes} 次 / ${c.bonus.totalPoints} 分`);
  if (c.expiringSoon?.length) lines.push(`三天内过期：${c.expiringSoon.map(p => `${fmtNum(p.remain)}（${p.daysLeft} 天）`).join("、")}`);
  return lines.join("\n") + "\n";
}
