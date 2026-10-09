# M0-13 僵局判断模板改到第 3 版后的重跑：
# 当铺的三个推演条件各 3 次全部重跑；雨夜只重跑被旧版判断提前结束的那一次（僵局后导演，种子 3）。
# 对照组不调用僵局判断，不需要重跑。
# 先在同一个 PowerShell 窗口里设置 $env:DEEPSEEK_API_KEY，再在仓库根目录运行：
#   powershell -ExecutionPolicy Bypass -File m0/experiments/deepseek-rerun-stalemate.ps1

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
if (-not $env:DEEPSEEK_API_KEY) {
  Write-Error '请先设置 $env:DEEPSEEK_API_KEY'
  exit 1
}

$exp = 'm0/experiments/deepseek.yaml'
$pawnshop = 'm0/scenes/pawnshop.yaml'
$rainy = 'm0/scenes/rainy-night.yaml'
$log = "m0/runs/batch-rerun-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"

function Log([string]$line) {
  Write-Output $line
  $line | Out-File -FilePath $log -Append -Encoding utf8
}

function Step([string]$title, [string[]]$m0Args) {
  Log "`n===== $title ====="
  pnpm m0 @m0Args --experiment $exp --yes 2>&1 | ForEach-Object { Log "$_" }
}

Step "实验组 $pawnshop" @('run', $pawnshop, '--runs', '3', '--parallel', '3')
Step "导演（僵局后） $pawnshop" @('run', $pawnshop, '--runs', '3', '--parallel', '3', '--director', 'stalemate')
Step "导演（张力曲线） $pawnshop" @('run', $pawnshop, '--runs', '3', '--parallel', '3', '--director', 'curve', '--curve', '前五轮试探压价，第八轮翻脸，之后收束')
Step "导演（僵局后） $rainy 种子 3" @('run', $rainy, '--runs', '1', '--seed', '3', '--director', 'stalemate')

Log "`n全部完成，日志：$log"
