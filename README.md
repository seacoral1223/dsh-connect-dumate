# dsh-connect-dumate

把本机登录的 **百度搭子（DuMate）** 接进 DeepSeek Harness：模型出现在 DSH 的模型选择器里，积分作为只读读数挂在输入框工具行上。

**默认走云端模型网关 —— 搭子 App 不用开着。** 这是它和 `dsh-connect-workbuddy` 最大的结构差异：WorkBuddy 插件要用 App 的登录 token 直连云端，这里也是；而 App 自己那套本地代理只是备胎通道。

## 两种登录方式

插件不注册账号、不代你登录 —— 它复用这台机器上**已有**的百度登录态。有两条路：

### 方式一：桌面版 App（默认，什么都不用填）

装好百度搭子桌面版并登录一次，插件直接读它的登录数据（只读，绝不写 App 的任何文件）。多个账号档可以在设置页里选。

### 方式二：手动导入 Cookie（不想装桌面版，或机器上装不了）

只需要两个 Cookie —— 这是逐个剔除实测出来的最小集，其余 30 个全是冗余：

| Cookie | 是否 HttpOnly | 作用 |
| --- | --- | --- |
| `bce-sessionid` | **是**（`document.cookie` 读不到） | 会话凭据 |
| `bce-user-info` | 否 | 同时当 `csrftoken` 用 |

取法：**①** 浏览器登录 `https://console.bce.baidu.com`（用搭子同一个百度账号）→ **②** F12 → Application → Cookies → 选 `https://console.bce.baidu.com` → **③** 复制上面两行的 Value → **④** 粘进 设置 → 百度搭子 → 账号 的框里，形如 `bce-sessionid=…; bce-user-info=…`。也接受 JSON 数组（EditThisCookie 之类导出）和 `cookies.txt`。

导入时插件会**先拿它换一次真 token，成功才存**——存一份换不到东西的 Cookie 只会让人误以为登录好了。之后可以选择只用手动（`只用手动导入 Cookie`），或让插件自动（有桌面版就用桌面版，拿不到再退回手动）。

存储方式：Cookie 用随机密钥做 AES-256-GCM 加密后写进 `~/.dsh/dumate-state.json`，密钥单独放 `~/.dsh/dumate-cookies.key`。**明文只在内存里短暂存在**——不写日志、不回传页面、不回填输入框（这三条都有回归盯着）。这和桌面版自己的保护水平一样：挡住备份/截图/贴日志这类意外，挡不住已经能读你用户目录里那两个文件的程序。不想留就点「清除手动 Cookie」。

有效期：这是**会话级凭据**，百度那边登出、过期或换设备都会失效。失效时报错会直接说「登录态不被接受，请重新复制这两项」，不会只丢一个 HTTP 码。

## 你需要什么

1. **DeepSeek Harness**（桌面版即可）。
2. **百度搭子桌面版**，装好并**登录过一次**。插件不注册账号、不代你登录、不接受手动填 token —— 它读的就是这台机器上那个登录态，所以**你用自己的账号，我用我的账号**，互不影响。
3. 支持的系统：Windows / macOS / Linux。插件按候选目录去找 App 的用户数据（`%APPDATA%`、`%LOCALAPPDATA%`、`~/Library/Application Support`、`$XDG_CONFIG_HOME`/`~/.config`，每处试 `qianfan-desktop-app` / `DuMate` / `qianfan_desk_xdg` 三种名字），**判据是里面的 `auth.json` 在不在**。找不到就在诊断里列出找过哪些路径；非标准安装可以用环境变量 `DUMATE_USER_DATA` 直接指到那个目录。

## 装上

这个插件目前**只通过 GitHub 发布**（不走 npm），装法两种：

**A. 下载打包好的源码（最简单，3 步）**

```powershell
# 1) 下载并解压
curl -L -o dumate.tgz https://codeload.github.com/seacoral1223/dsh-connect-dumate/tar.gz/refs/tags/v0.9.6
tar -xzf dumate.tgz          # Windows 10+ 自带 tar；其它解压工具也行
# 解压出来是目录 dsh-connect-dumate-0.9.3
```

2) 打开 DSH 的插件管理（**Plugins → Add plugin**），选那个解压出来的目录。
3) **重启 DSH**。

**B. git clone**

```bash
git clone --branch v0.9.6 https://github.com/seacoral1223/dsh-connect-dumate.git
```

然后同样在 **Plugins → Add plugin** 里选这个目录，重启。

> 装完可以自己在目录里跑 `npm test`（12 个回归，不联网、不碰你的账号数据）验证包是完整的。

装好之后你应该看到：

- 模型选择器里出现 **百度搭子 DuMate** 一组；
- 会话选中其中任意模型时，输入框工具行上出现积分胶囊（**其它模型下不出现**，这是设计）；
- **设置 → 百度搭子** 有账号 / 积分 / 模型 / 能力 / 诊断五个分栏；
- 对话里打 `/dumate doctor` 看自检，或问「我的搭子积分还剩多少」（工具 `dumate_credits`）。

没登录过搭子会怎样：模型那一组仍然出现（靠内置兜底目录），但对话会明确告诉你「这台机器还没登录过百度搭子：`<目录>` 里没有 auth.json」并给下载页。读积分、换 token 失败时也是同一句人话，不会只丢一个 HTTP 码。

## 支持的系统（说清楚到哪一步）

- **Windows：已实机验证**（本文所有实测数据都来自 Windows）。
- **macOS / Linux：按 Electron 惯例做了目录探测，未在实机上验证。** 找登录目录时不猜死一个名字：Windows 试 `%APPDATA%`/`%LOCALAPPDATA%`，macOS 试 `~/Library/Application Support`，Linux 试 `$XDG_CONFIG_HOME`/`~/.config`，每处试 `qianfan-desktop-app` / `DuMate` / `qianfan_desk_xdg` 三个名字，**判据是里面的 `auth.json` 在不在**。装完在诊断页能看到「找过的 App 目录」和「命中的 App 目录」两行。
- 目录结构非标准（App Store 沙盒、flatpak、snap、便携版）时，用环境变量 **`DUMATE_USER_DATA`** 直接指向那个目录（指到目录本身）。它严格生效：指错了就报「这个目录里没有 auth.json」，**不会悄悄退回用别的登录态跑**。
- 百度搭子是否有 Linux 桌面版本身未核实，所以 Linux 上更可能是「App 装不了」而不是「插件找不到目录」。

## 卸载 / 停用之前先看这两条

1. **先把默认模型从 `dumate/*` 上切走**。如果你把 DSH 的默认模型设成了搭子的某个模型（`agent-default-model` 的 config 里 `provider: dumate`），插件一移除，那行配置指向的 provider 就没了 —— 这类幽灵条目会让**每次启动都加载失败**。
2. 插件唯一写的文件是 `~/.dsh/dumate-state.json`（DSH 数据目录内）。卸载不会清掉它，里面有你的模型勾选和 `activeProfileId`（账号档标识）；想彻底清空就手工删掉。
3. `config.enabled: false` 现在是**真的全关**：不注册模型路由、不轮询积分、不发任何上游请求，工具和命令只会回「已禁用」。

## 数据边界

一句话：Cookie 密文与密钥只在本机内存里用，明文不落盘、不打印；请求只发往百度自己的域名，没有第三方、没有遥测；唯一的写操作是领每日签到，默认关闭。

完整清单在包内 **[docs/PRIVACY.md](docs/PRIVACY.md)** —— 读你登录态的插件应该有一份能独立读的隐私说明，而不是让你翻源码。

## 通道 A（默认）：云端模型网关，App 可以关着

```text
本机登录 Cookie（auth.json 密文 + .cookie-key 解密）
  -> GET https://console.bce.baidu.com/api/dumate/app/token/get     换 36 位短期 token（寿命由上游 expired_at 决定，实测同一 token 会反复原样返回）
  -> GET https://dumate-svc.baidu.com/gateway/apis/v1/models         43 个模型的目录
  -> POST https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions   Authorization: Bearer <token>
```

三条都是实测：目录字段与 App 写进 `opencode.json` 的那份逐字一致（`limit` / `modalities` / `thinking`）；对话支持 SSE；`stream_options.include_usage` 才回 usage，所以插件每次都带上；坏 token 回 `401 + error_code 336100`，据此作废缓存重取一次。响应头 `x-dumate-gw-realmodel-displayname` 会告诉这次真正路由到哪个模型（比如 `glm-5` 实为 DeepSeek-V4.1 Flash），插件把它记下来当显示名，**只在上游给过名字时才用**。

## 通道 B（备胎）：App 自带的本地代理

```text
POST http://127.0.0.1:<随机端口>/api/qianfanproxy/v1/chat/completions   无需鉴权头
```

端口与目录来自 App 每次启动重写的 `qianfan_desk_xdg/<userId>/config/opencode/opencode.json`。`mode: local` 可强制只走这条；默认 `auto` = 先试云端，拿不到 token 才退回本地。

## 积分（与通道无关，恒走云端只读接口）

| 能力 | 接口 |
| --- | --- |
| 余额 / 积分包 | `GET …/api/dumate/points/package/list`，余额 = active 包 Σ(totalPoints − usedPoints) |
| 24 小时 / 7 天消耗 | `GET …/api/dumate/points/records/usage?startAt&endAt`（**两个参数必填**），带 `consumedPoints` |
| 发放与充值流水 | `GET …/api/dumate/points/records/charge?startAt&endAt` |
| 今日签到状态 | `GET …/api/dumate/points/loginBonusInfo`（`signInDays` / `hasIssued`） |
| 领取今日签到（500 分/天） | `POST …/api/dumate/points/loginBonus` —— **唯一写接口，只能手点或显式调工具** |
| 账号身份与多账号档 | `GET …/api/dumate/user/info` + `auth.json.accountProfiles` |

登录态直接复用本机搭子：读 `%APPDATA%\qianfan-desktop-app\auth.json` 的 Cookie 密文，用同目录 `.cookie-key`（32 字节）做 AES-256-GCM（`base64(iv12‖tag16‖ct)`）解密。App 的两个文件**全程只读**，Cookie 与 token 只活在插件进程内存里，不落盘、不进日志、不出浏览器。

## 它不做什么

- **不编造积分倍率。** 个人版上游没有公开的逐模型倍率：`global/model/list` 对个人账号返回空，前端那个「模型价格系数」只属于企业/自定义模型。所以读数只报余额与真实消耗，不报 `x0.79`。
- 不做账号池自动换号、不做生图/生视频、不后台自动签到。
- 不写 DSH 默认模型，不碰 profile 的 `package.json` / `cordis.patch.yml`（安装走 plugin manager）。

## 装完要做的事

```pwsh
# 代码换版必须重启 DSH 才会加载新的 JS 世代
```

配置在 profile 的 `cordis.patch.yml` 里那一行：

```yaml
- id: dsh-connect-dumate
  name: dsh-connect-dumate
  config:
    enabled: true
    mode: auto          # auto | gateway | local
    pollIntervalMs: 300000   # 60000 / 300000 / 600000 / 1800000 / 3600000
```

## 积分胶囊只在选中百度搭子时出现

判据是会话当前选中的 provider，来自宿主自己的 `modelSelection` 投影：

```js
const provider = (projection?.next ?? projection?.lastUsed)?.provider;   // next 优先：刚提交还没落地也算
visible = provider === "dumate";
```

不是本插件的路由就 `return null`，**而且不起定时器、一次请求都不发**（hooks 全部先跑完才做条件返回，顺序稳定）。宿主配置里改了 `providerId` 的部署也能认出来：不可见时做一次一次性探测拿回 `providerId`，总共一个请求，不起轮询。

> 注意分层：**Host 侧的积分轮询照旧每 `pollIntervalMs` 跑一次**（与选没选无关，这样切过来的第一帧就是新数字）；被省掉的是浏览器里的读取与渲染。

### 「胶囊不见了」怎么区分两种原因

按上面的规则，**会话没选百度搭子时它就是不该出现** —— 这是设计，不是坏掉。区分只看一处：设置左侧有没有「百度搭子」这一条。

- 有 → 客户端模块正常加载，那就是当前会话选的模型不是搭子。把模型切成 DuMate 任意一个，胶囊立刻回来（不用重启）。
- 没有 → 客户端半段压根没跑起来（模块加载失败），这时才需要查 JS 报错。

两个兜底已经加上：

1. **安全阀**：座位没把 `useProjection` 注进来（宿主换了 props 形状）时，判定无从做起，此时**退回一直显示** —— 静默消失是最难查的坏法，宁可多显示也别装死。
2. **浏览器把自己的判定回报给宿主**：每次读 `/api/dumate/state` 都带上 `view=canTell=…;selected=…;visible=…`，宿主记下来。`/dumate doctor` 里新增一行「浏览器胶囊判定」，下次再问"为什么没出现"就有实测答案，不用猜。

回归：`tests/client-structure.test.mjs` 里钉了四种情形 —— 别的 provider 不渲染、选中 dumate 渲染、只有 `lastUsed` 渲染、**拿不到 `useProjection` 必须渲染**、投影未就绪不渲染。这个用例还当场抓到一个真 bug（`viewRef` 声明在使用之后 → TDZ ReferenceError → 整个座位崩掉）。

回归：`node tests/pill-visibility.test.mjs` 把 `client.js` 里 GATE 标记块**原样抠出来**跑 10 个用例（next/lastUsed 优先级、空投影、空串 provider、非本插件路由等），测的就是浏览器实际跑的那段代码，不是副本。

## 设置页：设置 → 百度搭子

左侧导航里与「模型 / 费用 / 内置插件」并列的一页，五个分栏。照 `dsh-connect-workbuddy` 的分栏思路做，但**只放搭子真有的能力**：

| 分栏 | 内容 | 写操作 |
| --- | --- | --- |
| 账号 | 本机登录过的账号档；每档可选「由本插件使用」；点「读所有账号积分」才逐个查余额与签到 | 换档（只改插件用谁的凭据） |
| 积分 | 余额、24h/7d 消耗、积分包与到期、今日签到 + 领取按钮、近 7 天消耗明细 | 领取签到（唯一花钱的按钮） |
| 模型 | 逐个启用/禁用、图片输入开关、显示名覆盖；显示上游实际路由到的模型 | 写插件自己的状态文件 |
| 能力 | 通道（auto / gateway / local）、积分刷新间隔、每天自动签到（默认关） | 全部即时生效，不用重启 |
| 诊断 | 只读事实表 + 可复制的 JSON（含宿主答复的 `hostView`） | 无 —— 这一栏故意不放任何会改设置的控件 |

分栏里的旋钮落在 `~/.dsh/dumate-state.json`，**优先级高于 `cordis.patch.yml` 里的同名字段**（后者只当出厂默认）。这样换通道、改刷新间隔、换账号档都不用重启 DSH —— 上一版每次改都得重启，而重启会连带把别的插件的 JS 世代一起换掉，代价太大。

逐账号积分**只在人点按钮时才发请求**：每档要一次余额 + 一次签到状态，让它在后台按刷新间隔自动跑，等于替用户多烧 N 倍请求量。

## 选择器里的数量 = 设置里勾选的数量（这是同一件事）

不是两份名单：设置页勾选 → 写 `disabledModels` → `listModels()` 过滤 → 宿主 `llm/models-updated` 重拉 → 选择器变。设置页模型栏顶上那行直接当面比：

```
选择器里 11 / 22 · live
```

`选择器里` 那个数**取自宿主的答复**（`ctx.llm.listModels('dumate')`），不是拿自己的 enabled 数自证 —— 两个数一旦不一致，就是过滤逻辑真坏了，这样能当场看见。

### 三个一键按钮

| 按钮 | 做什么 |
| --- | --- |
| **推荐（按后端去重）** | 每个互不相同的后端只留一行；同组留上下文窗口最大的，并列按 key 排（确定性）。自动路由档位一律关 |
| 全选 / 全不选 | 整组开关，含路由档位 |

「推荐」这条为什么值得存在：实测 `glm-5`、`ernie-4.5-turbo-vl-32k`、`qwen2.5-vl-32b-instruct`、`deepseek-v4-flash-0731`、`deepseek-v41-flash` **五个 id 落的是同一个模型**。全开着，选择器里就是五个名字不同、行为一样的行 —— 看着"模型很多"其实是重复。推荐后从 22 行收敛到 **11 行，后端互不相同**：

```
deepseek-v4-pro   deepseek-v41-flash   doubao-seed-2-0-pro   glm-53   glm-53-flash
kimi-k3   kimi-k31   qwen3.5-27b   qwen3.5-35b-a3b   qwen3.8-max   qwen38-flash
```

幂等（再点一次结果一样），且每次都会广播 `llm/models-updated`（批量改动不能靠签名去重，否则选择器会停在旧的一套上）。

## 显示名怎么拼

规则（项目约定）：**主名 = 上游说过的真实模型名，括号里 = 中转站返回的 id**。

```
DeepSeek-V4.1 Flash (glm-5)
DeepSeek-V4 Pro (deepseek-v4-pro)
Kimi-K3.1 Pro (kimi-k31)
GLM-5.3 Flash (glm-53-flash)
Qwen-3.8 Flash (qwen38-flash)
Qwen-3.8 Flash (qwen3.5-397b-a17b)
DeepSeek-V4.1 Flash (deepseek-v4-flash-0731)   ← 这一行上游没给名字，但同一个后端在别的行被叫过，借来用
kimi-k3                                        ← 上游从没给过名字 → 只显示 id，不硬造
qwen3.5-27b                                    ← 同上
```

三条边界：

1. **只用上游亲口说过的名字**（响应头 `x-dumate-gw-realmodel-displayname`）。上游没说过就显示 id 原文 —— 不把 `n2p5sdmw_qwen35-35b-a3b`、`doubao-seed-2-0-pro-260215` 这种内部后端串包装成「模型名」，那是另一种编造；完整后端 id 放在设置页「后端:」那一行。
2. **括号不能省**：`glm-5`、`ernie-4.5-turbo-vl-32k`、`qwen2.5-vl-32b-instruct`、`deepseek-v4-flash-0731`、`deepseek-v41-flash` 五个 id 落到同一个后端，只留真实名就是五行同名，选哪个都分不清。
3. `dm-auto-model/*` 是自动路由档位，不记名字、默认不启用；启用后显示的就是那个别名本身。

名字是**学到才有**：这台机器没真发过一次请求之前，那一行显示 id 原文。已用探测脚本把 22 个 id 各打一次（约 2.4 积分），16 条真实路由写进了状态文件并标了探测时间；要刷新就在设置页点「重新读目录」或再跑一次探测脚本 —— 插件自己不会替你花钱。

## 这些 id 实际落到哪个模型（2026-11-15 逐个实测）

每个 id 发一次 `max_tokens=1` 的最小请求，读响应头 `x-dumate-gw-realmodel`；对可疑的再连打三次，**结果每次都一样**，所以路由是按 id 固定的，不随负载漂。这轮探测实花约 **2.4 积分**（47 条记录，39 条 <0.05）。

> 顺带确认：`points/records/usage` 的 `consumedPoints` 是**按区间**聚合、不按分页（`limit=1/5/20/100` 与第 2 页都返回同一个值），所以设置页那个「24 小时消耗」可以直接信。

| SKU id（上游目录） | 实际落地模型 | 上游给的名字 |
| --- | --- | --- |
| `deepseek-v4-flash-0731` | `deepseek-v4.1-flash-low-latency-1017` | — |
| `deepseek-v41-flash` | `deepseek-v4.1-flash-low-latency-1017` | DeepSeek-V4.1 Flash |
| `deepseek-v4-pro` | `deepseek-v4-pro-0813` | DeepSeek-V4 Pro |
| **`glm-5`** | `deepseek-v4.1-flash-low-latency-1017` | DeepSeek-V4.1 Flash |
| **`ernie-4.5-turbo-vl-32k`** | `deepseek-v4.1-flash-low-latency-1017` | DeepSeek-V4.1 Flash |
| **`qwen2.5-vl-32b-instruct`** | `deepseek-v4.1-flash-low-latency-1017` | DeepSeek-V4.1 Flash |
| `glm-53` | `glm-5.3` | GLM-5.3 |
| `glm-53-flash` | `glm-5.3-flash` | GLM-5.3 Flash |
| `kimi-k3` | `kimi-k3` | — |
| `kimi-k31` | `kimi-k3.1-pro` | Kimi-K3.1 Pro |
| `doubao-seed-2-0-pro` | `doubao-seed-2-0-pro-260215` | — |
| `qwen3.5-27b` | `qwen3.5-27b` | — |
| `qwen3.5-35b-a3b` | `n2p5sdmw_qwen35-35b-a3b` | — |
| **`qwen3.5-397b-a17b`** | `qwen3.8-flash` | — |
| `qwen3.8-max` | `qwen3.8-max` | — |
| `qwen38-flash` | `qwen3.8-flash` | Qwen-3.8 Flash |
| `dm-auto-model/mm.L0/L1/L2` | `deepseek-v4.1-flash-low-latency-1017` | DeepSeek-V4.1 Flash |
| `dm-auto-model/text.L0` | `deepseek-v4.1-flash-low-latency-1017` | DeepSeek-V4.1 Flash |
| `dm-auto-model/text.L1` | `kimi-k3` | — |
| `dm-auto-model/text.L2` | `qwen3.8-max` | — |

三个要点：

1. **名字没写错，是 SKU 标签**：`qwen38-flash` = `qwen.3.8` 的压缩写法，`deepseek-v41-flash` = `v4.1`。上游目录里根本没有 name 字段，所以这些 id 就是全部对外信息。
2. **五个不同的 id 落到同一个后端**（`glm-5`、`ernie-4.5-turbo-vl-32k`、`qwen2.5-vl-32b-instruct`、`deepseek-v4-flash-0731`、`deepseek-v41-flash` 全是 `deepseek-v4.1-flash-low-latency-1017`）。尤其注意 `glm-5` **不是智谱的模型**，两个带 `vl` 的 id 也不是视觉模型（目录里它们的 `modalities.input` 就只有 `text`，对得上）。
3. `qwen3.5-397b-a17b` 名字像个 397B MoE，实际落的是 `qwen3.8-flash`。

所以显示名规则见上面「显示名怎么拼」一节：**主名 = 上游说过的真实模型名，括号里 = 中转站返回的 id**（括号不能省，否则上面那五行会变成一模一样的「DeepSeek-V4.1 Flash」）。上游没给过名字就只显示 id 原文，绝不把内部后端串包装成模型名。自动路由档位（`dm-auto-model/*`）不记名字、默认不启用 —— 那一行本来就是「让上游挑」。

## 目录的三层兜底（为什么不能让它空）

宿主的 `dsh-api-session-controller/src/catalog.ts` 在 `buildModelCatalog` 里对每个 provider 单独 try/catch，并且 `filter(group => group.models.length > 0)` —— **抛错或空数组是整组从选择器消失**，不是只少一行；一行解析不出上下文窗口的坏数据也能把整组拖没。所以目录有三层：

| 层 | 来源 | 什么时候用 |
| --- | --- | --- |
| 1 | 网关 `/gateway/apis/v1/models`（43 个） | 正常在线 |
| 2 | `~/.dsh/dumate-state.json` 的 `lastCatalog` | 冷启动首帧、通道还在飞 |
| 3 | 代码里的静态兜底（`src/upstream.cjs` `FALLBACK_MODELS` 22 个；适配器内再留 5 个最保守行） | 全新机器 / 断网 / inspect 直接抛 |

`listModels()` / `resolveModel()` 都不抛：目录里没有的模型按 200K 上下文保守报出来，真发请求时由上游给准确错误。回归 `node tests/fresh-machine.test.mjs` 就是拿「没装 App + 网络不通 + inspect 强制抛」这一最坏情况断言这一组仍有模型可列。

## 限流与故障怎么处理

搭子网关会回 `429 {"error":{"code":"user_rate_limit_exceeded",…}}`（用户级窗口，不是账号被封）。v0.5 撞过一次：**一整轮对话直接失败**，原因是适配器把失败码写成了 `RATE_LIMITED` / `UPSTREAM_ERROR` —— 这两个名字不在 `dsh-llm/src/error.ts` 的 `LLM_FAILURE_CODES` 表里，而 `dsh-llm-retry` 插件正是按 code 决定要不要退避重试，认不出来就等于不重试。

现在的映射（`tests/failure-codes.test.mjs` 逐个钉住）：

| 上游 | 规范码 | 会不会重试 |
| --- | --- | --- |
| 429 | `RATE_LIMIT` | ✅ 退避重试，并读 `retry-after` 换算成 `providerRetryAfterMs` |
| 5xx | `SERVER` | ✅ |
| 连不上 / 超时 | `TRANSPORT` / `TIMEOUT` | ✅ |
| 402 积分不足 | `QUOTA` | ❌ 重试只是白烧一次请求 |
| 401/403 登录态被拒 | `AUTH` | ❌ 同上，且会提示去 App 里重新登录 |
| 流断在半截 | `STREAM_CLOSED` | ❌ 字节已经吐出去了，重放会让用户看到两段拼接的回答 |

策略本身保守：`maxRetries=3`、初始 1.5 秒、最长 20 秒、抖动 0.2 —— 猛重试只会把限流窗口拖得更长，而且每次重试都在替你烧积分。失败信息里带上游给的 `gd_id` 当请求号，方便对账。

**撞到限流时你能做的**：等几十秒（实测这个窗口很短，刚才顺序 3 次 + 并发 6 次全 200）；或者这一轮先换别家的模型；反复触发就是账号配额到顶，去设置页看余额与近 24h 消耗。

## 已知边界

1. **冷启动必须先有目录可列**：DSH 的选择器「空分组直接隐藏」（`dsh-client-ui-model-selection` README 原文：*Empty groups are hidden*）。所以插件把上一次成功的模型目录写进 `~/.dsh/dumate-state.json` 的 `lastCatalog`，`listModels()` 在网络刷新还在飞的时候先用它顶上；实测两种情况都在 0.8 秒内交出 22 个模型（`tests/coldstart.test.mjs`，用假 ctx 直接问适配器）。
2. **改了代码必须重启 DSH** 才会加载新的 JS 世代；GUI 页面本身在选择器上会跟着 `llm/adapters-updated` / `llm/models-updated` 重拉，不用刷新页面。
3. **模式没热切换**：改 `mode` / `pollIntervalMs` 要重启 DSH。运行期热改只覆盖模型勾选、图片开关与显示名（那些落 `~/.dsh/dumate-state.json`）。
4. 网关 token 的寿命由上游 `expired_at` 给（实测同一 token 会原样重复返回，本次剩 ~8 小时）；插件在到期前 3 分钟换新，401 时作废重取，再失败就报「请在搭子 App 里重新登录」，不静默。
5. 只支持个人版（BCE 登录）。企业版走 `dumate-enterprise` 那套网关，未接。
6. 模型的多模态标记取自上游 `modalities.input`，未经逐模型实测；图片输入可在面板里逐模型关。
7. 同源接口 `/api/dumate/state`（只读）与 `/api/dumate/action`（写入）带 Origin 校验：浏览器跨源请求被 403；不带 Origin 的本机进程能读——这类进程本来也读得到搭子自己的文件。

## 「选不中」怎么自查

`/api/dumate/state` 里多了一段 `hostView`，是插件**去问宿主**的结果，不是自己的推测：

```jsonc
"hostView": {
  "providerCount": 12,          // 宿主认到的供应商总数
  "dumateListed": true,         // dumate 在不在表里
  "dumateName": "百度搭子 DuMate",
  "models": ["glm-5", ...]      // 宿主按 catalog 现在能列出的 id
}
```

`/dumate doctor` 也会把这段打出来。如果 `dumateListed` 是 `false`，问题在注册；是 `true` 而 `models` 为空，问题在目录；两者都正常而页面上看不见，就是页面还挂着旧的目录快照。

## 为什么 v0.1 时选择器里根本没有「百度搭子」

不是通道问题，是注册被自己拆掉了。cordis 的 `ctx.effect(execute)` 会**立刻执行 execute**，再把它**返回的函数**当作卸载时的 disposer。v0.1 写的是：

```js
const registration = ctx.llm.registerAdapter([providerId], adapter);
ctx.effect(() => registration());     // ← 这个 arrow 一挂载就把 registration 调了
```

于是模型路由在挂载那一刻就被释放；而工具、命令、HTTP 面走的是别的注册路径，照常活着 —— 表现就是「积分能读、工具在列、模型选不到」。现在全仓统一成官方形状：

```js
ctx.effect(function* () {
  const registration = ctx.llm.registerAdapter([providerId], adapter);
  yield () => registration();          // 卸载时才跑
});
```

对照实验（真 cordis）：arrow 那种挂载当场就 `bReleased=true`；生成器那种挂载 `cReleased=false`、显式 dispose 后才 `true`。生命周期回归：`node tests/lifecycle.test.mjs`（假 ctx 走同一套语义，断言挂载后 `providers=[dumate]` + 两条路由在位 + 发过 `llm/models-updated`，卸载后全部释放），输出 PASS。

## 验证状态（2026-11-15，本机 Windows）

已实测：云端网关目录 43 个 + `glm-5` 非流式 200 + 流式 SSE + `include_usage` 生效；`mode=gateway/auto/local` 三条自检都 `ok=true`；积分余额、四个积分包、7 天消耗、今日签到状态都读通（这些是账号专属数字，不写进公开文档）；勾选开关与 `action=bogus` 的报错路径；适配器离线 SSE 桩（消息映射 / StreamChunk 顺序 / usage 折算）；生命周期 harness 与冷启动 harness（第一帧就交出 22 个模型）。

需要在 GUI 里确认：**重启 DSH 后**模型选择器出现「百度搭子 DuMate」分组并可选中、输入框胶囊渲染、真跑一轮对话。**把搭子 App 完全退出后再跑一次**才算证明「不开就能用」这条。
