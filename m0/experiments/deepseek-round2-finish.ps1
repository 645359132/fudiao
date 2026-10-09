# M0-13 第二轮收尾（2026-10-10）：批量实验中途 DeepSeek 余额用尽，五次雨夜推演暂停；仓库“张力曲线导演”两次因导演模板第 3 版的格式问题暂停。
# 本脚本：续跑五次雨夜推演（已完成的调用按步骤键跳过，不重复计费）；续跑两次用导演模板第 4 版新建的仓库张力曲线导演（替换因格式问题暂停的两次）。
# 因模型服务出错（限流、余额不足）而暂停的运行，run --resume 会先恢复再继续。
# 余额不足时服务会降低并发上限，这里最多同时 3 个。
# 先给 DeepSeek 账户充值，再在同一个 PowerShell 窗口里设置 $env:DEEPSEEK_API_KEY，在仓库根目录运行：
#   powershell -ExecutionPolicy Bypass -File m0/experiments/deepseek-round2-finish.ps1
# 跑完后生成正文（两个日志都要给）：
#   powershell -ExecutionPolicy Bypass -File m0/experiments/deepseek-narrate.ps1 -BatchLog m0/runs/batch-20261009-221236.log,<本脚本的日志>

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
if (-not $env:DEEPSEEK_API_KEY) {
  Write-Error '请先设置 $env:DEEPSEEK_API_KEY'
  exit 1
}

$exp = 'm0/experiments/deepseek.yaml'
$log = "m0/runs/batch-finish-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
$resume = @('01M4GJFJMDM8F2V20JN8K778WP', '01M4GJFJMEJW9SVWP7TSKNJ0XD', '01M4GJR4XDGZ2QP4CVNEPPSQK8', '01M4GJR4XC1ESWJGENP1BDT06X', '01M4GJR4XDHEPR2JWYMEV7DN9F')

# 补跑的两次仓库张力曲线导演已在 2026-10-09 23:25 建立（导演模板第 4 版），因余额不足停在第 1 回合，同样续跑。
$warehouse = @('01M4GMADB0PZXSZDG09ND2T5AE', '01M4GMADB1H4K163TJKSTS5F5J')

$steps = @()
foreach ($id in $resume) {
  $steps += @{ title = "续跑 雨夜 $id"; args = @('run', 'm0/scenes/rainy-night.yaml', '--resume', $id) }
}
foreach ($id in $warehouse) {
  $steps += @{ title = "续跑 仓库 导演（张力曲线）$id"; args = @('run', 'm0/scenes/warehouse.yaml', '--resume', $id) }
}

# 子作业继承本进程的环境变量（含 API Key），Key 不写进任何参数或日志。
$job = {
  param($root, $stepArgs, $exp)
  Set-Location $root
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  pnpm m0 @stepArgs --experiment $exp --yes 2>&1 | ForEach-Object { "$_" }
}

$running = @()
foreach ($s in $steps) {
  while (@($running | Where-Object { $_.State -in 'Running', 'NotStarted' }).Count -ge 3) { Start-Sleep -Seconds 5 }
  "===== $($s.title) =====" | Out-File -FilePath $log -Append -Encoding utf8
  Write-Output "开始：$($s.title)"
  $running += Start-Job -ScriptBlock $job -ArgumentList (Get-Location).Path, $s.args, $exp
}
while (@($running | Where-Object { $_.State -in 'Running', 'NotStarted' }).Count -gt 0) {
  foreach ($j in $running) { Receive-Job $j | ForEach-Object { Write-Output $_; "$_" | Out-File -FilePath $log -Append -Encoding utf8 } }
  Start-Sleep -Seconds 5
}
foreach ($j in $running) { Receive-Job $j | ForEach-Object { Write-Output $_; "$_" | Out-File -FilePath $log -Append -Encoding utf8 } }
$running | Remove-Job
"全部完成，日志：$log" | Out-File -FilePath $log -Append -Encoding utf8
Write-Output "全部完成，日志：$log"
