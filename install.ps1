<#
.SYNOPSIS
  Xliens 安装脚本：把记忆机器人装进 DSH。

.DESCRIPTION
  做四件事：
    1. 检查 Python / Node / DSH 是否存在
    2. 装 Python 依赖（torch / transformers / numpy）
    3. 装插件依赖（@modelcontextprotocol/sdk、@snowluma/sdk、zod）
    4. 生成配置并把插件注册进 DSH profile（带备份）

  跑完重启 DSH 即可。默认不响应任何 QQ 消息，需要自己加白名单。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1

.EXAMPLE
  # 自定义 SnowLuma 位置
  powershell -ExecutionPolicy Bypass -File install.ps1 -SnowlumaHome "<SNOWLUMA_HOME>"
#>
param(
  [string]$SnowlumaHome = (Join-Path $env:LOCALAPPDATA 'SnowLuma2'),
  [switch]$SkipPython,
  [switch]$SkipNode
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Bot = Join-Path $Root "bot"

function Info($m) { Write-Host "  $m" }
function Ok($m) { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "  [X] $m" -ForegroundColor Red; exit 1 }

Write-Host "`n=== Xliens 安装 ===`n" -ForegroundColor Cyan
Info "仓库目录：$Root"

# ─────────────────────────── 1. 找 Node ───────────────────────────
Write-Host "`n[1/4] 检查 Node.js" -ForegroundColor Cyan

$Node = $null
$candidates = @(
  (Join-Path $env:USERPROFILE ".dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"),
  (Join-Path ${env:ProgramFiles} "nodejs\node.exe"),
  (Join-Path ${env:LOCALAPPDATA} "Programs\nodejs\node.exe")
)
foreach ($c in $candidates) {
  if ($c -and (Test-Path $c)) { $Node = $c; break }
}
if (-not $Node) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $Node = $cmd.Source }
}
if (-not $Node) { Die "找不到 node.exe。请先装 Node.js 20+，或用 DSH 自带的那个。" }
Ok "node：$Node"
Info ("版本：" + (& $Node --version))

# ─────────────────────────── 2. 找 Python ───────────────────────────
Write-Host "`n[2/4] 检查 Python" -ForegroundColor Cyan

$Python = $null
foreach ($c in @("py", "python")) {
  $cmd = Get-Command $c -ErrorAction SilentlyContinue
  if ($cmd) { $Python = $cmd.Source; break }
}
if (-not $Python) { Die "找不到 Python。请装 Python 3.10+ 并加入 PATH。" }
Ok "python：$Python"

if (-not $SkipPython) {
  Write-Host "  安装 Python 依赖（torch 较大，首次可能要几分钟）…"
  Push-Location $Root
  try {
    $pyLauncher = (Split-Path $Python -Leaf) -match '^py(\.exe)?$'
    $pyArgs = if ($pyLauncher) { @("-3") } else { @() }
    & $Python @pyArgs -m pip install --upgrade pip --quiet
    & $Python @pyArgs -m pip install -r requirements.txt
    if ($LASTEXITCODE -ne 0) { Warn "Python 依赖安装失败，可稍后手动执行：py -3 -m pip install -r requirements.txt" }
    else { Ok "Python 依赖已就绪" }
  } finally { Pop-Location }
}

# ─────────────────────────── 3. 装 Node 依赖 ───────────────────────────
Write-Host "`n[3/4] 安装插件依赖" -ForegroundColor Cyan

if ($SkipNode) {
  Info "已跳过"
} elseif ((Test-Path (Join-Path $Bot "node_modules\@modelcontextprotocol\sdk")) -and
    (Test-Path (Join-Path $Bot "node_modules\@snowluma\sdk"))) {
  Ok "依赖已存在，跳过"
} else {
  $npm = Join-Path (Split-Path $Node) "npm.cmd"
  Push-Location $Bot
  try {
    if (Test-Path $npm) {
      & $npm install --no-audit --no-fund
    } else {
      Warn "没找到 npm，尝试用 corepack / pnpm"
      $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
      if ($pnpm) { & $pnpm.Source install --prod } else { Die "没有 npm 也没有 pnpm，装不了依赖。" }
    }
    if ($LASTEXITCODE -ne 0) { Die "依赖安装失败" }
    Ok "插件依赖已就绪"
  } finally { Pop-Location }
}

# ─────────────────────── 4. 生成配置 + 注册 ───────────────────────
Write-Host "`n[4/4] 生成配置并注册到 DSH" -ForegroundColor Cyan

$tpl = Join-Path $Bot "cordis.patch.yml.example"
$cfg = Join-Path $Bot "cordis.patch.yml"
if (-not (Test-Path $tpl)) { Die "找不到模板 $tpl" }

$text = Get-Content $tpl -Raw -Encoding UTF8
$rootFwd = $Root.Replace('\', '/')
$text = $text.Replace('{{NODE}}', $Node.Replace('\', '/'))
$text = $text.Replace('{{ROOT}}', $rootFwd)
$text = $text.Replace('{{SNOWLUMA_HOME}}', $SnowlumaHome.Replace('\', '/'))
[IO.File]::WriteAllText($cfg, $text, (New-Object Text.UTF8Encoding $false))
Ok "已生成 bot/cordis.patch.yml"

# 初始化数据目录：只复制脱敏示例，不覆盖已有真实配置
$FileDir = Join-Path $Root "file"
New-Item -ItemType Directory -Path $FileDir -Force | Out-Null
foreach ($pair in @(
  @("alias.json.example", "alias.json")
)) {
  $src = Join-Path $FileDir $pair[0]
  $dst = Join-Path $FileDir $pair[1]
  if ((Test-Path $src) -and -not (Test-Path $dst)) {
    Copy-Item $src $dst
    Info "已生成 file/$($pair[1])（示例，需按需修改）"
  }
}

# DSH profile
$Profile = Join-Path $env:USERPROFILE ".dsh\profiles\desktop"
if (-not (Test-Path $Profile)) {
  Warn "找不到 DSH profile（$Profile），请先启动一次 DSH。"
} else {
  $pkgPath = Join-Path $Profile "package.json"
  $backup = "$pkgPath.bak-xliens-install"
  if (-not (Test-Path $backup)) { Copy-Item $pkgPath $backup; Info "已备份 profile/package.json" }

  $pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
  $pkg.dependencies | Add-Member -Force -NotePropertyName "xliens" -NotePropertyValue ("link:" + $rootFwd + "/bot")

  if (-not $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
  if (-not $pkg.dsh.profile) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }
  if (-not $pkg.dsh.profile.bundles) { $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() }
  if ($pkg.dsh.profile.bundles -notcontains "xliens") {
    $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles) + "xliens"
  }

  $json = $pkg | ConvertTo-Json -Depth 10
  [IO.File]::WriteAllText($pkgPath, $json + "`n", (New-Object Text.UTF8Encoding $false))
  Ok "已写入 profile/package.json"

  # node_modules 链接
  $nm = Join-Path $Profile "node_modules"
  if (-not (Test-Path $nm)) { New-Item -ItemType Directory -Path $nm -Force | Out-Null }
  $link = Join-Path $nm "xliens"
  if (-not (Test-Path $link)) {
    cmd /c "mklink /J `"$link`" `"$Bot`"" | Out-Null
    Ok "已建立链接 node_modules/xliens"
  } else {
    Info "链接已存在"
  }
}

# ─────────────────────────── 完成 ───────────────────────────
Write-Host "`n=== 装好了 ===`n" -ForegroundColor Green
Write-Host "接下来："
Write-Host "  1. 重启 DSH"
Write-Host "  2. 打开 设置 → Xliens，确认能看到「逻辑图 / 章动过程 / 白名单 / 数据与备份」"
Write-Host "  3. 在「白名单」里填上你的 QQ 号或群号并保存（默认什么都不放行）"
$modelDir = Join-Path $Root "models\reg_v48_s3"
if (-not (Test-Path $modelDir)) {
  Write-Host "  4. 下载 CE 模型到 models\reg_v48_s3\（约 2.1GB，见 README 的 CE 模型）" -ForegroundColor Yellow
  Write-Host "     https://github.com/Raven50382/DSH-LongMemory/releases/tag/ce-model-v48-s3"
}
Write-Host ""
Write-Host "前置条件（脚本不会自动做）："
Write-Host "  · SnowLuma 已装好并登录过 QQ（路径：$SnowlumaHome）"
Write-Host "  · 图数据放在 graph_main/（空图会自动创建，也可导入自己的图）"
Write-Host "  · CE 模型放在 models/reg_v48_s3/（见 README 的 CE 模型）"
Write-Host ""
