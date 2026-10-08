# M0-13 批量实验（DeepSeek）：三个场景各跑实验组、两种导演条件与对照组，每个条件 3 次。
# 先在同一个 PowerShell 窗口里设置 $env:DEEPSEEK_API_KEY，再在仓库根目录运行：
#   powershell -ExecutionPolicy Bypass -File m0/experiments/deepseek-batch.ps1
# 每条命令仍会先打印预计费用；--yes 表示运行这个脚本即确认全部费用。
# 输出同时写入 m0/runs/batch-<时间>.log（不入库），运行标识从日志中取。

$ErrorActionPreference = 'Continue'
# 文件存为带 BOM 的 UTF-8，Windows PowerShell 5.1 才能正确读中文；控制台与日志也用 UTF-8。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
if (-not $env:DEEPSEEK_API_KEY) {
  Write-Error '请先设置 $env:DEEPSEEK_API_KEY'
  exit 1
}

$exp = 'm0/experiments/deepseek.yaml'
$log = "m0/runs/batch-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
New-Item -ItemType Directory -Force m0/runs | Out-Null

$scenes = @(
  @{ file = 'm0/scenes/warehouse.yaml'; curve = '前两轮试探，第四轮爆发，之后收束' },
  @{ file = 'm0/scenes/pawnshop.yaml'; curve = '前五轮试探压价，第八轮翻脸，之后收束' },
  @{ file = 'm0/scenes/rainy-night.yaml'; curve = '前五轮冷对，第十轮爆发，之后和解或决裂' }
)

function Log([string]$line) {
  Write-Output $line
  $line | Out-File -FilePath $log -Append -Encoding utf8
}

function Step([string]$title, [string[]]$m0Args) {
  Log "`n===== $title ====="
  pnpm m0 @m0Args --experiment $exp --yes 2>&1 | ForEach-Object { Log "$_" }
}

foreach ($s in $scenes) {
  Step "实验组 $($s.file)" @('run', $s.file, '--runs', '3', '--parallel', '3')
  Step "导演（僵局后） $($s.file)" @('run', $s.file, '--runs', '3', '--parallel', '3', '--director', 'stalemate')
  Step "导演（张力曲线） $($s.file)" @('run', $s.file, '--runs', '3', '--parallel', '3', '--director', 'curve', '--curve', $s.curve)
  Step "对照组 $($s.file)" @('baseline', $s.file, '--runs', '3')
}

Log "`n全部完成，日志：$log"
