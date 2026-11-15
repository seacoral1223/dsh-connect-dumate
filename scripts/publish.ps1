# 一键发布 dsh-connect-dumate
# 用法：cd 到项目目录，在 PowerShell 里跑  .\scripts\publish.ps1
# 每步先检查再动手；卡住就停下来说清要做什么，不会半途乱改你的东西。

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$raw = [System.IO.File]::ReadAllText([System.IO.Path]::Combine($Root, 'package.json'), [System.Text.Encoding]::UTF8)
$pkg = $raw | ConvertFrom-Json
$owner = 'seacoral'
$repoName = $pkg.name
$repoWeb = "https://github.com/$owner/$repoName"

Write-Host ''
Write-Host ('=== 发布 ' + $pkg.name + '@' + $pkg.version + ' ===') -ForegroundColor Cyan

# ---------- 1) Git 在不在 ----------
$git = $null
foreach ($c in @('git', 'C:\Program Files\Git\cmd\git.exe', (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd\git.exe'))) {
  $found = Get-Command $c -ErrorAction SilentlyContinue
  if ($found) { $git = $found.Source; break }
  if (Test-Path $c) { $git = $c; break }
}
if (-not $git) {
  Write-Host ''
  Write-Host '[停] 这台 Windows 上没有 Git。三选一：' -ForegroundColor Yellow
  Write-Host '  A. winget install --id Git.Git -e --source winget'
  Write-Host '     （我这侧试过一次，下载被网络策略卡住；你自己跑可能通）'
  Write-Host '  B. 官网下安装包 https://git-scm.com/download/win'
  Write-Host '  C. 用你的 Ubuntu 那边：工作区在 Windows 分区，挂载后 cd 进来'
  Write-Host '     手打本脚本里的 git 步骤即可（后面 npm 步骤在 Windows 上做）'
  Write-Host '装好后重跑本脚本。'
  exit 1
}
Write-Host ('  ok  git: ' + $git)

# ---------- 2) 提交署名 ----------
$name = & $git config --global user.name
$mail = & $git config --global user.email
if (-not $name -or -not $mail) {
  Write-Host ''
  Write-Host '[停] git 还没配署名（user.name / user.email 是空的）。跑这两行，值你自己定：' -ForegroundColor Yellow
  Write-Host ('  & "' + $git + '" config --global user.name "你的名字"')
  Write-Host ('  & "' + $git + '" config --global user.email "你 GitHub 用的邮箱"')
  Write-Host '注意：邮箱会公开出现在提交记录里。想避免就用 GitHub 的 noreply 地址，'
  Write-Host '      形如 12345678+seacoral@users.noreply.github.com（数字在 GitHub 个人主页能查到）。'
  exit 1
}
Write-Host ('  ok  提交署名: ' + $name + ' <' + $mail + '>')

# ---------- 3) 仓库必须先在 GitHub 上建好 ----------
$repoOk = $false
try {
  Invoke-WebRequest -Uri ('https://api.github.com/repos/' + $owner + '/' + $repoName) -UseBasicParsing -TimeoutSec 20 -Headers @{ 'User-Agent' = 'dsh-publish' } | Out-Null
  $repoOk = $true
} catch { $repoOk = $false }
if (-not $repoOk) {
  Write-Host ''
  Write-Host '[停] GitHub 仓库还不存在。打开这个链接建，名字已经帮你填好：' -ForegroundColor Yellow
  Write-Host ('  https://github.com/new?repository-name=' + $repoName)
  Write-Host '  三个勾都不要打（Add README / Add .gitignore / Add license）——'
  Write-Host '  本地已经有全套，GitHub 再生成一份会撞车。'
  Write-Host '建好后重跑本脚本。'
  exit 1
}
Write-Host ('  ok  GitHub 仓库已存在: ' + $repoWeb)

# ---------- 4) 本地仓库与首次提交 ----------
if (-not (Test-Path (Join-Path $Root '.git'))) {
  & $git init -q
  & $git add -A
  $staged = & $git diff --cached --name-only
  Write-Host ('  ok  已 add ' + @($staged).Count + ' 个文件：')
  @($staged) | Select-Object -First 40 | ForEach-Object { Write-Host ('      ' + $_) }
  if (@($staged) -contains 'AGENTS.md') {
    Write-Host ''
    Write-Host '[停] AGENTS.md 被 staged 了 —— .gitignore 没生效，先别提交。' -ForegroundColor Red
    exit 1
  }
  & $git commit -q -m ($pkg.name + ' v' + $pkg.version + ': 接入百度搭子模型与积分，支持桌面版登录态与手动导入 Cookie')
  Write-Host '  ok  首次提交完成'
} else {
  & $git add -A
  $dirty = & $git status --porcelain
  if ($dirty) {
    & $git commit -q -m 'chore: 发布前更新'
    Write-Host '  ok  提交了改动'
  } else {
    Write-Host '  ok  工作区干净'
  }
}

# ---------- 5) 推送 ----------
& $git branch -M main 2>$null
$hasRemote = & $git remote get-url origin 2>$null
if (-not $hasRemote) {
  & $git remote add origin ($repoWeb + '.git')
  Write-Host '  ok  已关联 origin'
}
Write-Host '  ..  推送中（会弹 GitHub 登录，这一步只能你本人认证）'
& $git push -u origin main
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host '[停] 推送失败，看上面的报错；一般是凭据或仓库权限问题。' -ForegroundColor Red
  exit 1
}
Write-Host ('  ok  已推送到 ' + $repoWeb)

# ---------- 6) 发布前自检 ----------
Write-Host ''
Write-Host '  ..  发布前自检（12 个回归 + 隐私扫描 + 元数据）'
& 'C:\Program Files\nodejs\npm.cmd' run publish:check
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host '[停] 自检没过，看上面哪一条 FAIL，修完重跑。' -ForegroundColor Red
  exit 1
}
Write-Host '  ok  自检全过'

# ---------- 7) npm 登录与发布 ----------
$who = & 'C:\Program Files\nodejs\npm.cmd' whoami 2>$null
if (-not $who) {
  Write-Host ''
  Write-Host '[停] npm 未登录。跑这一行（会开浏览器，2FA 也在那一步完成）：' -ForegroundColor Yellow
  Write-Host '  & "C:\Program Files\nodejs\npm.cmd" login'
  Write-Host '登录完重跑本脚本即可继续。'
  exit 1
}
Write-Host ('  ok  npm 身份: ' + $who)
Write-Host '  ..  npm publish'
& 'C:\Program Files\nodejs\npm.cmd' publish
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host '[停] 发布失败，看上面的报错。' -ForegroundColor Red
  exit 1
}

# ---------- 8) 验证真的上去了 ----------
Start-Sleep -Seconds 8
try {
  $j = Invoke-RestMethod -Uri ('https://registry.npmjs.org/' + $pkg.name) -TimeoutSec 30
  Write-Host ''
  Write-Host ('  ok  registry 已收录，最新版本 ' + $j.'dist-tags'.latest) -ForegroundColor Green
  Write-Host ('      https://www.npmjs.com/package/' + $pkg.name)
} catch {
  Write-Host '  ..  registry 索引可能还在同步，过一两分钟自己看一眼包页面'
}

Write-Host ''
Write-Host '=== 完成。给别人的一句话 ===' -ForegroundColor Cyan
Write-Host ('在 DSH 插件管理里安装 ' + $pkg.name + '；')
Write-Host '前置条件是装了百度搭子桌面版并登录过，或者不装桌面版、在 设置 → 百度搭子 → 账号'
Write-Host '里手动粘两个 Cookie（bce-sessionid 与 bce-user-info）。装完重启 DSH。'
