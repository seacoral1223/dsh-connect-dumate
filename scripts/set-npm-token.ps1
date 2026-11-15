# 把 npm token 安全写进 ~/.npmrc
# 用法：.\scripts\set-npm-token.ps1
# token 用隐藏输入（屏幕上不回显、不进命令历史、不出现在对话里）。

param(
  # 测试用：写到别处，不碰真文件
  [string]$TargetPath = (Join-Path $env:USERPROFILE '.npmrc')
)

$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host '粘贴 npm token（输入时屏幕不会显示），回车确认。' -ForegroundColor Cyan
Write-Host '格式应为 npm_ 开头的一串。'
Write-Host ''

$secure = Read-Host -Prompt 'token' -AsSecureString
$token = [System.Runtime.InteropServices.Marshal]::PtrToStringUni(
  [System.Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($secure)
)
$token = $token.Trim()

if (-not $token) { Write-Host '[停] 空的，没写。' -ForegroundColor Yellow; exit 1 }
if ($token -notmatch '^npm_[A-Za-z0-9]{20,}$') {
  Write-Host ''
  Write-Host '[停] 这串不像 npm 的新版 token（应以 npm_ 开头）。没写文件，避免把好配置覆盖坏。' -ForegroundColor Yellow
  Write-Host ('     长度 ' + $token.Length + '，前缀 ' + $token.Substring(0, [Math]::Min(6, $token.Length)))
  exit 1
}

$line = '//registry.npmjs.org/:_authToken=' + $token

# 已存在就只替换那一行，别把用户其它配置抹了
if (Test-Path $TargetPath) {
  $old = [System.IO.File]::ReadAllText($TargetPath, [System.Text.Encoding]::UTF8)
  $kept = ($old -split "`r?`n" | Where-Object { $_ -and $_ -notmatch '_authToken' }) -join "`r`n"
  $new = if ($kept) { $kept + "`r`n" + $line + "`r`n" } else { $line + "`r`n" }
  [System.IO.File]::WriteAllText($TargetPath, $new, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ''
  Write-Host '  ok  已替换 ~/.npmrc 里的 token 行（其它配置保留）'
} else {
  [System.IO.File]::WriteAllText($TargetPath, $line + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ''
  Write-Host '  ok  已新建 ~/.npmrc'
}

# 回读时只报存在与长度，绝不打印 token —— 上次就是把「隐去」的正则写错，token 整串进了对话
$check = [System.IO.File]::ReadAllText($TargetPath, [System.Text.Encoding]::UTF8)
$has = $check -match '_authToken=npm_'
Write-Host ('  复核：文件里有 token 行 = ' + $has + '，文件长度 ' + $check.Length + ' 字符')
Write-Host '  （故意不打印内容 —— 这个文件里是秘密）'
Write-Host ''
Write-Host '下一步：npm publish' -ForegroundColor Cyan
