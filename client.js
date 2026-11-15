/**
 * dsh-connect-dumate / client.js —— 浏览器半段
 *
 * 两个座位：
 *  1. `conversation.input.right`（出厂零占用）：只读积分胶囊，且只在会话选中百度搭子时出现；
 *  2. `settings.section` + `settings.section.icon`：设置 → 百度搭子，五个分栏
 *     账号 / 积分 / 模型 / 能力 / 诊断。照 dsh-connect-workbuddy 的分栏思路，
 *     但只放搭子真有的能力 —— 上游没给的倍率、我们没有的账号池自动换号，一律不做。
 *
 * 实践规则（照 DSH 插件实践）：不 require 任何 Harness 客户端包，markup/CSS 自带；
 * 颜色走 --dsh-alias-* 并有兜底值；浮层 portal 到 document.body；不碰别人的 DOM。
 * 数据全部来自插件自己的同源接口 /api/dumate/state，写操作走 /api/dumate/action。
 */
window.__ModuleLoader__.load({
  id: "dsh-connect-dumate",
  factory(require) {
    const React = require("react");
    const { createElement: h, useState, useEffect, useCallback, useRef } = React;

    const NS = "settings.dumate";
    const SECTION_ID = "dsh-connect-dumate";
    const COPY = {
      zh: {
        "nav.panel": "百度搭子",
        "capsule.title": "百度搭子积分",
        "capsule.unavailable": "搭子未就绪",
        "tab.accounts": "账号",
        "tab.credits": "积分",
        "tab.models": "模型",
        "tab.capabilities": "能力",
        "tab.doctor": "诊断",
        "page.title": "接入使用 百度搭子（DuMate）模型与积分",
        "page.subtitle": "在 DSH 中使用本机登录的百度搭子：模型目录与对话走搭子自己的云端模型网关，因此 App 不用开着；积分余额、积分包、每日签到与近 7 天消耗都是只读查询。插件不写搭子 App 的任何文件。",
        "accounts.hint": "这里列的是本机搭子登录过的账号档。选哪一个只影响本插件用谁的凭据；搭子 App 自己登录的是谁，插件不动。",
        "accounts.use": "使用",
        "accounts.inuse": "本插件在用",
        "accounts.appactive": "App 当前登录",
        "accounts.read": "读所有账号积分",
        "accounts.reading": "读取中…",
        "accounts.balance": "余额",
        "accounts.signed": "签到",
        "accounts.unusable": "Cookie 解不开：多半是 App 重装后换了密钥，需要在搭子里重新登录",
        "login.title": "登录方式",
        "login.subtitle": "这个插件不注册账号、不代你登录，只复用这台机器上已有的登录态。两条路，装完默认走第一条。",
        "login.auto": "自动（优先桌面版，拿不到再用手动导入）",
        "login.app": "只用桌面版 App",
        "login.manual": "只用手动导入 Cookie",
        "login.detected": "当前检测",
        "login.appYes": "找到桌面版登录态",
        "login.appNo": "没找到桌面版登录态",
        "login.manualHas": "手动导入",
        "login.manualUnits": "条 Cookie",
        "login.manualNone": "手动 Cookie：未导入",
        "login.missing": "缺",
        "login.howto": "怎么取这两个 Cookie（不装桌面版时用）",
        "login.step1": "用浏览器登录 https://console.bce.baidu.com（用你搭子同一个百度账号）。",
        "login.step2": "按 F12 打开 DevTools → Application（应用）→ Cookies → 选中 https://console.bce.baidu.com。",
        "login.step3": "找到 bce-sessionid 与 bce-user-info 两行，把它们的 Value 复制下来。",
        "login.step4": "在下面的框里粘成 bce-sessionid=…; bce-user-info=… 的形式（也接受 JSON 数组或 cookies.txt）。",
        "login.httponly": "注意：bce-sessionid 是 HttpOnly，浏览器控制台里 document.cookie 读不到它，必须按上面从 DevTools 复制。",
        "login.placeholder": "粘在这里，例如：bce-sessionid=001d…; bce-user-info=\"2026-…|…\"",
        "login.import": "导入并验证",
        "login.clear": "清除手动 Cookie",
        "login.okPrefix": "已导入并验证通过（",
        "login.okSuffix": " 条）",
        "login.storage": "存法：Cookie 用随机密钥（AES-256-GCM）加密后写进 ~/.dsh/dumate-state.json，密钥单独放 ~/.dsh/dumate-cookies.key，明文只在内存里短暂存在、不写日志也不回传给页面。这和桌面版自己的保护水平一样：能挡住「备份/截图/贴日志时带出去」这类意外，挡不住能读你用户目录里这两个文件的程序。不想留就点清除。",
        "credits.available": "可用积分",
        "credits.24h": "24 小时消耗",
        "credits.7d": "7 天消耗",
        "credits.packages": "积分包",
        "credits.expire": "到期",
        "credits.longterm": "长期",
        "credits.bonus.signed": "今日已签到",
        "credits.bonus.unsigned": "今日未签到",
        "credits.bonus.claim": "领取今日签到",
        "credits.bonus.note": "签到会真实领取上游积分，一天一次；只有点这个按钮（或显式调用 dumate_claim_checkin）才会发生。",
        "credits.recent": "近 7 天消耗明细",
        "credits.refresh": "刷新",
        "models.hint": "勾选是即时生效的（不落「草稿」）：关掉的路由不会出现在模型选择器里。上下文窗口与图片能力都取自上游目录原值，插件不改。",
        "models.refresh": "重新读目录",
        "models.enabled": "启用",
        "models.image": "图片输入",
        "models.name": "自定义名",
        "models.real": "后端",
        "models.ctx": "上下文",
        "models.router": "自动路由别名：这一行不指向固定模型，每次请求由上游挑一个落",
        "models.reset": "恢复默认勾选",
        "models.resetNote": "清掉本插件记下的勾选、图片开关、显示名覆盖与自动签到开关；不动上游、不动 DSH 配置。",
        "models.realHint": "显示名 = 上游说的真实模型名 + 括号里中转站返回的 id。真实名只在这台机器真发过一次请求之后才知道（来自响应头），在那之前先显示 id 原文。",
        "models.observed": "探测时间",
        "models.recommend": "推荐（按后端去重）",
        "models.recommendNote": "每个互不相同的后端只留一行（实测 glm-5、ernie-4.5-turbo-vl-32k、qwen2.5-vl-32b-instruct、deepseek-v4-flash-0731、deepseek-v41-flash 落的是同一个模型，全开着就是五个名字不同、行为一样的行）；同组留上下文窗口最大的，自动路由档位一律关。",
        "models.all": "全选",
        "models.none": "全不选",
        "models.inPicker": "选择器里",
        "cap.mode": "通道",
        "cap.mode.auto": "自动（先云端网关，拿不到 token 再退回本机 App 代理）",
        "cap.mode.gateway": "只用云端网关（App 可以完全不开）",
        "cap.mode.local": "只用 App 自带的本地代理（App 必须开着）",
        "cap.poll": "积分刷新间隔",
        "cap.autocheckin": "每天自动签到",
        "cap.autocheckin.note": "开启后插件每天替当前账号档领一次：先读状态，已签过的不重复领，所以重启也不会多领。关闭：不点按钮就什么都不会发生。默认关闭。",
        "cap.lastcheckin": "上次自动签到日期",
        "cap.none": "从未",
        "doctor.hint": "这一栏只读，存在的唯一理由是能整段贴进问题反馈。里面没有任何会改设置的控件。",
        "doctor.copy": "复制诊断 JSON",
        "doctor.copied": "已复制",
        "common.error": "读数失败",
        "common.loading": "读取中…",

      },
      en: {
        "nav.panel": "DuMate",
        "capsule.title": "DuMate credits",
        "capsule.unavailable": "DuMate unavailable",
        "tab.accounts": "Accounts",
        "tab.credits": "Credits",
        "tab.models": "Models",
        "tab.capabilities": "Capabilities",
        "tab.doctor": "Diagnostics",
        "page.title": "Baidu DuMate models and credits",
        "page.subtitle": "Use the DuMate account signed in on this machine from DSH. The catalog and chat go through DuMate's own cloud model gateway, so the app can stay closed; balances, packages, daily check-in and 7-day spend are read-only. The plugin never writes DuMate's files.",
        "accounts.hint": "Accounts this machine has signed into DuMate with. Picking one only changes which credentials this plugin uses; the app's own login is untouched.",
        "accounts.use": "Use",
        "accounts.inuse": "used by plugin",
        "accounts.appactive": "app's current login",
        "accounts.read": "Read every account's credits",
        "accounts.reading": "Reading…",
        "accounts.balance": "Balance",
        "accounts.signed": "Check-in",
        "accounts.unusable": "Cookies unreadable: the key file changed, sign in inside DuMate again",
        "login.title": "Sign-in method",
        "login.subtitle": "This plugin never registers an account and never signs in for you — it reuses the login state already on this machine. Two ways; the first is the default.",
        "login.auto": "Auto (prefer the desktop app, fall back to pasted cookies)",
        "login.app": "Desktop app only",
        "login.manual": "Pasted cookies only",
        "login.detected": "Detected",
        "login.appYes": "desktop login found",
        "login.appNo": "no desktop login found",
        "login.manualHas": "Pasted",
        "login.manualUnits": "cookies",
        "login.manualNone": "Pasted cookies: none",
        "login.missing": "missing",
        "login.howto": "How to get those two cookies (if you don't install the app)",
        "login.step1": "Sign in at https://console.bce.baidu.com in a browser, with the same Baidu account DuMate uses.",
        "login.step2": "Press F12 → Application → Cookies → select https://console.bce.baidu.com.",
        "login.step3": "Copy the Value of the two rows bce-sessionid and bce-user-info.",
        "login.step4": "Paste them below as bce-sessionid=…; bce-user-info=… (a JSON array or cookies.txt also work).",
        "login.httponly": "Note: bce-sessionid is HttpOnly, so document.cookie in the console cannot see it — copy it from DevTools as above.",
        "login.placeholder": "Paste here, e.g. bce-sessionid=001d…; bce-user-info=\"2026-…|…\"",
        "login.import": "Import and verify",
        "login.clear": "Clear pasted cookies",
        "login.okPrefix": "Imported and verified (",
        "login.okSuffix": " cookies)",
        "login.storage": "How it is stored: the cookies are encrypted with a random AES-256-GCM key into ~/.dsh/dumate-state.json, the key lives separately in ~/.dsh/dumate-cookies.key, and plaintext exists only briefly in memory — never logged, never sent back to the page. That is the same protection level as the desktop app itself: it stops accidents like backups, screenshots or pasted logs, not a program that can already read both files in your user directory. Press clear if you would rather not keep it.",
        "credits.available": "Available credits",
        "credits.24h": "Spend (24h)",
        "credits.7d": "Spend (7d)",
        "credits.packages": "Packages",
        "credits.expire": "Expires",
        "credits.longterm": "no expiry",
        "credits.bonus.signed": "Checked in today",
        "credits.bonus.unsigned": "Not checked in today",
        "credits.bonus.claim": "Claim daily check-in",
        "credits.bonus.note": "Claiming really grants upstream credits, once a day; it only happens when you press this (or call dumate_claim_checkin).",
        "credits.recent": "Last 7 days of spend",
        "credits.refresh": "Refresh",
        "models.hint": "Toggles apply immediately: a disabled route disappears from the picker. Context windows and image capability come straight from the upstream catalog.",
        "models.refresh": "Reload catalog",
        "models.enabled": "On",
        "models.image": "Image input",
        "models.name": "Custom name",
        "models.real": "Backend",
        "models.ctx": "Context",
        "models.router": "Auto-routing alias: this row is not a fixed model; the upstream picks one per request",
        "models.reset": "Reset toggles",
        "models.resetNote": "Clears what this plugin remembered: enable flags, image toggles, name overrides and auto check-in. Touches neither upstream nor DSH config.",
        "models.realHint": "Name = the real model the upstream reported, plus the relay's own id in parentheses. The real name is only known after this machine has actually sent one request (it comes from a response header); until then the id stands alone.",
        "models.observed": "Observed",
        "models.recommend": "Recommended (dedupe by backend)",
        "models.recommendNote": "Keeps one row per distinct backend — five ids (glm-5, ernie-4.5-turbo-vl-32k, qwen2.5-vl-32b-instruct, deepseek-v4-flash-0731, deepseek-v41-flash) measurably serve the same model, so enabling all five just gives the picker five differently named copies of one row. Within a group the largest context window wins; auto-routing tiers stay off.",
        "models.all": "Select all",
        "models.none": "Select none",
        "models.inPicker": "In picker",
        "cap.mode": "Channel",
        "cap.mode.auto": "Auto (cloud gateway first, fall back to the local app proxy)",
        "cap.mode.gateway": "Cloud gateway only (the app can stay closed)",
        "cap.mode.local": "Local app proxy only (the app must be running)",
        "cap.poll": "Credit refresh interval",
        "cap.autocheckin": "Daily auto check-in",
        "cap.autocheckin.note": "When on, the plugin claims once a day for the selected account: it reads the state first and never re-claims a day already signed, so a restart cannot double-claim. Off means nothing happens unless you press the button. Default off.",
        "cap.lastcheckin": "Last auto check-in date",
        "cap.none": "never",
        "doctor.hint": "Read-only. This tab exists so the whole block can be pasted into a bug report; it holds no controls that change anything.",
        "doctor.copy": "Copy diagnostics JSON",
        "doctor.copied": "Copied",
        "common.error": "Read failed",
        "common.loading": "Loading…",

      },
    };

    const num = v => {
      const n = Number(v);
      return Number.isFinite(n) ? n.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "—";
    };
    const fmtDate = sec => {
      const s = Number(sec);
      if (!s || s > 4102444800) return "长期";
      const d = new Date(s * 1000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const fmtTokens = n => {
      const v = Number(n);
      if (!Number.isFinite(v)) return "?";
      return v >= 1_000_000 ? `${(v / 1_000_000).toFixed(v % 1_000_000 ? 2 : 0)}M` : v >= 1000 ? `${Math.round(v / 1000)}K` : String(v);
    };

    const style = {
      pill: {
        display: "inline-flex", alignItems: "center", gap: 6,
        height: 24, padding: "0 9px", borderRadius: 999,
        border: "1px solid var(--dsh-alias-border, rgba(128,128,128,.35))",
        background: "var(--dsh-alias-surface, rgba(128,128,128,.08))",
        color: "var(--dsh-alias-text, inherit)",
        fontSize: 12, lineHeight: "22px", cursor: "pointer", whiteSpace: "nowrap",
      },
      dot: ok => ({ width: 7, height: 7, borderRadius: "50%", background: ok ? "var(--dsh-alias-success, #2ea36b)" : "var(--dsh-alias-warning, #d8a13a)" }),
      mask: { position: "fixed", inset: 0, zIndex: 1200, background: "rgba(0,0,0,.28)", display: "flex", alignItems: "center", justifyContent: "center" },
      card: {
        width: "min(560px, 92vw)", maxHeight: "82vh", overflowY: "auto",
        background: "var(--dsh-alias-elevated, #fff)", color: "var(--dsh-alias-text, #222)",
        border: "1px solid var(--dsh-alias-border, rgba(128,128,128,.3))",
        borderRadius: 12, padding: "14px 16px", fontSize: 13, lineHeight: 1.5, boxShadow: "0 18px 48px rgba(0,0,0,.24)",
      },
      page: { fontSize: 13, lineHeight: 1.55, color: "var(--dsh-alias-text, #222)", maxWidth: 760, padding: "4px 2px 24px" },
      h1: { fontSize: 17, fontWeight: 700, margin: "2px 0 6px" },
      sub: { fontSize: 12, opacity: .72, margin: "0 0 14px" },
      tabs: { display: "flex", gap: 18, borderBottom: "1px solid var(--dsh-alias-border, rgba(128,128,128,.28))", marginBottom: 14 },
      tab: active => ({
        padding: "6px 2px 8px", cursor: "pointer", fontSize: 13, fontWeight: active ? 650 : 450,
        color: active ? "var(--dsh-alias-text, #222)" : "var(--dsh-alias-text-muted, rgba(128,128,128,.85))",
        borderBottom: active ? "2px solid var(--dsh-alias-accent, #3b82f6)" : "2px solid transparent",
        marginBottom: -1,
      }),
      section: { border: "1px solid var(--dsh-alias-border, rgba(128,128,128,.28))", borderRadius: 10, padding: "12px 14px", marginBottom: 12 },
      sectionTitle: { fontWeight: 650, marginBottom: 4 },
      hint: { fontSize: 11.5, opacity: .7, margin: "2px 0 10px" },
      row: { display: "flex", justifyContent: "space-between", gap: 12, padding: "3px 0" },
      label: { opacity: .68 },
      big: { fontSize: 22, fontWeight: 700, letterSpacing: ".2px" },
      btn: {
        height: 26, padding: "0 12px", borderRadius: 7, cursor: "pointer", fontSize: 12,
        border: "1px solid var(--dsh-alias-border, rgba(128,128,128,.35))",
        background: "var(--dsh-alias-surface, rgba(128,128,128,.08))", color: "var(--dsh-alias-text, inherit)",
      },
      btnPrimary: { height: 26, padding: "0 12px", borderRadius: 7, cursor: "pointer", fontSize: 12, border: "1px solid transparent", background: "var(--dsh-alias-accent, #3b82f6)", color: "#fff" },
      modelRow: { display: "grid", gridTemplateColumns: "22px minmax(150px,1fr) 78px 84px 1fr", gap: 8, alignItems: "center", padding: "4px 0" },
      small: { fontSize: 11, opacity: .62 },
      mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 11.5, whiteSpace: "pre-wrap", wordBreak: "break-all" },
      input: {
        height: 24, fontSize: 12, padding: "0 6px", borderRadius: 6, width: "100%",
        border: "1px solid var(--dsh-alias-border, rgba(128,128,128,.35))",
        background: "var(--dsh-alias-surface, rgba(128,128,128,.06))", color: "inherit",
      },
      select: { height: 26, fontSize: 12, borderRadius: 6, padding: "0 6px", border: "1px solid var(--dsh-alias-border, rgba(128,128,128,.35))", background: "var(--dsh-alias-elevated, #fff)", color: "inherit" },
    };

    async function readState(view) {
      // view：把浏览器这边的可见性判定回报给宿主，/dumate doctor 才说得出「为什么没出现」。
      const q = view ? `?view=${encodeURIComponent(view)}` : "";
      const res = await fetch(`/api/dumate/state${q}`, { credentials: "same-origin", headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }
    async function postAction(body) {
      const res = await fetch("/api/dumate/action", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
      return json;
    }

    /** 两个座位共用的一份数据 + 一套动作，避免卡片和设置页各读各的。 */
    function useDumate(viewRef) {
      const [state, setState] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);

      const reload = useCallback(async (quiet = true) => {
        try {
          const next = await readState(viewRef?.current ? String(viewRef.current) : "");
          setState(next);
          setError(next?.creditError ?? null);
        } catch (e) {
          setError(String(e?.message ?? e));
        } finally {
          if (!quiet) setBusy(false);
        }
      }, [viewRef]);

      const run = useCallback(async (body, quiet = true) => {
        if (!quiet) setBusy(true);
        try {
          const json = await postAction(body);
          if (json.state) setState(json.state);
          else await reload(true);
          setError(null);
          return json;
        } catch (e) {
          setError(String(e?.message ?? e));
          return { ok: false, error: String(e?.message ?? e) };
        } finally {
          if (!quiet) setBusy(false);
        }
      }, [reload]);

      return { state, setState, busy, error, setError, reload, run };
    }

    // <!--GATE-START：胶囊可见性的纯判定；tests/pill-visibility.test.mjs 会把这段抠出来直接测-->
    /**
     * 当前会话选中的 provider id。
     * `next` 是刚提交还没落地的选择，`lastUsed` 是已生效的 —— 优先看 next，
     * 这样「刚切到百度搭子」的那一帧胶囊就该出现（照 dsh-connect-workbuddy 的判定）。
     */
    function selectedProviderOf(projection) {
      const provider = (projection?.next ?? projection?.lastUsed)?.provider;
      return typeof provider === "string" && provider !== "" ? provider : null;
    }

    /**
     * 只有会话选中本插件的 provider 时才显示读数；别的模型一律不出现，
     * 也不启动轮询 —— 用其它 provider 的人不该看到一串和自己计费无关的数字，
     * 也不该为此每几分钟打一次上游。
     */
    function shouldShowPill(projection, providerIds) {
      const provider = selectedProviderOf(projection);
      return provider !== null && Array.isArray(providerIds) && providerIds.includes(provider);
    }
    // <!--GATE-END-->

    /* ---------------------------------------------------------------- 设置页：五个分栏 */

    function AccountsTab({ t, state, busy, run }) {
      const profiles = state?.profiles ?? [];
      const accounts = state?.accounts;
      const login = state?.login ?? null;
      const rowOf = id => (accounts?.rows ?? []).find(r => r.profileId === id);
      const [paste, setPaste] = useState("");
      const [notice, setNotice] = useState(null);

      async function doImport() {
        setBusy(true);
        const r = await run({ action: "login", kind: "import", text: paste });
        setBusy(false);
        if (r.ok) { setNotice({ ok: true, text: `${t("login.okPrefix")}${r.count}${t("login.okSuffix")}` }); setPaste(""); }
        else setNotice({ ok: false, text: r.error || t("common.error") });
      }

      return h("div", null,
        // ---- 登录方式（两条路）----
        h("div", { style: style.section },
          h("div", { style: style.sectionTitle }, t("login.title")),
          h("div", { style: style.hint }, t("login.subtitle")),
          h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", margin: "6px 0 10px" } },
            [["auto", t("login.auto")], ["app", t("login.app")], ["manual", t("login.manual")]].map(([v, label]) => h("label", { key: v, style: { display: "flex", alignItems: "center", gap: 5, cursor: "pointer" } },
              h("input", {
                type: "radio", name: "dumate-auth-source", value: v,
                checked: (login?.authSource ?? "auto") === v, disabled: busy,
                onChange: () => run({ action: "login", kind: "source", value: v }, false),
              }), h("span", null, label)))),
          h("div", { style: style.small },
            `${t("login.detected")}：${login?.app?.available ? t("login.appYes") : t("login.appNo")}`,
            login?.manual?.present
              ? ` · ${t("login.manualHas")} ${login.manual.count} ${t("login.manualUnits")}${login.manual.sufficient ? "" : `（${t("login.missing")} ${login.manual.missing.join("、")}）`}`
              : ` · ${t("login.manualNone")}`),
          h("details", { style: { margin: "8px 0 0" } },
            h("summary", { style: { cursor: "pointer", fontSize: 12 } }, t("login.howto")),
            h("ol", { style: { margin: "6px 0 0", paddingLeft: 18, fontSize: 11.5, lineHeight: 1.7, opacity: .82 } },
              h("li", null, t("login.step1")),
              h("li", null, t("login.step2")),
              h("li", null, t("login.step3")),
              h("li", null, t("login.step4"))),
            h("div", { style: { ...style.small, marginTop: 6, color: "var(--dsh-alias-warning, #b8860b)" } }, t("login.httponly"))),
          h("textarea", {
            style: { ...style.input, height: 62, resize: "vertical", fontFamily: "ui-monospace, Menlo, Consolas, monospace", padding: 6 },
            placeholder: t("login.placeholder"), value: paste, spellCheck: false, autoComplete: "off",
            onChange: e => setPaste(e.target.value),
          }),
          h("div", { style: { display: "flex", gap: 8, marginTop: 6, alignItems: "center", flexWrap: "wrap" } },
            h("button", { style: style.btnPrimary, disabled: busy || !paste.trim(), onClick: () => doImport() }, t("login.import")),
            login?.manual?.present ? h("button", { style: style.btn, disabled: busy, onClick: () => run({ action: "login", kind: "clear" }, false) }, t("login.clear")) : null,
            notice ? h("span", { style: { ...style.small, color: notice.ok ? "var(--dsh-alias-success, #2ea36b)" : "var(--dsh-alias-danger, #d33)" } }, notice.text) : null),
          h("div", { style: { ...style.hint, marginTop: 6 } }, t("login.storage"))),
        // ---- 账号档 ----
        h("div", { style: style.hint }, t("accounts.hint")),
        profiles.length === 0 ? h("div", { style: style.small }, state?.reasons?.join("；") || "本机没有账号档") : null,
        profiles.map(p => {
          const acc = rowOf(p.profileId);
          const selected = p.selected || (!state?.profiles.some(q => q.selected) && p.active);
          return h("div", { key: p.profileId, style: { ...style.section, padding: "10px 12px" } },
            h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
              h("span", { style: style.dot(p.usable) }),
              h("strong", null, p.displayName),
              p.active ? h("span", { style: style.small }, t("accounts.appactive")) : null,
              selected ? h("span", { style: { ...style.small, color: "var(--dsh-alias-accent, #3b82f6)" } }, t("accounts.inuse")) : null,
              h("span", { style: { flex: 1 } }),
              acc?.available !== undefined ? h("span", { style: { fontWeight: 650 } }, `${t("accounts.balance")} ${num(acc.available)}`) : null,
              acc?.bonus ? h("span", { style: style.small }, `${t("accounts.signed")} ${acc.bonus.todaySigned ? "✓" : "—"}`) : null,
              selected ? null : h("button", {
                style: style.btn, disabled: busy || !p.usable,
                onClick: () => run({ action: "knobs", activeProfileId: p.profileId }, false),
              }, t("accounts.use"))),
            p.usable ? null : h("div", { style: { ...style.small, marginTop: 6, color: "var(--dsh-alias-danger, #d33)" } }, t("accounts.unusable")),
            acc?.error ? h("div", { style: { ...style.small, marginTop: 6 } }, acc.error) : null,
            acc?.packages?.length ? h("div", { style: { marginTop: 6 } }, acc.packages.map((q, i) => h("div", { key: i, style: style.row },
              h("span", { style: style.label }, `${q.type} / ${q.source}`),
              h("span", null, `${num(q.remain)} / ${num(q.total)} · ${q.expireDate > 4102444800 ? t("credits.longterm") : fmtDate(q.expireDate)}`)))) : null);
        }),
        h("div", { style: { display: "flex", gap: 8, marginTop: 4 } },
          h("button", { style: style.btnPrimary, disabled: busy || !profiles.length, onClick: () => run({ action: "accounts" }, false) },
            accounts ? t("credits.refresh") : t("accounts.read")),
          accounts?.at ? h("span", { style: { ...style.small, alignSelf: "center" } }, new Date(accounts.at).toLocaleTimeString("zh-CN")) : null));
    }

    function CreditsTab({ t, state, busy, error, run, reload }) {
      const credit = state?.credit;
      return h("div", null,
        h("div", { style: { display: "flex", gap: 8, marginBottom: 10 } },
          h("button", { style: style.btn, disabled: busy, onClick: () => reload(false) }, t("credits.refresh"))),
        error ? h("div", { style: { ...style.small, color: "var(--dsh-alias-danger, #d33)", marginBottom: 8 } }, `${t("common.error")}：${error}`) : null,
        !credit ? h("div", { style: style.small }, t("common.loading")) : h("div", null,
          h("div", { style: style.section },
            h("div", { style: style.row }, h("span", { style: style.label }, credit.account), h("span", { style: style.big }, num(credit.available))),
            h("div", { style: style.row }, h("span", { style: style.label }, t("credits.24h")), h("span", null, num(credit.consumed24h))),
            h("div", { style: style.row }, h("span", { style: style.label }, t("credits.7d")), h("span", null, num(credit.consumed7d))),
            credit.expiringSoon?.length ? h("div", { style: { ...style.row, color: "var(--dsh-alias-warning, #b8860b)" } },
              h("span", null, "三天内过期"), h("span", null, credit.expiringSoon.map(p => `${num(p.remain)}（${p.daysLeft} 天）`).join("、"))) : null),
          h("div", { style: style.section },
            h("div", { style: style.sectionTitle }, t("credits.packages")),
            (credit.packages ?? []).map(p => h("div", { key: p.packageId, style: style.row },
              h("span", { style: style.label }, `${p.packageType} / ${p.source}`),
              h("span", null, `${num(p.remain)} / ${num(p.total)} · ${t("credits.expire")} ${p.expireDate > 4102444800 ? t("credits.longterm") : fmtDate(p.expireDate)}`)))),
          h("div", { style: style.section },
            h("div", { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
              h("strong", null, credit.bonus ? (credit.bonus.todaySigned ? t("credits.bonus.signed") : t("credits.bonus.unsigned")) : t("common.loading")),
              credit.bonus ? h("span", { style: style.small }, `累计 ${credit.bonus.totalTimes} 次 / ${num(credit.bonus.totalPoints)} 分`) : null,
              h("span", { style: { flex: 1 } }),
              credit.bonus?.todaySigned ? null : h("button", { style: style.btnPrimary, disabled: busy, onClick: () => run({ action: "claim" }, false) }, t("credits.bonus.claim"))),
            h("div", { style: { ...style.hint, marginTop: 6 } }, t("credits.bonus.note"))),
          (credit.recentUsage ?? []).length ? h("div", { style: style.section },
            h("div", { style: style.sectionTitle }, t("credits.recent")),
            credit.recentUsage.map((r, i) => h("div", { key: i, style: style.row },
              h("span", { style: style.label }, `${new Date((r.at || 0) * 1000).toLocaleString("zh-CN")} · ${r.kind}${r.conversation ? ` · ${r.conversation}` : ""}`),
              h("span", null, num(r.points))))) : null));
    }

    function ModelsTab({ t, state, busy, run }) {
      const models = state?.models ?? [];
      return h("div", null,
        h("div", { style: style.hint }, t("models.hint")),
        h("div", { style: style.hint }, t("models.realHint"),
          state?.realNamesObservedAt ? ` · ${t("models.observed")} ${new Date(state.realNamesObservedAt).toLocaleString("zh-CN")}` : ""),
        h("div", { style: { display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" } },
          h("button", { style: style.btnPrimary, disabled: busy, title: t("models.recommendNote"), onClick: () => run({ action: "defaults", kind: "recommended" }, false) }, t("models.recommend")),
          h("button", { style: style.btn, disabled: busy, onClick: () => run({ action: "defaults", kind: "all" }, false) }, t("models.all")),
          h("button", { style: style.btn, disabled: busy, onClick: () => run({ action: "defaults", kind: "none" }, false) }, t("models.none")),
          h("button", { style: style.btn, disabled: busy, onClick: () => run({ action: "refresh" }, false) }, t("models.refresh")),
          h("button", { style: style.btn, disabled: busy, title: t("models.resetNote"), onClick: () => run({ action: "reset" }, false) }, t("models.reset")),
          h("span", { style: { ...style.small, alignSelf: "center" } }, `${t("models.inPicker")} ${state?.pickerCount ?? "?"} / ${models.length} · ${state?.catalogSource ?? "?"}`)),
        models.length === 0 ? h("div", { style: style.small }, "—") : null,
        h("div", { style: style.section },
          h("div", { style: { ...style.modelRow, ...style.small, fontWeight: 650 } },
            h("span", null, t("models.enabled")), h("span", null, "模型"), h("span", null, t("models.ctx")), h("span", null, t("models.image")), h("span", null, t("models.name"))),
          models.map(m => h("div", { key: m.key, style: style.modelRow },
            h("input", { type: "checkbox", checked: m.enabled, onChange: () => run({ action: "model", key: m.key, enabled: !m.enabled }) }),
            // 主名已经是「真实模型名 (中转站 id)」，不再另打一遍 key
            h("span", null, m.displayName,
              m.isRouter ? h("div", { style: style.small }, t("models.router")) : null),
            h("span", { style: style.small }, fmtTokens(m.contextInput ?? m.context)),
            h("input", { type: "checkbox", checked: !!m.imageInput, onChange: () => run({ action: "model", key: m.key, imageInput: !m.imageInput }) }),
            h("div", null,
              // 输入框只放「你自己起的覆盖名」；上游给的名字走文字，不混进可编辑框
              h("input", {
                style: style.input,
                placeholder: m.nameSource === "override" ? "" : `留空 = ${m.displayName}`,
                defaultValue: m.nameSource === "override" ? m.displayName : "",
                onBlur: e => { const value = e.target.value.trim(); const current = m.nameSource === "override" ? m.displayName : ""; if (value !== current) run({ action: "name", key: m.key, displayName: value }); },
              }),
              m.realModel ? h("div", { style: style.small }, `${t("models.real")}: ${m.realModel}`) : null)))));
    }

    function CapabilitiesTab({ t, state, busy, run }) {
      const mode = state?.mode ?? "auto";
      const poll = state?.pollIntervalMs ?? 300000;
      return h("div", null,
        h("div", { style: style.section },
          h("div", { style: style.sectionTitle }, t("cap.mode")),
          h("select", {
            style: style.select, value: mode, disabled: busy,
            onChange: e => run({ action: "knobs", mode: e.target.value }, false),
          },
            h("option", { value: "auto" }, t("cap.mode.auto")),
            h("option", { value: "gateway" }, t("cap.mode.gateway")),
            h("option", { value: "local" }, t("cap.mode.local"))),
          h("div", { style: { ...style.hint, marginTop: 6 } }, `当前通道：${state?.channelKind ?? "无"} · ${state?.baseURL ?? "-"}`)),
        h("div", { style: style.section },
          h("div", { style: style.sectionTitle }, t("cap.poll")),
          h("select", {
            style: style.select, value: String(poll), disabled: busy,
            onChange: e => run({ action: "knobs", pollIntervalMs: Number(e.target.value) }, false),
          }, [[60000, "1 分钟"], [300000, "5 分钟"], [600000, "10 分钟"], [1800000, "30 分钟"], [3600000, "60 分钟"]]
            .map(([ms, label]) => h("option", { key: ms, value: String(ms) }, label)))),
        h("div", { style: style.section },
          h("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
            h("input", { type: "checkbox", checked: !!state?.autoCheckIn, disabled: busy, onChange: () => run({ action: "knobs", autoCheckIn: !state?.autoCheckIn }, false) }),
            h("strong", null, t("cap.autocheckin"))),
          h("div", { style: { ...style.hint, marginTop: 6 } }, t("cap.autocheckin.note")),
          h("div", { style: style.small }, `${t("cap.lastcheckin")}：${state?.lastAutoCheckInDate || t("cap.none")}`)));
    }

    function DoctorTab({ t, state, copied, setCopied }) {
      const payload = {
        at: new Date().toISOString(),
        ok: state?.ok, mode: state?.mode, channelKind: state?.channelKind, baseURL: state?.baseURL,
        reasons: state?.reasons, gatewayToken: state?.gatewayToken, hostView: state?.hostView,
        account: state?.account, profiles: (state?.profiles ?? []).map(p => ({ name: p.displayName, active: p.active, usable: p.usable, selected: p.selected })),
        enabledModels: (state?.models ?? []).filter(m => m.enabled).length, totalModels: (state?.models ?? []).length,
        catalogSource: state?.catalogSource, creditError: state?.creditError, lastUpstreamError: state?.lastUpstreamError,
        knobs: { mode: state?.mode, pollIntervalMs: state?.pollIntervalMs, autoCheckIn: state?.autoCheckIn },
        stateFile: state?.stateFile,
      };
      const json = JSON.stringify(payload, null, 1);
      return h("div", null,
        h("div", { style: style.hint }, t("doctor.hint")),
        h("div", { style: { display: "flex", gap: 8, marginBottom: 10 } },
          h("button", {
            style: style.btn,
            onClick: async () => {
              try { await navigator.clipboard.writeText(json); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* 剪贴板不可用时下面就是全文 */ }
            },
          }, copied ? t("doctor.copied") : t("doctor.copy"))),
        (state?.checks ?? []).map(row => h("div", { key: String(row[0]), style: style.row },
          h("span", { style: style.label }, row[0]), h("span", null, String(row[1])))),
        h("pre", { style: { ...style.mono, marginTop: 10 } }, json));
    }

    function SettingsPage(props) {
      const t = withT(props);
      const { state, busy, error, reload, run } = useDumate();
      const [tab, setTab] = useState("accounts");
      const [copied, setCopied] = useState(false);
      useEffect(() => { void reload(false); }, [reload]);

      const tabs = [["accounts", t("tab.accounts")], ["credits", t("tab.credits")], ["models", t("tab.models")], ["capabilities", t("tab.capabilities")], ["doctor", t("tab.doctor")]];
      return h("div", { style: style.page },
        h("div", { style: style.h1 }, t("page.title")),
        h("div", { style: style.sub }, t("page.subtitle")),
        state && !state.ok ? h("div", { style: { ...style.section, borderColor: "var(--dsh-alias-warning, #d8a13a)" } },
          h("div", { style: { fontWeight: 650 } }, state.reasons?.[0] || "通道不可用"),
          h("div", { style: style.hint }, state.reasons?.slice(1).join("；") || "")) : null,
        h("div", { style: style.tabs }, tabs.map(([key, label]) => h("div", { key, style: style.tab(tab === key), onClick: () => setTab(key) }, label))),
        tab === "accounts" ? h(AccountsTab, { t, state, busy, run }) : null,
        tab === "credits" ? h(CreditsTab, { t, state, busy, error, run, reload }) : null,
        tab === "models" ? h(ModelsTab, { t, state, busy, run }) : null,
        tab === "capabilities" ? h(CapabilitiesTab, { t, state, busy, run }) : null,
        tab === "doctor" ? h(DoctorTab, { t, state, copied, setCopied }) : null);
    }

    /* ---------------------------------------------------------------- 胶囊 */

    /**
     * 文案函数兜底：座位没把 `t` 注进来（宿主改了注入方式）时退回内置 zh 表。
     * 这里绝不能让它抛 —— 上一版 `Capsule` 裸用了 apply() 作用域里的 `t`，
     * 一点开就 ReferenceError，React 把整个座位拆掉，症状是「胶囊不点还在、点一下就整枚消失」。
     */
    const fallbackT = key => COPY.zh?.[key] ?? String(key);
    const withT = props => (typeof props?.t === "function" ? props.t : fallbackT);

    function Panel({ t, state, busy, error, onClose, onRefresh, onClaim }) {
      const credit = state?.credit;
      const models = Array.isArray(state?.models) ? state.models : [];
      return h("div", { style: style.mask, onClick: onClose, role: "dialog", "aria-label": t("capsule.title") },
        h("div", { style: style.card, onClick: e => e.stopPropagation() },
          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
            h("strong", null, t("page.title")),
            h("button", { style: style.btn, onClick: onClose }, "×")),
          state ? null : h("div", { style: { padding: "12px 0" } }, t("common.loading")),
          error ? h("div", { style: { padding: "8px 0", color: "var(--dsh-alias-danger, #d33)" } }, `${t("common.error")}：${error}`) : null,
          state && !state.ok ? h("div", { style: { padding: "8px 0" } }, state.reasons?.length ? state.reasons.join("；") : "通道不可用") : null,
          state ? h("div", { style: { ...style.small, padding: "2px 0" } },
            state.channelKind === "gateway" ? "通道：云端模型网关（搭子 App 不用开着）"
              : state.channelKind === "local" ? `通道：本机搭子代理 · ${state.baseURL ?? ""}` : "两条通道都不通",
            state.channelKind === "gateway" && state.gatewayToken?.expiresAt
              ? ` · 网关 token 剩 ${Math.max(0, Math.round((state.gatewayToken.expiresAt - Date.now()) / 60000))} 分钟` : null) : null,
          credit ? h(React.Fragment, null,
            h("hr", { style: { height: 1, background: "var(--dsh-alias-border, rgba(128,128,128,.25))", margin: "10px 0", border: 0 } }),
            h("div", { style: style.row }, h("span", { style: style.label }, "账号"), h("span", null, credit.account || "—")),
            h("div", { style: { ...style.row, fontSize: 16, fontWeight: 700 } }, h("span", { style: style.label }, "可用积分"), h("span", null, num(credit.available))),
            h("div", { style: style.row }, h("span", { style: style.label }, "24 小时消耗"), h("span", null, num(credit.consumed24h))),
            h("div", { style: style.row }, h("span", { style: style.label }, "7 天消耗"), h("span", null, num(credit.consumed7d))),
            h("hr", { style: { height: 1, background: "var(--dsh-alias-border, rgba(128,128,128,.25))", margin: "10px 0", border: 0 } }),
            (credit.packages || []).map(p => h("div", { key: p.packageId, style: style.row },
              h("span", { style: style.label }, `${p.packageType} / ${p.source}`),
              h("span", null, `${num(p.remain)} / ${num(p.total)}`))),
            credit.bonus ? h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 8 } },
              h("span", null, credit.bonus.todaySigned ? "今日已签到" : "今日未签到"),
              credit.bonus.todaySigned ? null : h("button", { style: style.btnPrimary, disabled: busy, onClick: () => onClaim() }, "领取今日签到")) : null,
            h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 } },
              h("button", { style: style.btn, disabled: busy, onClick: () => onRefresh() }, t("credits.refresh")))) : null));
    }

    function Capsule(props) {
      const { useProjection } = props ?? {};
      const t = withT(props);
      const [probedId, setProbedId] = useState(null);
      const probedOnce = useRef(false);
      const viewRef = useRef(null);
      const { state, busy, error, reload, run } = useDumate(viewRef);
      const [open, setOpen] = useState(false);
      const timerRef = useRef(null);

      // 会话当前选中的是哪个 provider —— 决定这枚胶囊到底出不出现。
      // 默认认 dumate；宿主那边若把 providerId 改了，靠下面那次一次性探测补进来
      // （不可见时也要探一次，否则「要先可见才知道 id」会成死循环）。
      const projection = typeof useProjection === "function" ? useProjection("modelSelection") : undefined;
      const myIds = [...new Set(["dumate", state?.providerId, probedId].filter(Boolean))];
      const selected = selectedProviderOf(projection);
      // 安全阀：这个座位压根没把 useProjection 注进来时（宿主换了 props 形状），
      // 一律显示比永远不显示好 —— 静默消失是最难查的那种坏法。
      const canTell = typeof useProjection === "function";
      const visible = canTell ? shouldShowPill(projection, myIds) : true;
      // 把浏览器这边的判定原样带回去，/dumate doctor 才答得出「为什么没出现」。
      viewRef.current = `canTell=${canTell};selected=${selected ?? "-"};visible=${visible}`;

      useEffect(() => {
        if (visible || probedOnce.current) return;
        probedOnce.current = true;
        readState().then(s => { if (typeof s?.providerId === "string") setProbedId(s.providerId); }).catch(() => {});
      }, [visible]);

      // 没选中百度搭子：不发请求、不起定时器。切回来的那一帧才拉第一次。
      useEffect(() => {
        if (!visible) return undefined;
        void reload(false);
        const ms = Number(state?.pollIntervalMs) || 300000;
        timerRef.current = setInterval(() => void reload(true), ms);
        return () => clearInterval(timerRef.current);
      }, [visible, reload, state?.pollIntervalMs]);

      useEffect(() => { if (open && visible) void reload(true); }, [open, visible, reload]);

      const credit = state?.credit;
      const ready = !!state?.ok && !!credit;
      // hooks 全部跑完才做条件返回（React 的规则），所以这里只影响渲染，不影响钩子顺序。
      if (!visible) return null;

      const pillText = ready ? num(credit.available) : (state?.ok === false ? "未就绪" : "…");

      return h(React.Fragment, null,
        h("button", {
          className: "dsm-dumate-capsule", style: style.pill,
          title: ready ? `百度搭子积分 · ${state?.account ?? ""}` : `百度搭子：${(state?.reasons?.[0] ?? "读取中…").slice(0, 90)}（点开看详情，或去 设置 → 百度搭子）`,
          onClick: () => setOpen(v => !v),
        }, h("span", { style: style.dot(state?.ok === true) }), h("span", null, `DM · ${pillText}`)),
        open ? h("div", { id: "dsh-dumate-overlay-root" },
          h(Panel, {
            t, state, busy, error,
            onClose: () => setOpen(false),
            onRefresh: () => reload(false),
            onClaim: async () => { await run({ action: "claim" }, false); },
          })) : null);
    }

    /* ---------------------------------------------------------------- 注册 */

    function DuMateIcon(props) {
      const size = props?.size ?? 16;
      return h("svg", { width: size, height: size, viewBox: "0 0 36 36", fill: "none", "aria-hidden": "true" },
        h("path", { d: "M14.6 7.4c3.9 0 7.1 2.9 7.5 6.7", stroke: "#2F6FED", strokeWidth: 2.6, strokeLinecap: "round" }),
        h("path", { d: "M21.4 28.6c-3.9 0-7.1-2.9-7.5-6.7", stroke: "#2F6FED", strokeWidth: 2.6, strokeLinecap: "round" }),
        h("path", { d: "M21.4 7.4c3.9 0 7.1 2.9 7.5 6.7", stroke: "#18B47E", strokeWidth: 2.6, strokeLinecap: "round" }),
        h("path", { d: "M28.9 20.1c-0.4 3.8-3.6 6.7-7.5 6.7", stroke: "#18B47E", strokeWidth: 2.6, strokeLinecap: "round" }),
        h("circle", { cx: 17.9, cy: 18, r: 3.4, stroke: "#2F6FED", strokeWidth: 2.2 }),
        h("path", { d: "M17.9 16.2v3.6", stroke: "#2F6FED", strokeWidth: 1.8, strokeLinecap: "round" }));
    }

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, COPY), "dumate: copy");
        const t = ctx.locale.bind(NS);

        // 设置页 + 图标：两个注册共用同一个 id，图标只在页面存在时可寻址。
        ctx.slots.inject("settings.section", () => {
          const disposePage = ctx.slots.register({
            name: "settings.section", id: SECTION_ID, order: 36,
            label: () => t("nav.panel"), locale: NS,
            inject: () => ({ t }),
          }, SettingsPage);
          const disposeIcon = ctx.slots.inject("settings.section.icon", () => ctx.slots.register({
            name: "settings.section.icon", id: SECTION_ID, locale: NS,
          }, props => h(DuMateIcon, { size: props?.size ?? 16 })));
          return () => { try { disposeIcon(); } catch {} try { disposePage(); } catch {} };
        });

        ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
          name: "conversation.input.right",
          id: "dsh-connect-dumate-credits",
          order: 4,
          label: () => t("capsule.title"),
          locale: NS,
          inject: () => ({ t }),
        }, Capsule));
      },
    };
  },
});
