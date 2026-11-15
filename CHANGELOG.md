# 更新记录

## 0.9.1

- **诊断表改为每次读取现算**。之前「选择器内启用数」这类由勾选决定的行是启动自检时算一次就冻住：点完「推荐」启用数已变成 11，诊断表仍显示 5。排障时陈旧数字比没有更坏。回归补在 	ests/defaults.test.mjs。

版本号按「能给别人装吗」来定，不按功能数量堆。

## 0.9.0 — 第二种登录方式

新增 **手动导入 Cookie**，不装（或装不了）桌面版也能用：

- **实测最小集只有两项**：`bce-sessionid` + `bce-user-info`。逐个剔除 34 个 Cookie 后确认其余全是冗余；`bce-long-term-sessionid` 顶替不了 `bce-sessionid`（校验里因此不放过）。
- 接受三种粘贴格式：`k=v; k2=v2` 请求头原文、JSON 数组（EditThisCookie/DevTools 导出）、`cookies.txt`。
- **导入即验证**：先拿它换一次真网关 token，成功才存 —— 存一份换不到东西的 Cookie 只会让人误以为登录好了。
- 三种登录方式可选：`自动`（有桌面版优先）/ `只用桌面版` / `只用手动`。
- 存储：AES-256-GCM 加密进 `~/.dsh/dumate-state.json`，随机密钥单独放 `~/.dsh/dumate-cookies.key`。明文只在内存里，**不写日志、不回传页面、不回填输入框**，一键清除。
- 设置页 → 账号 分栏顶部新增「登录方式」区块，含逐步取 Cookie 的指引（并明说 `bce-sessionid` 是 HttpOnly，`document.cookie` 读不到）。
- 修掉两个会让这条路静默失效的坑：`expirationDate: 0`（会话级、无到期）被当已过期丢光；`bce-user-info` 值本身带双引号被当包裹符剥掉。两个坑的报错都指向「登录态无效」，人根本想不到是解析层做的。
- 上游返回结构化错误时不再打印 `[object Object]`：认出 `{redirect:…}` 就是登录态问题，直接说该做什么。
- 新增 `tests/manual-login.test.mjs`（解析→校验→验证→存储→切换→清除，逐值比对明文不外泄）。回归 **12 个**。

## 0.8.0 — 发布就绪

面向「别人装、用自己的账号」做的收口，两条独立审计 + 三轮复扫之后：

- **跨平台找登录目录**：不再只算一条路径，改为列候选（Windows `APPDATA`/`LOCALAPPDATA`、macOS `~/Library/Application Support`、Linux `$XDG_CONFIG_HOME`/`~/.config`，每处试 `qianfan-desktop-app` / `DuMate` / `qianfan_desk_xdg` 三种目录名），**以 `auth.json` 存在为判据**。内层 `qianfan_desk_xdg` 也不再当常量用 —— 改成候选 + 目录扫描（那是 Windows 观测值，猜不中会静默拿不到 deviceId 与通道 B 配置）。
- **`DUMATE_USER_DATA` 严格生效**：显式指定就只认那一个目录，指错了直说，**不会悄悄退回用别的登录态跑**（之前会，那是最难查的坏法）。
- **`enabled: false` 现在是真的静默**：不注册路由、不轮询积分、三个工具回「已禁用」而不是含糊错误。之前只关了模型注册，后台照旧每 5 分钟打上游。
- **账号主键不外发**：同源接口去掉 `accountId` / `bceUserId`；诊断与界面里的家目录一律缩成 `~`（那一块是设计来贴进问题反馈的）。
- **详情页文案重写**（`locale/zh|en`）：之前写的还是 0.1 的「聊天走 App 本地代理」，与 0.2 起的云端网关矛盾；现在含前置条件、入口位置、数据边界、以及「不编倍率 / 不替上游起名」。
- 补 `LICENSE`（MIT）、`docs/PRIVACY.md`、`CHANGELOG.md`、`engines.dsh`、`scripts.test` / `scripts.check`。
- 去掉 `package.json` 的 `"private": true` —— 它会直接让 `npm publish` 失败。
- 修「24 小时消耗」永远显示 `—`：宿主写 `consumed24h`，客户端读 `consumed24`。
- UA 归属头的版本号改由宿主从 `package.json` 传入（之前硬编码 `0.2.0`，每次请求都把这串谎话发给百度）。
- 未装 / 未登录 / 文件损坏三种情况都给可操作文案 + 官方下载页。
- 新增 `tests/portable.test.mjs`、`tests/foreign-machine.test.mjs`、`tests/disabled.test.mjs`（共 11 个回归）。
- **隐私扫描器不跳过任何文件，违禁值全部运行时推导**（从 `os.userInfo()` 与本机登录态现取），命中项只报位置不报原文。上一版把真值写进扫描器的正则字面量里、还让它排除自己 —— 那是假绿灯。

## 0.7.0

- 设置页模型栏三个一键按钮：**推荐（按后端去重）** / 全选 / 全不选。实测五个 id 落同一个后端，全开就是五个重复行；推荐把 22 行收敛成 11 行、后端互不相同，且幂等。
- 模型栏顶上显示「选择器里 N / 22」，那个 N 取**宿主的答复**（`ctx.llm.listModels`），不是自证的勾选数 —— 两个数不一致就是过滤逻辑坏了，能当场看见。

## 0.6.x

- 429 用户级限流不再判死一整轮对话：失败码映射到 `dsh-llm` 官方表（`RATE_LIMIT`/`SERVER`/`TRANSPORT`/`TIMEOUT`/`QUOTA`/`AUTH`），并声明 `providerRetryPolicy`（最多 3 次、最长 20 秒）。`retry-after` 折算成 `providerRetryAfterMs`，上游 `gd_id` 填进 `requestId`。
- 胶囊可见性自检：浏览器把判定回报给宿主，`/dumate doctor` 多一行「浏览器胶囊判定」；读不到判定依据时退回显示（不装死）。

## 0.5.0

- 「设置 → 百度搭子」页：账号 / 积分 / 模型 / 能力 / 诊断 五个分栏。
- 逐账号读积分（只在点按钮时发请求）、换账号档、显示名覆盖、运行期热改通道与刷新间隔（写状态文件，优先级高于 patch 默认，不用重启）。

## 0.4.0

- 积分胶囊只在会话选中百度搭子时出现；不可见时不起定时器、不发请求。

## 0.3.0

- 修「模型选择器里看不到百度搭子」：`ctx.effect` 用法（arrow 形状会在挂载当场释放注册）+ 目录三层兜底（实时 → 缓存 → 静态），冷启动首帧 1161ms → 1ms。

## 0.2.0

- 默认改走**云端模型网关**，搭子 App 不用开着；本地代理降为备胎通道。

## 0.1.0

- 首版：模型进选择器、积分只读、`/dumate` 命令与三个工具。
