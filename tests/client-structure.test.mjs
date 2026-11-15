// 客户端半段的结构冒烟测试：用最小假 React + 假 slots/locale 把 client.js 起起来，
// 断言注册了哪些座位、id 是否配对、五个分栏与胶囊各自能不能渲染、卸载是否可跑。
// 不追求样式与交互（那只能在真浏览器里看），这里守的是「注册没写错、组件没抛」。
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const src = fs.readFileSync(path.join(import.meta.dirname, "..", "client.js"), "utf8");

// --- 最小假 React：组件都是普通函数；createElement 顺手把函数组件按名字记下来
const components = {};
// 需要能翻状态再渲染 —— 只返回初值的假 useState 永远走不到 open/click 分支，
// 「点一下就整枚消失」那个 ReferenceError 就是这么漏过去的。
let forcedTab = "accounts";
let effectRuns = 0;
let hookState = null;
const FakeReact = {
  createElement: (type, props, ...children) => {
    if (typeof type !== "function") {
      return { type: String(type), props: props ?? {}, children: children.flat(Infinity) };
    }
    if (type.name) components[type.name] = type;
    // 函数组件**当场递归渲染**（每个组件一套独立 hook 状态，像真 React 那样）。
    // 只记引用不渲染的话，Panel 里面崩了测试是看不见的 —— 上一版就是这么漏掉那个 ReferenceError 的。
    const outer = hookState;
    const local = { slots: {}, refs: {}, index: 0, dirty: true };
    const merged = children.length ? { ...props, children: children.flat(Infinity) } : props;
    let out = null;
    for (let n = 0; n < 8; n++) {
      local.dirty = false;
      local.index = 0;
      hookState = local;
      out = type(merged);
      if (!local.dirty) break;
    }
    hookState = outer;
    return { type: type.name || "Component", props: merged ?? {}, children: [out] };
  },
  Fragment: "Fragment",
  useState: init => {
    const i = hookState.index++;
    if (!(i in hookState.slots)) hookState.slots[i] = typeof init === "function" ? init() : init;
    const setter = v => { hookState.dirty = true; hookState.slots[i] = typeof v === "function" ? v(hookState.slots[i]) : v; };
    return [hookState.slots[i], setter];
  },
  useEffect: fn => { effectRuns++; const c = fn(); return typeof c === "function" ? c : undefined; },
  useCallback: fn => fn,
  useRef: init => {
    const i = hookState.index++;
    if (!(i in hookState.refs)) hookState.refs[i] = { current: init };
    return hookState.refs[i];
  },
  useMemo: fn => fn(),
};

/**
 * 渲染一个函数组件，支持状态更新后重渲染。
 * 关键：状态必须**跨次渲染保持** —— 每次重置的话，点一下翻起来的 open 会在下一次渲染前就被抹掉，
 * 「点击后」那条分支等于根本没测（这正是上一版漏掉 ReferenceError 的第二个原因）。
 * seed 是 `{ hook 序号: 初值 }`（useState 的调用顺序）。
 * SettingsPage 的顺序：0/1/2 = useDumate 的 state/busy/error，3 = 当前分栏，4 = copied。
 */
function renderer(component, props, seed = {}) {
  const st = { slots: { ...seed }, refs: {}, index: 0, dirty: true };
  return {
    st,
    render() {
      let tree = null;
      for (let n = 0; n < 8; n++) {
        st.dirty = false;
        st.index = 0;
        hookState = st;
        tree = component(props);
        if (!st.dirty) break;
      }
      hookState = st;
      return tree;
    },
  };
}

/** 一次性渲染（不需要保留状态时用这个）。 */
function mount(component, props, seed = {}) { return renderer(component, props, seed).render(); }

function findButton(tree, labelIncludes = "") {
  const out = [];
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "button") {
      const text = JSON.stringify(node.props ?? {}) + JSON.stringify(node.children ?? []);
      if (!labelIncludes || text.includes(labelIncludes)) out.push(node);
    }
    for (const c of node.children ?? []) walk(c);
    if (node.props && node.props.children) walk({ children: [node.props.children] });
  })(tree);
  return out;
}

// --- 假浏览器环境
const registered = [];
const disposers = [];
let loaded = null;
const fakeWindow = { __ModuleLoader__: { load: def => { loaded = def; } } };
globalThis.window = fakeWindow;
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ ok: true, providerId: "dumate", models: [], profiles: [], credit: null, checks: [] }),
});
new Function("window", "fetch", "globalThis", src)(fakeWindow, globalThis.fetch, globalThis);
assert.equal(loaded.id, "dsh-connect-dumate", "模块 id 必须等于包名");

const ctx = {
  effect: fn => { const r = fn(); if (typeof r === "function") disposers.push(r); },
  locale: {
    register: (_ns, tables) => assert.deepEqual(Object.keys(tables).sort(), ["en", "zh"], "zh 和 en 两份都要有"),
    bind: () => key => String(key),
  },
  slots: {
    inject: (_name, cb) => { const d = cb(); if (typeof d === "function") disposers.push(d); },
    register: (options, Component) => { registered.push({ ...options, Component }); return () => {}; },
  },
};

const mod = loaded.factory(specifier => {
  if (specifier === "react") return FakeReact;
  throw new Error(`client.js 不该 require 别的包：${specifier}`);
});
assert.deepEqual(mod.inject, ["slots", "locale"], "模块级 inject 只能是 slots + locale");
mod.apply(ctx);

// --- 座位与 id 配对
const names = registered.map(r => r.name).sort();
assert.deepEqual(names, ["conversation.input.right", "settings.section", "settings.section.icon"], `注册座位不对：${names}`);
const page = registered.find(r => r.name === "settings.section");
const icon = registered.find(r => r.name === "settings.section.icon");
const pill = registered.find(r => r.name === "conversation.input.right");
assert.equal(page.id, "dsh-connect-dumate", "设置页 id");
assert.equal(icon.id, page.id, "图标 id 必须等于分栏 id，否则不渲染");
assert.equal(typeof page.label, "function", "label 要写成 thunk，宿主才会在换语言时重读");
assert.equal(typeof pill.label, "function");

// --- 设置页本体 + 五个分栏
const t = key => String(key);
const rendered = mount(page.Component, { t });
assert.ok(rendered, "设置页没渲染出东西");
const flat = JSON.stringify(rendered);
for (const tab of ["tab.accounts", "tab.credits", "tab.models", "tab.capabilities", "tab.doctor"]) {
  assert.ok(flat.includes(tab), `分栏标签缺失：${tab}`);
}

// 假 React 不递归渲染子组件，所以分栏逐个手动调一遍
const tabs = [
  ["AccountsTab", { t, state: null, busy: false, run: async () => ({}) }],
  ["CreditsTab", { t, state: null, busy: false, error: null, run: async () => ({}), reload: async () => ({}) }],
  ["ModelsTab", { t, state: null, busy: false, run: async () => ({}) }],
  ["CapabilitiesTab", { t, state: null, busy: false, run: async () => ({}) }],
  ["DoctorTab", { t, state: null, copied: false, setCopied: () => {} }],
];
// 假 React 不递归渲染子组件：先切 forcedTab 把每个分栏渲染一遍（组件才会被登记），
// 再各自手动调一次，确认不抛、且返回节点。
const tabKeys = { AccountsTab: "accounts", CreditsTab: "credits", ModelsTab: "models", CapabilitiesTab: "capabilities", DoctorTab: "doctor" };
for (const [name, props] of tabs) {
  // 设置页一次只渲染当前分栏，所以按 hook 顺序把第 3 个 state（当前分栏）喂成目标值
  mount(page.Component, { t }, { 3: tabKeys[name] });
  assert.ok(typeof components[name] === "function", `找不到分栏组件 ${name}（tab=${tabKeys[name]}）`);
  assert.ok(mount(components[name], props) !== undefined, `${name} 没有返回节点`);
}

// 带数据再渲染一遍：真实形状的数据不能把组件炸掉
const rich = {
  ok: true, mode: "auto", providerId: "dumate", channelKind: "gateway", baseURL: "https://x/gateway/apis/v1",
  gatewayToken: { present: true, expiresAt: Date.now() + 3600_000, minutesLeft: 60 },
  account: "测试账号", profiles: [{ profileId: "p1", displayName: "测试账号", usable: true, active: true, selected: true }],
  models: [{ key: "glm-5", displayName: "Glm-5", enabled: true, imageInput: false, contextInput: 1000000, realModel: "deepseek-v4.1-flash" }],
  credit: {
    account: "测试账号", available: 1234.5, consumed24: 1, consumed7d: 2,
    packages: [{ packageId: "a", packageType: "plan_pro", source: "buy", remain: 1000, total: 25000, expireDate: 1797265492 }],
    expiringSoon: [{ remain: 10, daysLeft: 2 }],
    bonus: { todaySigned: false, totalTimes: 1, totalPoints: 500 },
    recentUsage: [{ at: 1794720426, points: -2.89, conversation: "某任务", kind: "模型调用" }],
  },
  accounts: { at: Date.now(), rows: [{ profileId: "p1", displayName: "测试账号", available: 1234.5, bonus: { todaySigned: true } }] },
  checks: [["通道", "gateway"]], autoCheckIn: false, pollIntervalMs: 300000, stateFile: "x",
  hostView: { dumateListed: true, models: ["glm-5"] }, reasons: [],
  login: {
    authSource: "auto",
    manual: { present: true, readable: true, count: 2, names: ["bce-sessionid", "bce-user-info"], addedAt: Date.now(), sufficient: true, missing: [] },
    app: { available: true },
  },
};
for (const [name, props] of tabs) {
  assert.ok(mount(components[name], { ...props, state: rich }) !== undefined, `${name} 遇到真实数据抛了`);
}

// 「手动导入 Cookie」这块必须真的渲染出来，而且**绝不把已存的 Cookie 值回填到任何输入框**。
// 粘贴框是凭据入口，回填一次就等于把秘密写进 DOM、进无障碍树、也进浏览器可能的自动填充。
const accountsTree = JSON.stringify(mount(components.AccountsTab, {
  t, busy: false, run: async () => ({}),
  state: { ...rich, profiles: [{ profileId: "p1", displayName: "测试账号", usable: true, active: true, selected: true }] },
}));
for (const key of ["login.title", "login.auto", "login.app", "login.manual", "login.import", "login.storage"]) {
  assert.ok(accountsTree.includes(key), `登录方式区块缺 ${key}`);
}
assert.ok(/"value":""/.test(accountsTree), "粘贴框必须是空的（value 非空说明回填了凭据）");
assert.ok(!accountsTree.includes("001d"), "任何 Cookie 值都不许出现在账号分栏里");
console.log("  ok   登录方式区块渲染完整，且没有把 Cookie 值回填进任何输入框");

// --- 胶囊：会话没选搭子时渲染 null
assert.equal(mount(pill.Component, { useProjection: () => ({ next: { provider: "aliyun" } }), t: key => String(key) }), null, "非本插件 provider 必须不渲染");
assert.ok(mount(pill.Component, { useProjection: () => ({ next: { provider: "dumate" } }), t: key => String(key) }), "选中 dumate 时应渲染");
assert.ok(mount(pill.Component, { useProjection: () => ({ lastUsed: { provider: "dumate" } }), t: key => String(key) }), "只有 lastUsed 时也要渲染");

// 点开面板这条分支必须真的渲染得出来。
// v0.7 在这里裸写了个作用域外的 `t`（那是 apply() 的局部变量），
// 于是「不点还在、点一下整枚消失」——只返回初值的假 useState 永远走不到这条分支，所以没抓到。
const pillInject = pill.inject;
assert.equal(typeof pillInject, "function", "胶囊座位要 inject t，否则组件里拿不到文案函数");
assert.equal(typeof pillInject().t, "function", "inject 必须真的给出 t");

const tReal = key => String(key);
const pillProps = { useProjection: () => ({ next: { provider: "dumate" } }), t: tReal };
const view = renderer(pill.Component, pillProps);
const closed = view.render();
assert.ok(closed, "未点开时要渲染出胶囊");
assert.ok(!JSON.stringify(closed).includes("Panel"), "没点时不该有面板");
const buttons = findButton(closed);
assert.ok(buttons.length >= 1, "该有一个可点的胶囊按钮");
let opened = null;
assert.doesNotThrow(() => {
  buttons[0].props.onClick();
  opened = view.render();
}, "点开面板不该抛（抛了整枚座位就消失）");
assert.ok(JSON.stringify(opened).includes("Panel"), "点开后要渲染出面板");
// state 还没到（异步 fetch 没 await），面板走「标题 + 读取中」这条分支 —— 只要不抛就算通过
const openedJson = JSON.stringify(opened);
assert.ok(openedJson.includes("page.title"), "面板要有标题");
assert.ok(openedJson.includes("common.loading") || openedJson.includes("credits.available"), "面板要有内容分支");

// 有数据时再点一次：刷新按钮必须真的在（守 Panel 的完整渲染路径，不只是它没崩）
// Capsule 的 hook 序号（useState 与 useRef 共用一个计数器，按调用顺序）：
// 0=probedId, 1=probedOnce(ref), 2=viewRef(ref), 3=state, 4=busy, 5=error, 6=open, 7=timerRef(ref)
const richState = { ok: true, account: "测试账号", credit: { available: 1234.5, consumed24h: 1, consumed7d: 2, packages: [], bonus: { todaySigned: false } }, models: [], profiles: [] };
const viewRich = renderer(pill.Component, pillProps, { 3: richState, 6: true });
const richTree = JSON.stringify(viewRich.render());
assert.ok(richTree.includes("panel.refresh"), "有数据时面板该有刷新按钮");
assert.ok(richTree.includes("1,234.5"), "面板该把余额渲染出来");

// 再点关闭，也要不抛
const closeBtn = findButton(opened)[0];
assert.doesNotThrow(() => { closeBtn.props.onClick(); view.render(); }, "收起面板不该抛");

// 少了注入的 t 也必须渲染得出来（退回内置文案）—— 座位不能因为宿主没注入就整枚消失。
// 上一版正是这样崩的：Capsule 裸用 apply() 作用域里的 t，点开即 ReferenceError，React 拆掉整个座位。
const noT = renderer(pill.Component, { useProjection: () => ({ next: { provider: "dumate" } }) }, { 3: richState, 6: true });
let degraded = null;
assert.doesNotThrow(() => { degraded = noT.render(); }, "没有 t 时不该崩");
// 兜底生效的证据：渲染出来的是内置中文原文（而不是 key），说明它走了 fallbackT
const degradedJson = JSON.stringify(degraded);
assert.ok(degradedJson.includes("刷新"), `没有 t 时面板仍要渲染出来（用内置文案），实际树：${degradedJson.slice(0, 160)}`);
assert.ok(degradedJson.includes("Panel"), "面板组件仍应被实例化");
assert.ok(typeof pill.inject === "function" && typeof pill.inject().t === "function", "正常路径仍应注入真实 t");
// 安全阀：宿主没把 useProjection 注进来（座位 props 形状变了）时不能装死不见
assert.ok(mount(pill.Component, { t: key => String(key) }), "拿不到 useProjection 时必须退回显示");
assert.ok(mount(pill.Component, { useProjection: undefined, t: key => String(key) }), "同上（显式 undefined）");
// 但「拿得到、只是这个会话还没选模型」不算读不到，仍然不显示
assert.equal(mount(pill.Component, { useProjection: () => undefined, t: key => String(key) }), null, "投影还没就绪时不显示");

// --- 把每个分栏里的按钮/勾选全点一遍
// 这类 bug 都藏在事件回调里（`t` 那次就是点开才崩），只渲染不点等于没测到。
function collectInteractive(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (typeof node.props?.onClick === "function") out.push(node.props.onClick);
  if (typeof node.props?.onChange === "function") out.push(() => node.props.onChange({ target: { value: "x" } }));
  if (typeof node.props?.onBlur === "function") out.push(() => node.props.onBlur({ target: { value: "覆盖名" } }));
  for (const c of node.children ?? []) collectInteractive(c, out);
  return out;
}
const tabSeed = { accounts: 3, credits: 3, models: 3, capabilities: 3, doctor: 3 };
for (const [key] of Object.entries(tabKeys).map(([n, k]) => [k, n])) {
  const handlers = [];
  // 每个分栏单独渲染（第 3 个 hook 是 SettingsPage 的 tab 状态；前面 useDumate 占 0/1/2）
  const v = renderer(page.Component, { t }, { 0: rich, 3: key });
  const tree = v.render();
  collectInteractive(tree, handlers);
  let threw = null;
  for (const h of handlers) { try { h(); v.render(); } catch (e) { threw = e; break; } }
  if (key === "doctor") {
    // 复制按钮走 navigator.clipboard，测试环境没有 → 组件必须自己吞掉，不能冒出来
    assert.ok(true, "clipboard 缺失已被吞掉（没抛就说明吞了）");
  }
  assert.ok(!threw, `${key} 分栏点控件时抛了：${threw?.message}`);
  console.log(`  ok   分栏 ${key}：${handlers.length} 个交互控件全部点过，无抛出`);
}

// --- i18n 完整性（这条抓过一次真 bug：胶囊面板整块硬写中文，
// 于是英文界面下设置页是英文、点开胶囊却全是中文 —— 半截翻译比整页中文更糟）
{
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex(l => /^\s*const COPY = \{/.test(l));
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) if (/^ {4}\};$/.test(lines[i])) { end = i; break; }
  assert.ok(start > 0 && end > start, "找不到 COPY 块边界，这条检查等于没跑");
  const hardCoded = [];
  lines.forEach((l, i) => {
    if (i >= start && i <= end) return;
    const t = l.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    if (/(["'`])([^"'`\n]*[\u4e00-\u9fa5][^"'`\n]*)\1/.test(l) || /`[^`$]*[\u4e00-\u9fa5]/.test(l)) hardCoded.push(`L${i + 1}`);
  });
  assert.equal(hardCoded.length, 0, `COPY 之外硬写了中文的行：${hardCoded.join(", ")} —— 英文界面下会露出中文`);

  // zh / en 键集必须完全一致，且代码引用的键两份都有
  const blockOf = lang => {
    const s = src.indexOf(`      ${lang}: {`);
    assert.ok(s > 0, `找不到 ${lang} 块`);
    let depth = 0, i = src.indexOf("{", s);
    const from = i;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) break; }
    }
    return new Set([...src.slice(from, i).matchAll(/"([^"]+)"\s*:/g)].map(m => m[1]));
  };
  const zh = blockOf("zh"), en = blockOf("en");
  assert.deepEqual([...zh].filter(k => !en.has(k)), [], `只在 zh 有的键：${[...zh].filter(k => !en.has(k))}`);
  assert.deepEqual([...en].filter(k => !zh.has(k)), [], `只在 en 有的键：${[...en].filter(k => !zh.has(k))}`);
  const used = [...new Set([...src.matchAll(/\bt\("([^"]+)"\)/g)].map(m => m[1]))];
  assert.deepEqual(used.filter(k => !zh.has(k)), [], `引用了但没有译文的键：${used.filter(k => !zh.has(k))}`);
  // 定义了却没人用的键也要报 —— 它是「文案改了、界面没跟上」的信号
  const dead = [...zh].filter(k => !used.includes(k) && !k.startsWith("nav."));
  assert.deepEqual(dead, [], `定义了但界面没用到的键（要么用上要么删）：${dead.join(", ")}`);
  console.log(`  ok   i18n：COPY 之外零硬写中文，zh/en 各 ${zh.size} 键对齐，${used.length} 个引用全有译文，无死键`);
}

// --- 卸载
for (const d of disposers) d();
assert.ok(effectRuns > 0, "effect 没跑过");
console.log(`PASS：座位 ${names.join(" / ")}；分栏 ${tabs.length} 个（空数据 + 真实数据各渲染一遍）；胶囊按 provider 显隐；disposer ${disposers.length} 个可跑`);
process.exit(0);
