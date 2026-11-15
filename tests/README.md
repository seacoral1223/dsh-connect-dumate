# 回归测试

**十三个**，都不需要 DSH 进程：假 ctx 按 cordis 语义跑 effect、假 SSE 服务、假 HTTP 状态码、假 React（能翻状态、递归渲染子组件、把控件全点一遍）。`coldstart` 与 `lifecycle` 会真连一次网关读目录，离线时退到兜底并通过。

一条命令跑全部：**`npm test`**。`npm run check` = 语法检查 + 全部；`npm run publish:check` 再叠加元数据 / GitHub 仓库存在性 / 版本重复 / 隐私 / 发布完整性。`prepublishOnly` 挂的是 `npm run check` —— **回归不过就发不出去**，这是刻意的。

> **所有会写状态文件的用例都先在 `mkdtemp` 沙箱里隔离 `DSH_HOME`。** 曾经有用例直接写真机 `~/.dsh/dumate-state.json`，把 Coral 的勾选改掉了 —— 那种测试报错的是用户的设置，不是断言。

| 脚本 | 钉住的约束 |
| --- | --- |
| `adapter-offline.test.mjs` | 假 OpenAI SSE 服务：DSH 消息 → wire 映射（system / developer / user+file / assistant+tool_calls / tool 结果 / 图片另起 user / 不支持图片时不塞 `image_url`）；SSE → StreamChunk 顺序且 `finish` 必须最后；`stream_options.include_usage` 与 usage 折算（缓存命中从 `prompt_tokens` 减出）；目录里没有的模型**不抛**且给正整数窗口 |
| `failure-codes.test.mjs` | 失败码必须落在 `dsh-llm/error.ts` 的官方表内：429→`RATE_LIMIT`、402→`QUOTA`、401/403→`AUTH`、5xx→`SERVER`、400→`INVALID_REQUEST`、连不上→`TRANSPORT`、超时→`TIMEOUT`；`retry-after` 折算 `providerRetryAfterMs`、`gd_id` 填 `requestId`；`providerRetryPolicy` 只把可恢复码放进重试名单，`AUTH`/`QUOTA`/半截流 `STREAM_CLOSED` 不重试。**起因是搭子回 429 把一整轮对话打死且零重试** |
| `lifecycle.test.mjs` | 挂载后 `providers=[dumate]` + 两条同源路由 + 命令 + 三个工具都在，`llm/models-updated` 已发出，跨源 POST 403，`action=bogus` 报错路径正确；跑完 disposer 后 providers/routes 全释放。**专门钉 v0.1「挂载即释放」那个 bug** |
| `coldstart.test.mjs` | 第一次网络刷新还在飞的时候问 `listModels()`：必须当场交出非空目录（走缓存 ~1ms；缓存清空后 ≤3s） |
| `fresh-machine.test.mjs` | 没装 App + 状态文件不存在 + `inspect()` 强制抛 → 仍有模型可列、`resolveModel` 不抛。因为宿主 `buildModelCatalog` 会把零模型或抛错的 provider **整组隐藏** |
| `foreign-machine.test.mjs` | 五种残缺环境（目录不存在 / `auth.json` 非法 / 无账号档 / `.cookie-key` 长度错 / 密文解不开）+ 完全没装搭子：都不崩、都有目录、**错误文案必须是能照着做下一步的人话** |
| `client-structure.test.mjs` | 假 React 起 `client.js`：三个座位都注册、`settings.section.icon` 的 id 与分栏 id 一致（不一致宿主不画图标）、五个分栏在空数据与真实形状数据下各渲染一遍、**把每个分栏的按钮/勾选全点一遍**（46 个控件）、登录 UI 不许回填 Cookie 值、disposer 可跑。另含 **i18n 完整性**：COPY 之外不许有中文字面量、zh/en 键集相等、引用键都有译文、不留死键 |
| `pill-visibility.test.mjs` | 把 `client.js` 里 `GATE-START/END` 标记块**原样抠出来**跑 10 个用例：`next` 优先于 `lastUsed`、别的 provider 一律不出现、空投影 / 空串 / 非字符串都不出现。测的是浏览器实际跑的那段代码，不是副本 |
| `defaults.test.mjs` | 「推荐（按后端去重）」：**素材自己造 + 把 fetch 桩成失败**（不依赖任何机器状态），五个 id 落同一后端 → 只留一行、独占后端不误伤、路由档位全关、幂等、批量改动后必须无条件广播 `llm/models-updated`；诊断表启用数必须现算 |
| `disabled.test.mjs` | `enabled:false` 之后 fetch 计数器必须为 0，且**带对照组**（启用时确实发了请求）—— 否则那个「0」只是计数器没接上；同时验 `ok=false` 与三个工具都回「已禁用」 |
| `manual-login.test.mjs` | 方式二端到端：三种粘法 → 校验必需项 → **真换到网关 token** 才存 → 加密存储 → 切换登录方式 → 清除。逐值比对状态文件 / 返回值 / 日志都没有明文；并验回执必须说明**实际在用哪份凭据**（auto + 桌面版可用时手动 Cookie 只是备胎，不写这句用户会以为换了账号） |
| `http-robustness.test.mjs` | 同源接口乱传 15 组参数：不崩、返回都是 JSON、不回显本机标识、不写坏状态文件；**目录外的 key 一律拒绝并说明原因**（否则垃圾只随状态文件堆积）；显示名截 80 字并剥控制字符；日志无凭据 |
| `portable.test.mjs` | ① 跨平台目录候选（Windows 双 APPDATA、macOS `Library/Application Support`、Linux `~/.config` 与 `XDG_CONFIG_HOME`、`DUMATE_USER_DATA` 严格生效不回退）；② **隐私**：违禁值全部运行时推导、扫描范围 = tarball 范围、**不跳过任何文件包括它自己**、ASCII 标识整词匹配（真家目录仍能抓到，合法 handle 不误报）、命中只报位置不打印原文；③ 发布完整性：无 `private:true`、`files` 覆盖运行必需文件、`.cjs` 后缀保住、不静态 import DSH 包、客户端全走同源相对路径、宿主与客户端字段名一致 |

## 不覆盖的

真机对话的实际扣积分、GUI 里的真实渲染（要靠 Coral 眼睛）、企业版网关、账号池自动换号、模型可用性探测（真实体积）、生图/生视频。

## 写用例时的三条规矩

1. **先隔离 `DSH_HOME`**，素材尽量自造 —— 依赖真机状态的用例在别人机器上会 FAIL 或静默 SKIP，后者更坏。
2. **断言必须能失败**。像 `assert.ok(x || true)` 这种永真式等于没测；取不到数据时要显式 `SKIP` 并说明，而不是让它默默通过。
3. **测 React 组件的桩必须能翻状态**，且要把交互点一遍 —— 只渲染不点，事件回调里的崩溃永远测不到。
