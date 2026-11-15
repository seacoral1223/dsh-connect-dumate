# 回归测试

都在项目内跑，路径自洽，不需要 DSH 进程、不需要联网（`coldstart` 与 `lifecycle` 会真连一次网关读目录，离线时会退到兜底并通过）：

```pwsh
cd projects/dsh-connect-dumate
node tests/adapter-offline.test.mjs
node tests/lifecycle.test.mjs
node tests/coldstart.test.mjs
node tests/fresh-machine.test.mjs
node tests/client-structure.test.mjs
node tests/pill-visibility.test.mjs
node tests/disabled.test.mjs
node tests/manual-login.test.mjs
node tests/foreign-machine.test.mjs
node tests/defaults.test.mjs
node tests/portable.test.mjs
node tests/defaults.test.mjs
node tests/failure-codes.test.mjs
```

| 脚本 | 证明的事 |
| --- | --- |
| `adapter-offline.test.mjs` | 自带假 OpenAI SSE 服务：DSH 消息 → wire 映射（system / developer / user+file / assistant+tool_calls / tool 结果 / 图片另起 user / 不支持图片时不塞 image_url）；SSE → StreamChunk 顺序（block-start → deltas → block-end → usage → finish，且 finish 是最后一个）；`stream_options.include_usage`、usage 折算（缓存命中从 prompt_tokens 里减出来）；目录里没有的模型**不抛**且给正整数窗口；全关时仍有兜底目录 |
| `lifecycle.test.mjs` | 假 ctx 按 cordis 语义跑 effect（体立刻执行、返回/yield 的才是 disposer）：挂载后 `providers=[dumate]` + 两条同源路由 + 命令 + 三个工具都在，`llm/models-updated` 已发出，跨源请求 403，勾选写路径与 `action=bogus` 的报错路径正确；跑完 disposer 后 providers/routes 全部释放。**这条专门用来钉 v0.1 那个「挂载即释放」的 bug** |
| `coldstart.test.mjs` | 第一次网络刷新还在飞的时候问 `listModels()`：必须当场交出非空目录（实测 1ms，走缓存；缓存清空后也 ≤3s 交出） |
| `client-structure.test.mjs` | 用最小假 React + 假 slots/locale 把 `client.js` 起起来：三个座位都注册了、`settings.section.icon` 的 id 与分栏 id 一致（不一致宿主就不画图标）、`label` 是 thunk、五个分栏在「空数据」和「真实形状的数据」下各渲染一遍不抛、胶囊按 provider 显隐、disposer 可跑 |
| `pill-visibility.test.mjs` | 把 `client.js` 里 `GATE-START/END` 标记块**原样抠出来**跑 10 个用例：`next` 优先于 `lastUsed`、别的 provider（deepseek / workbuddy / aliyun）一律不出现、空投影 / 空串 / 非字符串 provider 都不出现。测的是浏览器实际跑的那段代码，不是副本 |
| `fresh-machine.test.mjs` | 最坏情况：没装 App（`APPDATA` 指向空临时目录）+ 状态文件不存在 + `inspect()` 强制抛 → 这一组仍然有模型可列、`resolveModel` 不抛，因为宿主的 `buildModelCatalog` 会把零模型或抛错的 provider **整组隐藏** |

不覆盖的：真机对话扣积分、GUI 渲染（胶囊与选择器）、企业版、账号档切换。
