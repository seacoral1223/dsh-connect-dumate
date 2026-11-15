# 发布流程（维护者用，不进包）

这份文件不在 `package.json` 的 `files` 白名单里，所以不会随 tarball 发出去。

## 当前通道：GitHub

这个插件**通过 GitHub tag 分发**，不走 npm。原因不是省事，是 npm 的发布凭据政策正在变动 —— 页面横幅原文（2026-11 实测）：

> *npm tokens that bypass 2FA are being restricted — account changes (Aug 2026) and direct publishing (Jan 2027).*

「建个带 bypass 权限的 token 然后命令行发布」这条路 **2027 年 1 月就要关掉**。GitHub 不受它影响，而且本机不需要留任何长期凭据。

### 发版

```powershell
cd <项目目录>
npm test                                    # 12 个回归，不过就别发
# 改 package.json 的 version 与 CHANGELOG.md，然后：
git add -A
git commit -m "release: vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push ; git push --tags
```

GitHub 会**自动**为 tag 生成源码包，不用手动上传 release 资产。

### 别人怎么装

```
https://codeload.github.com/seacoral1223/dsh-connect-dumate/tar.gz/refs/tags/vX.Y.Z
```

下载 → 解压 → DSH 的插件管理里 **Plugins → Add plugin** 选那个目录 → **重启 DSH**。
（`npm i -g` 那种写法没用：全局安装不会把 bundle 注册进 DSH 的 profile。）

### 发完必须自证

把刚推的 tag 包下载到一个**空目录**、给一个**空的 `DSH_HOME`** 跑 `npm test`。这一步抓出过两次真问题：

- 用例依赖真机状态文件当素材 → 在别人机器上要么 FAIL 要么静默 SKIP（等于没测）；
- 会发布的测试文件里，注释写了本机用户名与 handle 的字面值 → 隐私扫描报得对。

## 发布前自检

```powershell
npm run publish:check     # 元数据 + GitHub 仓库是否真存在 + 版本是否被发过 + 12 回归 + 隐私扫描
npm run pack:check        # 看 tarball 到底有哪些文件
```

`prepublishOnly` 挂着 `npm run check`，所以 `npm publish` 也会自己拦一道。三处刻意的设计，别改回去：

- **取不到 tarball 清单就直接停**，不继续往下跑 —— 否则「包里必须有 X」「没有隐私值」在空列表下会全部自动通过，那是假绿灯。
- ASCII 标识**整词匹配**：本机用户名常常是合法 handle 的前缀，按子串匹配会把分发地址与署名报成泄漏；误报的害处不是烦，是逼人关掉检查。中文昵称没有词边界，仍按子串。
- 扫描范围 = **tarball 范围**（`files` 展开），不是仓库全部文件。把不发布的内部笔记算进判定只会制造假失败，诱导人绕过扫描器。

## 如果将来要走 npm

1. **先开 2FA**（验证器 App）。别指望 bypass token，那条正在被关。
2. 长期方案是 **Trusted Publishing (OIDC)**：由 GitHub Actions 发布，账号里不存 token。npm 文档有专门一页 "Trusted publishing with OIDC"。
3. 注册邮箱**不要用私人邮箱** —— npm 的 `maintainers` 字段公开邮箱，`npm view <pkg> maintainers` 谁都能查（同类插件的 QQ/163 邮箱现在就是裸着的）。
4. `npm login --auth-type=legacy` 拿到的是**会话 token**，它**不出现在网页 Access Tokens 列表里**，所以那个页面撤不掉它；要作废只能改密码（`npm logout` 只删本机文件，服务端不撤销）。
5. 版本号发出去不能覆盖重发；发错只能 `npm deprecate`，或 72 小时内 `npm unpublish`。所以有问题就发 `X.Y.Z+1`，别改 tag。

## 版本纪律

- 每次改动先 `npm test`（12 个），再决定版本号：修 bug 补 patch，加能力补 minor。
- **不移动已发布的 tag** —— 那会让同一个下载地址悄悄变成不同内容。要改就升版本、打新 tag。
- 本地开发时插件是 link 安装，改完代码**重启 DSH 即可**，不用反复重装。

## 卸载/停用要提醒用户的两条

1. **先把 DSH 的默认模型从 `dumate/*` 切走**再移除插件 —— 否则 `agent-default-model` 会留下指向已消失 provider 的幽灵条目，导致每次启动加载失败。
2. 插件只写 `~/.dsh/dumate-state.json` 与 `~/.dsh/dumate-cookies.key`，卸载不会自动清；想彻底清空就手工删这两个文件。
