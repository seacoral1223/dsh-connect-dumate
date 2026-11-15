# 发布流程（维护者用，不进包）

这份文件不在 `package.json` 的 `files` 白名单里，所以不会随 tarball 发出去。

## 现在这台机器的事实（2026-11-15 实测）

| 项 | 状态 |
| --- | --- |
| `npm ping` | **通**，PONG 886ms（走本机代理策略，能到 registry.npmjs.org） |
| `npm publish --dry-run` | **exit 0** —— 结构上现在就能发，24 个文件 |
| `npm whoami` | **未登录**（ENEEDAUTH），`~/.npmrc` 不存在 |
| registry 上的名字 | `dsh-connect-dumate` **404 = 空着**，可以占（也意味着有被抢注风险） |
| git | **Windows 侧没装**（四个常见位置都没有）；`winget` 可用 |
| 项目仓库 | 没有 `.git` |

## 只有你能提供的三样

1. **npm 账号**（没有就去 https://www.npmjs.com/signup 注册，邮箱要验证）。
2. **GitHub 仓库地址 + 署名**，用来填 `package.json` 的 `repository` / `homepage` / `author` / `bugs`。
   这三项**不是发布的必要条件**（现在没有也能发），但对一个读登录态的插件来说，「源码在哪、谁写的」是别人敢装的前提。我不替你编 URL。
3. **2FA 决定**：npm 近年收紧了发布凭据（有资料说经典 token 已吊销、发布要求 2FA 或走 Trusted Publishing），但**我没有权威来源可确认当前政策** —— 两篇相关文档都被 Cloudflare 验证页挡住。所以别照我这句话行动，**去 npm 网页后台 → Account → Publishing Access 自己看一眼当前要求**，再决定用 `npm login` 还是别的通道。

## 最短路径：一个脚本

```powershell
cd <项目目录>\projects\dsh-connect-dumate
.\scripts\publish.ps1
```

它会按顺序检查并**在该你出手的地方停下来**（不是报错退出，是打印下一步该做什么）：

1. Git 在不在（不在就给三个安装选项 —— 我这侧试过 winget，下载被网络策略卡住了）
2. git 提交署名配了没（并提醒邮箱会公开，可用 GitHub noreply 地址）
3. GitHub 仓库存在没（不存在就给填好名字的创建链接，并提醒三个勾都不要打）
4. `git init` + `add` + 首次提交 —— **并且会检查 `AGENTS.md` 有没有被 staged，有就拒绝提交**
5. 关联 origin + 推送（GitHub 认证只能你本人）
6. 发布前自检 `npm run publish:check`
7. `npm login`（没登录就停下告诉你命令）→ `npm publish`
8. 回查 registry 确认收录

## 发布前自检查什么（`npm run publish:check`）

`scripts/precheck.mjs`，18 项：元数据齐不齐、**repository 指向的 GitHub 仓库是不是真的存在**（404 就拦，发出去的包不能指着空地址）、仓库名与包名是否一致、npm 登录状态、**这个版本号有没有被发过**（发过的不能覆盖）、12 个回归、tarball 清单、`AGENTS.md`/`scripts/` 不在包里、以及包内容逐文件比对本机隐私值。

两处刻意的设计，别改回去：

- **取不到 tarball 清单就直接停**，不继续往下跑 —— 否则「包里必须有 X」「没有隐私值」在空列表下会全部自动通过，那是假绿灯。
- `package.json` 的 `author`/`repository`/`homepage`/`bugs` 是**身份字段**，允许出现你的 handle（本来就该写）；其余字段出现本机值才算泄漏。一刀切禁止会逼人删掉署名，把检查变成噪音。

## 手动流程（脚本之外的等价步骤）

```powershell
cd <项目目录>\projects\dsh-connect-dumate

# 1) 没有账号先注册：https://www.npmjs.com/signup（邮箱要点验证）
# 2) 登录（会开浏览器）
& "C:\Program Files\nodejs\npm.cmd" login
& "C:\Program Files\nodejs\npm.cmd" whoami     # 确认身份，输出你的用户名

# 3) 发
& "C:\Program Files\nodejs\npm.cmd" publish
```

## 想要 GitHub 仓库（可选，但建议）

```powershell
winget install --id Git.Git -e --source winget
# 装完重开终端
git --version
```

或者直接用你 Ubuntu 那边（双系统，工作区在 Windows 分区，挂载即可）：

```bash
cd <挂载点>/…/default-workspace/projects/dsh-connect-dumate
git init && git add -A && git commit -m "dsh-connect-dumate v0.8.0"
```

**推之前必须确认**：`AGENTS.md`（内部逆向笔记、真实账号昵称、`tmp/dumate/*` 探测记录）会被 git 收进去，而它不在 npm 白名单里 —— 公开仓库要加 `.gitignore` 把它和 `tmp/`、`*.tgz` 排除。这一步我不能替你决定要不要公开这些笔记。

## 版本纪律

- 每次改动**先跑 `npm test`**（11 个），再决定版本号：修 bug 补 patch，加能力补 minor。
- 发布过的版本号不能覆盖重发（npm 不允许），发错了只能 `npm deprecate` 或 `npm unpublish`（有 72 小时窗口）。
- 改完代码后本地用户**只需重启 DSH**（link 安装），不用重装。

## 装别人的包时（顺带记一句）

`npm i -g` 装不进 DSH —— 全局安装不会注册进 profile。正确路径是插件管理里的 **Plugins → Add plugin**（本地目录）或按包名安装（已发布）。
