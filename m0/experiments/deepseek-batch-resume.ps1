# M0-13 批量实验的续跑：接着 2026-10-08 夜里中断的 deepseek-batch.ps1。
# 先续完被中断的雨夜“僵局后导演”三次运行（已结束的自动跳过），再跑雨夜的张力曲线导演与对照组。
# 先在同一个 PowerShell 窗口里设置 $env:DEEPSEEK_API_KEY，再在仓库根目录运行：
#   powershell -ExecutionPolicy Bypass -File m0/experiments/deepseek-batch-resume.ps1
# 续跑按步骤键跳过已完成的模型调用，不会重复计费；中断时正在进行的调用会重新发出。

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
if (-not $env:DEEPSEEK_API_KEY) {
  Write-Error '请先设置 $env:DEEPSEEK_API_KEY'
  exit 1
}

$exp = 'm0/experiments/deepseek.yaml'
$scene = 'm0/scenes/rainy-night.yaml'
$log = "m0/runs/batch-resume-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
$interrupted = @('01M4E5GEBEQ93TRN8JNTY871GC', '01M4E5GEBFSKV5F51GF41QC29P', '01M4E5GEBFZ8G92VG27CPX5222')

function Log([string]$line) {
  Write-Output $line
  $line | Out-File -FilePath $log -Append -Encoding utf8
}

function Step([string]$title, [string[]]$m0Args) {
  Log "`n===== $title ====="
  pnpm m0 @m0Args --experiment $exp --yes 2>&1 | ForEach-Object { Log "$_" }
}

foreach ($id in $interrupted) {
  # summary.json 只在运行结束或暂停后写出；有它说明这次运行在中断前已经跑完。
  if (Test-Path "m0/runs/$id/summary.json") {
    Log "运行 $id 已经结束，跳过。"
    continue
  }
  Step "续跑 导演（僵局后） $scene $id" @('run', $scene, '--resume', $id)
}
Step "导演（张力曲线） $scene" @('run', $scene, '--runs', '3', '--parallel', '3', '--director', 'curve', '--curve', '前五轮冷对，第十轮爆发，之后和解或决裂')
Step "对照组 $scene" @('baseline', $scene, '--runs', '3')

Log "`n全部完成，日志：$log"
