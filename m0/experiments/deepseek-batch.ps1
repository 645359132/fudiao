# M0-13 批量实验（DeepSeek）：三个场景各跑实验组、两种导演条件与对照组，每个条件 3 次。
# 先在同一个 PowerShell 窗口里设置 $env:DEEPSEEK_API_KEY，再在仓库根目录运行：
#   powershell -ExecutionPolicy Bypass -File m0/experiments/deepseek-batch.ps1
# 可选 -Scenes 只跑部分场景，例如 -Scenes pawnshop,rainy-night；-Concurrency 控制同时运行的条件数（默认 4）。
# 每条命令仍会先打印预计费用；--yes 表示运行这个脚本即确认全部费用。
# 各条件同时运行（每个条件内的 3 次也并行），墙钟时间约为依次运行的三分之一，费用不变。
# 每个条件的输出写入 m0/runs/batch-<时间>/<条件>.log，全部结束后合并到 m0/runs/batch-<时间>.log（不入库）。

param(
  [string[]]$Scenes = @('warehouse', 'pawnshop', 'rainy-night'),
  [int]$Concurrency = 4
)

$ErrorActionPreference = 'Continue'
# 经 -File 调用时 -Scenes a,b 会作为一个字符串传入，按逗号拆开。
$Scenes = @($Scenes | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
# 文件存为带 BOM 的 UTF-8，Windows PowerShell 5.1 才能正确读中文；控制台与日志也用 UTF-8。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
if (-not $env:DEEPSEEK_API_KEY) {
  Write-Error '请先设置 $env:DEEPSEEK_API_KEY'
  exit 1
}

$exp = 'm0/experiments/deepseek.yaml'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dir = "m0/runs/batch-$stamp"
$log = "$dir.log"
New-Item -ItemType Directory -Force $dir | Out-Null

$curves = @{
  'warehouse'   = '前两轮试探，第四轮爆发，之后收束'
  'pawnshop'    = '前五轮试探压价，第八轮翻脸，之后收束'
  'rainy-night' = '前五轮冷对，第十轮爆发，之后和解或决裂'
}

$steps = foreach ($name in $Scenes) {
  $file = "m0/scenes/$name.yaml"
  @{ title = "实验组 $file"; key = "$name-plain"; args = @('run', $file, '--runs', '3', '--parallel', '3') }
  @{ title = "导演（僵局后） $file"; key = "$name-stalemate"; args = @('run', $file, '--runs', '3', '--parallel', '3', '--director', 'stalemate') }
  @{ title = "导演（张力曲线） $file"; key = "$name-curve"; args = @('run', $file, '--runs', '3', '--parallel', '3', '--director', 'curve', '--curve', $curves[$name]) }
  @{ title = "对照组 $file"; key = "$name-baseline"; args = @('baseline', $file, '--runs', '3') }
}

# 子作业继承本进程的环境变量（含 API Key），Key 不写进任何参数或日志。
$job = {
  param($root, $stepArgs, $exp, $out)
  Set-Location $root
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  pnpm m0 @stepArgs --experiment $exp --yes 2>&1 | ForEach-Object { "$_" | Out-File -FilePath $out -Append -Encoding utf8; "$_" }
}

$running = @()
foreach ($s in $steps) {
  while (@($running | Where-Object { $_.State -in 'Running', 'NotStarted' }).Count -ge $Concurrency) { Start-Sleep -Seconds 5 }
  $out = "$dir/$($s.key).log"
  "===== $($s.title) =====" | Out-File -FilePath $out -Encoding utf8
  Write-Output "开始：$($s.title)"
  $running += Start-Job -Name $s.key -ScriptBlock $job -ArgumentList (Get-Location).Path, $s.args, $exp, $out
}

# 运行中把各作业的输出转到控制台，便于观察。
while (@($running | Where-Object { $_.State -in 'Running', 'NotStarted' }).Count -gt 0) {
  foreach ($j in $running) { Receive-Job $j | ForEach-Object { Write-Output "[$($j.Name)] $_" } }
  Start-Sleep -Seconds 5
}
foreach ($j in $running) { Receive-Job $j | ForEach-Object { Write-Output "[$($j.Name)] $_" } }
$running | Remove-Job

foreach ($s in $steps) { Get-Content "$dir/$($s.key).log" -Encoding utf8 | Out-File -FilePath $log -Append -Encoding utf8; '' | Out-File -FilePath $log -Append -Encoding utf8 }
"全部完成，日志：$log" | Out-File -FilePath $log -Append -Encoding utf8
Write-Output "全部完成，日志：$log"
