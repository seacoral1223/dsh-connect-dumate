> 把你已经登录的百度搭子（DuMate）变成 DSH 里的一个模型供应商：模型进选择器，积分与每日签到挂在输入框上。**桌面版 App 不用开着** —— 对话默认走搭子自己的云端模型网关。

## 30 秒装好

前提：**DSH ≥ 0.2.2**（版本不够时宿主会整个跳过这个 bundle，而且**页面不报错**）+ 一个百度搭子账号。

```powershell
# ① 下载并解压（Windows 10/11 自带 tar；macOS / Linux 同命令）
curl -L -o dumate.tgz https://codeload.github.com/seacoral1223/dsh-connect-dumate/tar.gz/refs/tags/v0.9.17
tar -xzf dumate.tgz
# 解压出来是目录：dsh-connect-dumate-0.9.17
```

**②** DSH → 插件管理 → **Add plugin（添加插件）** → 选中上面那个目录
**③** **重启 DSH**（不重启就是"装了但什么都没有"的头号原因）

> ⚠️ 不要用 `npm i -g`：全局安装不会把 bundle 注册进 DSH 的 profile。
> 会用 git 也可以：`git clone --branch v0.9.17 https://github.com/seacoral1223/dsh-connect-dumate.git`

## 装好后应该看到这四样

1. 模型选择器里出现 **百度搭子 DuMate** 一组（默认 11 个模型）
2. 选中其中任意模型时，输入框上出现**积分胶囊**（选别的模型就不出现，这是设计）
3. **设置 → 百度搭子** 有账号 / 积分 / 模型 / 能力 / 诊断 五个分栏
4. 对话里打 `/dumate doctor` 出诊断表（第一行就是插件版本，方便报障）

## 没装桌面版也能用

设置 → 百度搭子 → 账号 里粘两个 Cookie 即可（`bce-sessionid` 与 `bce-user-info`，实测最小集）。
从浏览器 **F12 → Application → Cookies** 复制 —— `bce-sessionid` 是 HttpOnly，控制台里 `document.cookie` 拿不到它。
导入会先去换一个真 token、**成功才保存**。

## 验证

在空 `DSH_HOME`（等价于新用户机器）里跑完整回归：19 个用例全过。

## 注意

这是**第三方非官方接入**，调用的是搭子客户端的私有接口，上游收紧时可能失效，请自行评估账号风险。插件不注册账号、不代登录、不绕过计费；每次调用消耗的都是你自己账号的积分。唯一的写操作是领取每日签到，默认关闭。详见 README「风险提示」与 docs/PRIVACY.md。
