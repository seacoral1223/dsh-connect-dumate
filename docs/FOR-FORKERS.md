# 给二创者的笔记

这份文档存在的理由：本仓库最有价值的部分不是代码，是**挖上游接口时攒下的实测事实**。
它们花掉的时间比代码多，而代码会被重构掉、事实不会过期得太快。

阅读顺序建议：先读[上游事实](#上游事实全部实测)，再读[架构决定](#架构决定以及为什么这么定)，
最后看[踩过的坑](#踩过的坑按代价从高到低)。

---

## 上游事实（全部实测）

### 鉴权链

```
本机登录态（Cookie）
  → GET https://console.bce.baidu.com/api/dumate/app/token/get
      → { token: <36 字符>, expired_at: <epoch ms> }
  → GET/POST https://dumate-svc.baidu.com/gateway/apis/v1/{models,chat/completions}
      Authorization: Bearer <token>
```

- **同一个 token 会反复原样返回**，寿命由上游的 `expired_at` 决定（实测约 8 小时）。
  所以只在 `expired_at` 前 3 分钟换新，**不要自作主张设成 2 小时**——那会白取很多次。
- 坏 token 回 `401 {"error_code":336100,"error_message":"Incorrect API Key…"}` → 作废缓存重取**一次**即可，别连着试。
- 云端接口需要这几个头，缺一个就会被拒：`csrftoken`（值等于 `bce-user-info` 的**原始值**）、
  `X-Requested-With: XMLHttpRequest`、`Origin` / `Referer`、`X-Dumate-Client-Type: desktop`、
  `X-Dumate-Device-Id`（从 App 的 device meta 现读）。

### 桌面版登录态在哪（Windows 已实测，macOS/Linux 未验证）

```
%APPDATA%\qianfan-desktop-app\auth.json      # 密文 Cookie + accountProfiles
%APPDATA%\qianfan-desktop-app\.cookie-key    # 32 字节对称密钥
%APPDATA%\qianfan-desktop-app\qianfan_desk_xdg\<bceUserId>\config\opencode\opencode.json
```

- Cookie 加密是 **AES-256-GCM**，密文形态 `base64(iv[12] | authTag[16] | ciphertext)`。
- 目录探测必须走「候选 + 验证 `auth.json` 存在」，**不要把任何一段当常量**：
  `%APPDATA%` vs `%LOCALAPPDATA%`、`qianfan-desktop-app` / `DuMate` / `qianfan_desk_xdg`
  都是观测值而不是保证。macOS/Linux 只有单元测试、没有真机，别写成"支持三平台"。
- 内层真实形状是 `<inner>/<uid>/config/...`（多一层 uid）。只查 `<inner>/config/` 会永远落空，
  而如果探针"没命中也返回一个猜测路径"，调用方无从知道其实没有 —— **找不到就返回 null**。

### 模型目录

- `GET …/gateway/apis/v1/models` → 43 条，字段只有 `id/object/limit/modalities/thinking/temperature/top_p`。
- **目录里没有名字字段。** App 自己的前端包里这些 id 一次都没出现过，也没有别的带名字的端点
  （`/model/list`、`/models/detail`、`api/dumate/model` 都试过）。
  所以默认显示名只能用 id 原文；唯一合法的名字来源是响应头
  `x-dumate-gw-realmodel-displayname`，且必须真发过一次请求才拿得到。
- 响应头 `x-dumate-gw-realmodel` 给出这次**真正路由到**的后端。逐个探测（`max_tokens=1`，可疑的连打三次）结果：

  | SKU id | 实际后端 |
  |---|---|
  | `glm-5`、`ernie-4.5-turbo-vl-32k`、`qwen2.5-vl-32b-instruct`、`deepseek-v4-flash-0731`、`deepseek-v41-flash` | **同一个** `deepseek-v4.1-flash-low-latency-1017` |
  | `qwen3.5-397b-a17b` / `qwen38-flash` | `qwen3.8-flash` |
  | `kimi-k31` | `kimi-k3.1-pro` |
  | `deepseek-v4-pro` | `deepseek-v4-pro-0813` |
  | `doubao-seed-2-0-pro` | `…-260215` |
  | `qwen3.5-35b-a3b` | `n2p5sdmw_qwen35-35b-a3b` |

  **`glm-5` 不是智谱模型**；两个带 `vl` 的也不是视觉模型（目录里 `modalities.input` 只有 `text`，自洽）。
  结论：**id 是 SKU 标签，不是厂商型号**。别按名字猜能力，也别替上游起名。

- `dm-auto-model/mm.L0` 这类是**自动路由别名**（mm=多模态、text=纯文本、L0/L1/L2 三档），
  一次请求落哪个模型由上游决定，不指向固定模型。建议默认不启用，且"启用"要单独记白名单
  （光把它从禁用名单里摘掉不等于用户主动启用了它）。

### 积分

```
GET api/dumate/points/package/list      # 余额 = active 包 Σ(totalPoints − usedPoints)
GET api/dumate/points/records/usage?startAt&endAt   # 两个参数都必填
GET api/dumate/points/records/charge
GET api/dumate/points/loginBonusInfo
POST api/dumate/points/loginBonus       # 全套接口里唯一的写操作
```

三条会咬人的形态：

1. **`totalPoints` / `usedPoints` 是字符串**（不是数字）。一律走"剥千分位与空格再 Number"的函数，
   **不要写 `Number(x) || 0`** —— 上游哪天加个千分位，余额就静默归零。
2. **`status` 认不出的值不能算进余额，但必须单独回传"有 N 个包的状态我看不懂"**。
   只回 0 会让用户以为积分没了，这是最坏的静默失效。
3. **过期判定不能只信 `status`**：实测上游会把已过期的包仍标 `active`。按 `expireDate` 再筛一遍，
   并把被剔除的分单独回传，才能解释"余额为什么比上游列表少"。

- `consumedPoints` 是**按区间聚合**，不按分页（`limit=1/5/20/100` 与第 2 页返回同一个值）。
- **个人版没有公开的逐模型积分倍率**：`global/model/list` 对个人账号返回空数组，
  前端那个 `ratio` 只属于企业/自定义模型。所以界面里不显示倍率，只显示余额与实际消耗。
  别去编一个。

### 限流（这条最容易被误解，实测过两次）

```
实验 A：同一模型连发 5 次、每次约 7k token、间隔 0.7 秒  → 全部 200
实验 B：等 25 秒后每次换一个模型、共 5 次                → 第 5 次（累计第 10 次）429，86ms 返回
```

- **窗口按请求条数算，约 10 次/分钟/账号**；与请求体量无关，**与选哪个模型无关**。
- 86ms 就拒 = 事前计数拦截，不是算力不足。
- 所以「429 时自动换别的搭子模型」**实测无效**——撞的那次正是跨 5 个模型时发生的。
  真要更多额度只有多个账号，或等上游放宽。
- 429 **经常不带 `retry-after`**；见过 `6.878`，也见过 `0`。
  所以退避时长得由插件自己定（本项目用 15s → 30s → 60s 封顶）。

### 本地代理（备胎通道）

`http://127.0.0.1:<随机端口>/api/qianfanproxy/v1`，无鉴权头，SSE 正常，增量含 `reasoning_content`。
端口与目录来自上面那个 `opencode.json` 的 `provider.QianfanPersonalQuota`（App 每次启动重写）。

**别指望把 `dumate-main-server.exe` 单独常驻** —— 它自检完就 `App exit(0)`（要 Electron 那侧的完整
登录/心跳上下文）。云端网关这条是怎么挖出来的：把它单独拉起来跑一次并开 `--log-stdout=1`，
日志直接写了 `To remote-llm: POST …/gateway/apis/v1/chat/completions`。只借它当探针，不借它当服务。

---

## 架构决定，以及为什么这么定

### 零依赖：不 import 任何 DSH 包

本地目录安装走的是 pnpm **link**，裸包名从工作区真实路径解析，**够不到 app.asar**。
一旦 `import '@deepseek-ai/dsh-llm'` 就报 `Cannot find package`。
所以适配器基类自带（鸭子类型，`registerAdapter` 只调方法、不做 `instanceof`）。

代价：宿主接口变了不会编译报错，只会运行时报错。值得。

### Host 半段与浏览器半段之间只走同源 HTTP

`ctx` 是 Cordis 代理，**不能挂自定义属性**（`cannot get property "dump" without inject`）。
两半段没有别的通道。所以浏览器侧读写状态只能通过 `webServer.register` 注册的路由。

这条决定了后面一堆事（同源校验、脱敏、403 要带诊断信息），见下面坑清单。

### 目录必须有三层兜底

宿主 `buildModelCatalog` 对每个 provider 单独 try/catch，并 `filter(group => models.length > 0)`：

> **`listModels()` 抛错或返回空 = 整组从选择器消失**；一行 `contextWindow` 不是正整数也能把整组拖没。

所以 `listModels` / `resolveModel` **一律不许抛**，目录走三层：实时网关 → 状态文件缓存 → 代码内兜底表。
否则冷启动第一帧返回空数组，用户就会看到"装了但模型不见了"。

### 注册顺序与命名空间

```
registerAdapter → registerConfigurableProviders(declared:false, settingsPath:[]) → registerModelDiscovery(settingsNs)
```

- `registerAdapter([])` 直接 `INVALID_ADAPTER`，路由集不能空。
- `declared` 必须 `false`（`true` 是给"用户在配置里手加的网关"用的）。
- **`settingsNs` 必须等于 Loader entry id**（`ctx.fiber.entry.options.id`）。写成别的名字，
  配置入口与模型发现**双双静默失效**，而且没有任何报错。

### 事件用哪个

- 目录内容变了 → `llm/models-updated`
- 路由拓扑变了 → `llm/adapters-updated`

选择器两个都听，设置页只听 `adapters-updated`。批量改动（比如"恢复推荐"）后
**必须无条件广播** `models-updated`：签名去重是给轮询用的，人主动点的改动若因"集合大小没变"
而不广播，选择器就停在旧的一套。

---

## 踩过的坑（按代价从高到低）

### 1. `ctx.effect` 的 arrow 形态会当场拆掉注册

```js
ctx.effect(() => registration());          // ✘ 挂载当场就释放
ctx.effect(() => { setup(); return () => teardown(); });  // ✘ 同样错
ctx.effect(function* () { yield () => teardown(); });     // ✔ 生成器形态
```

`effect(execute)` 是**立刻执行 execute 并把返回值当成 disposer**。所以 arrow 那种一挂载就
把注册拆了。症状极难查：模型组消失，但工具、命令、积分读数全都正常——因为它们走 `ctx.inject`，
不受影响。用宿主自带的 Electron 跑真 cordis 做过对照实验才定位到。

### 2. 读取路径写盘，把用户数据永久作废（最恶劣的一例）

解密密钥的取值函数在"读不到就生成新的并覆盖文件"，而它挂在每次快照都会走的读取路径上。
Windows 上杀软/OneDrive 造成一次瞬时 EBUSY 就够：那份加密凭据从此解不开，界面却只显示"没导入"。

> **规则：任何"取凭据/解密密钥"的函数如果被读取路径调用，就必须物理上不可能写盘。**
> 拆成 `readKey()`（只读，读不到返回 null）与 `keyForImport()`（只允许导入时调用），
> 比在注释里提醒可靠。

### 3. 用错判据的 fail-closed 把正常用户锁在门外

同源写接口原先判「Origin 字符串等于 `getOrigin()`」。但 `getOrigin()` 只返回**一个**地址，
而用户可能用 `localhost`、局域网 IP、隧道打开，桌面端甚至用自定义协议 `app://app` 加载
（`loadURL('app://app/')`），设置页还可能在 sandbox iframe 里（Origin 是字面量 `null`）。
浏览器对 **GET 不发 Origin、对 POST 必发 Origin** → 症状是"读一切正常、写全 403"。

> **规则：安全加固的判据必须与浏览器的同源模型同构** —— 用 **Origin 对请求 Host**，
> 不是对"我们以为的地址"。白名单必须包含宿主界面的真实加载形态。
> 并且 **403 要自带可反馈的诊断**（`got` / `servedHost` / `ownOrigin`），
> 只回一个错误码，用户只能截图猜，维护者只能靠猜。

### 4. 向宿主交出的字段，规格是宿主定的

```
LlmError providerRetryAfterMs must be a positive finite number
```

上游回 `retry-after: 0` 时交出 `providerRetryAfterMs: 0` → 宿主抛错 → **整轮崩成 UNKNOWN**。
429 本来只是"等一会儿"，被一个非法边界值变成整轮白烧。
另一条更隐蔽：`retry-after: 0.0001` 经 `Math.round(0.1)` 也变成 0。

> **规则：交不出合法值就省略字段**，别交一个"看起来合理"的非法值。
> 同理适用于 `requestId`、`contextWindow`（必须是正整数，否则整组被宿主隐藏）。

### 5. 组件里引用了外层作用域的名字（同类错误犯了两次）

```js
function Capsule({ t, ... }) { return h(Panel, { t }) }   // ✔
function AccountsTab({ t, state, busy, run }) {
  doImport() { setBusy(true) }   // ✘ setBusy 是别的组件的局部名
}
```

前者一点开就 ReferenceError，React 把整个座位拆掉 → "胶囊不点还在、点一下就整枚消失"。
后者在 async 函数里变成**未捕获 rejection**，既不崩页面也不报错，只表现为"按了没反应"。

> **规则：任何组件函数里引用的标识符必须在形参或模块作用域里。**
> `node --check` 查不出来，必须真的点一遍。

**为什么测试两次都没抓到**（这个反思比 bug 本身值钱）：

- 假 React 的 `useState` 只返回初值 → `open` 永远 false → 崩溃分支从没执行过。
  现在渲染器支持状态翻转、函数组件当场递归渲染、并把每个分栏的控件**全点一遍**。
  **只渲染不点，等于没测事件回调。**
- 点击循环用同步 `try/catch` 抓不到 promise reject；且结尾 `process.exit(0)` 在微任务清空前就退出。
  现在：handler 一律 `await`、注册 `unhandledRejection`、改用 `process.exitCode` 让事件循环自然跑完。

### 6. 配置值与实际生效值必须分开报

`authSource: auto` 时手动导入的 Cookie 只是备胎，真正在用的还是桌面版那份。
回执原先只说"已验证"，用户以为账号换了。现在同时给 `authSource`（配置值）与 `inUse`（实际值），
不一致时界面上显红字。

> 只报配置值等于制造错觉。

### 7. 展示用的映射对象不许再被当作数据源

`listProfiles()` 把账号档映射成精简展示对象时丢掉了 `encryptedCookies`，
而 `usable` 是用原始对象算的、取密文时却拿映射后的对象 → 非 active 档解不开，
报错误导成"你重装过 App 所以密钥变了"。**本机只有一个账号档时永远看不见这个 bug。**

### 8. 假绿灯比没测更坏

- 隐私扫描器把真实昵称/账号 id 写进了自己的正则字面量，还让它排除自己 → "自检 PASS"而真值就在包里。
  现在：违禁值**运行时推导**、**不跳过任何文件包括它自己**、命中只报文件与行号不打印原文。
- 断言写成 `assert.ok(x || true)` 恒真；`true === 1` 判不出；
  探针只断言"不崩"却没人问**它到底存进去了什么**（四个 `ok=true` 里有两个是"接受了不该接受的东西"）。
- 文档里写死的回归数量有 5 个不同答案 → 现在**禁止写死数字**，由结构守卫核对目录与脚本一致。

> **新增回归必须做反向验证**：把修法退回原样，测试要变红；还原后要重新变绿。
> 没跑过这一步的"新增一条回归"只是自我感觉良好。

### 9. 依赖真机状态的测试会在别人机器上失败

`disabled.test.mjs` 的对照组需要真实登录态，没装 App 的新用户机上必然 0 请求 → 断言判
"计数器没接上" → 而 README 写着"装完可以自己跑 `npm test` 验证包完整"，那是句做不到的承诺。
现在自带假登录态与假上游。

同类：**任何会写用户状态文件的测试，必须先隔离 `DSH_HOME` 到临时目录**。
曾经有测试直接在真机上跑，把用户"16 个模型被关"写进了他的状态文件。

### 10. 文案里的承诺必须与代码一致

429 文案原先写"稍等几十秒会自动重试"，而实际 11 秒就放弃、且取决于宿主装没装重试插件。
限流是账号级，用户当时正来回切模型想躲——文案里"换模型不解决问题"这句是后来专门加的。

---

## 还没做的（按"别人第一次装就会碰到"排序）

1. **账号池 / 自动换号** —— 限流按账号算，第二个账号就是第二个窗口。这是唯一能真正扩容的办法。
2. **逐模型 DSH 上下文预算** —— 上游宣称 1M 窗口，原样交给宿主会让长会话晚压缩、更容易撞限流。
3. **模型可用性探测**（真实体积请求）—— 上游 429 有时不带 `retry-after`，只能实测。
   注意这是**会花钱**的操作，必须显式按钮，不能做成自动行为。
4. **生图/生视频工具** —— 上游目录里本来就有图像模型；但这是本插件里唯一"由模型自己决定花钱"的能力，
   要做就必须默认关闭 + 不勾时根本不注册工具。
5. **PNG 多尺寸图标** —— 插件市场只收 GitHub 托管的位图（png/jpg/webp），SVG 会被拒。
6. **macOS / Linux 真机验证** —— 目前只有单元测试，没有真机。
7. CI —— 所有测试都沙箱化了 `DSH_HOME`，天生可跑；但需要先给依赖真实凭据的用例加显式 SKIP。

---

## 怎么跑测试与发布

```bash
npm test              # 全部回归，数量由 tests/structure.test.mjs 与目录自动核对
npm run publish:check # 隐私扫描 + tarball 清单核对
```

发布通道是 **GitHub tag**，不是 npm（npm 要求 2FA，且 bypass-2FA 的 token 在 2027-01 起不能直接发布）。

```bash
git tag -a v0.9.23 -m "v0.9.23" && git push --tags
# 别人安装：下载 tag 包 → 解压 → DSH 插件管理 Add plugin 选那个目录 → 重启 DSH
```

⚠️ **改完 Host 半段必须重启 DSH** 才会加载新的 JS 世代。诊断表里有
「插件版本」（内存里跑的）与「磁盘上的版本」两行，不一致就是没重启。

---

## 许可证

MIT。可以随便改、随便闭源二创。

如果改出了更好的版本，欢迎在仓库开个 issue 说一声——不是为了收回去，是想让还在用的人知道往哪走。
