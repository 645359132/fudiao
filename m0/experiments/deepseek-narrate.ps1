# M0-13 评估样本：为 27 次有效推演各生成节拍表、候选稿与事件梗概（pnpm m0 narrate）。
# 视角与评估清单一致：仓库 shen_yan，当铺 lin_zhou，雨夜 a_qing。
# 当铺只用僵局判断第 3 版之后的重跑；雨夜“僵局后导演”用补跑的那一次替换被提前结束的运行。
# 先在同一个 PowerShell 窗口里设置 $env:DEEPSEEK_API_KEY，再在仓库根目录运行：
#   powershell -ExecutionPolicy Bypass -File m0/experiments/deepseek-narrate.ps1
# 第二轮起用 -BatchLog 指定批量实验的日志（可给多个，用逗号分隔），从中读出运行标识（场景取自各运行的摘要，只取已结束的运行）：
#   powershell -ExecutionPolicy Bypass -File m0/experiments/deepseek-narrate.ps1 -BatchLog m0/runs/batch-<时间>.log
# 已有候选稿的运行自动跳过，中断后重新运行即可续上。

param([int]$Concurrency = 6, [string[]]$BatchLog = @())

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
if (-not $env:DEEPSEEK_API_KEY) {
  Write-Error '请先设置 $env:DEEPSEEK_API_KEY'
  exit 1
}

$exp = 'm0/experiments/deepseek.yaml'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dir = "m0/runs/narrate-$stamp"
$log = "$dir.log"
New-Item -ItemType Directory -Force $dir | Out-Null

$pov = @{ 'warehouse' = 'shen_yan'; 'pawnshop' = 'lin_zhou'; 'rainy-night' = 'a_qing' }
$runs = [ordered]@{
  'warehouse'   = @(
    '01M4DY0C39CQHQZG44DTWS1GAP', '01M4DY0C3A7NPYWS3T4CVZYST1', '01M4DY0C3A6N82YKANX3Q0Y7ZN',
    '01M4DY4VNCC2ZGPY2TTW8HPMTJ', '01M4DY4VND1540K19H6GZSACZF', '01M4DY4VNDZAH62B13K7GEP5GX',
    '01M4DY8K5D3E1V3PB89RXQ4P8P', '01M4DY8K5ETY6KA8QFK1A549YE', '01M4DY8K5F1CD2BMFRW0J0WXN8')
  'pawnshop'    = @(
    '01M4F7RSNB40JCBDF0SEQHQAZ6', '01M4F7RSNCX6HXE0YTDK65B25E', '01M4F7RSNCX6N19ZV07QQWNWNF',
    '01M4FA0XXYJQ2WHV5BS5DWS9E4', '01M4FA0XXZK1YTDRY87FVZ4H8P', '01M4FA0XXZ8ENRTH8NEBG1EW2N',
    '01M4FBWCP92AQX2X0BP1WSBV95', '01M4FBWCPBS4MR8JY16VVH27ZE', '01M4FBWCPBXG7NEW33J0P3XJFN')
  'rainy-night' = @(
    '01M4E3XFEYV3QF0GCJTPC5PZPW', '01M4E3XFEYMQWGFNZVMGTB9AZ7', '01M4E3XFEYX4ASPCR6SC55JPMX',
    '01M4E5GEBEQ93TRN8JNTY871GC', '01M4E5GEBFSKV5F51GF41QC29P', '01M4FE7PXY0MAV0NHT42H6SNG2',
    '01M4F4XKZ2DCAEPCTBB3GEMB4Z', '01M4F4XKZ3F6AKJSMBYN2W4SNG', '01M4F4XKZ3J051N6YX803A0FR6')
}

# 经 -File 调用时 -BatchLog a,b 会作为一个字符串传入，按逗号拆开。
$BatchLog = @($BatchLog | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
if ($BatchLog.Count -gt 0) {
  $runs = [ordered]@{ 'warehouse' = @(); 'pawnshop' = @(); 'rainy-night' = @() }
  $ids = Select-String -Path $BatchLog -Pattern '运行 (\w+) 开始' -Encoding utf8 | ForEach-Object { $_.Matches[0].Groups[1].Value } | Select-Object -Unique
  foreach ($id in $ids) {
    $summary = "m0/runs/$id/summary.json"
    if (-not (Test-Path $summary)) { Write-Output "跳过 $id（没有摘要，运行未结束）"; continue }
    $info = Get-Content $summary -Raw -Encoding utf8 | ConvertFrom-Json
    if ($info.phase -ne 'Ended') { Write-Output "跳过 $id（$($info.phase)：$($info.pause)）"; continue }
    $scene = [System.IO.Path]::GetFileNameWithoutExtension($info.scene)
    if ($runs.Contains($scene)) { $runs[$scene] += $id }
  }
}

# 子作业继承本进程的环境变量（含 API Key），Key 不写进任何参数或日志。
$job = {
  param($root, $id, $who, $exp, $out)
  Set-Location $root
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  pnpm m0 narrate $id --pov $who --experiment $exp --yes 2>&1 | ForEach-Object { "$_" | Out-File -FilePath $out -Append -Encoding utf8; "$_" }
}

$running = @()
foreach ($scene in $runs.Keys) {
  foreach ($id in $runs[$scene]) {
    $who = $pov[$scene]
    if (Test-Path "m0/runs/$id/narration-$who/text.md") {
      Write-Output "跳过 $id（已有 $who 视角的候选稿）"
      continue
    }
    while (@($running | Where-Object { $_.State -in 'Running', 'NotStarted' }).Count -ge $Concurrency) { Start-Sleep -Seconds 5 }
    $out = "$dir/$id.log"
    "===== $scene $id $who =====" | Out-File -FilePath $out -Encoding utf8
    Write-Output "开始：$scene $id"
    $running += Start-Job -Name $id -ScriptBlock $job -ArgumentList (Get-Location).Path, $id, $who, $exp, $out
  }
}

while (@($running | Where-Object { $_.State -in 'Running', 'NotStarted' }).Count -gt 0) {
  foreach ($j in $running) { Receive-Job $j | ForEach-Object { Write-Output "[$($j.Name)] $_" } }
  Start-Sleep -Seconds 5
}
foreach ($j in $running) { Receive-Job $j | ForEach-Object { Write-Output "[$($j.Name)] $_" } }
$running | Remove-Job

Get-ChildItem "$dir/*.log" | ForEach-Object { Get-Content $_ -Encoding utf8 | Out-File -FilePath $log -Append -Encoding utf8 }
"全部完成，日志：$log" | Out-File -FilePath $log -Append -Encoding utf8
Write-Output "全部完成，日志：$log"
