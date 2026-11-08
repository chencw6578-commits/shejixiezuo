# 预览通道守护：保证 localhost:4000 与公网隧道可用
# 规则（团队硬性约束）：只结束本脚本记录的 PID，禁止按进程名批量杀
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools/preview-guard.ps1
param([switch]$Once)
$ErrorActionPreference = 'SilentlyContinue'

$rt   = 'D:\Backup\Documents\Trae-CN\temp_20261107_01\_runtime'
$srv  = 'D:\Backup\Documents\Trae-CN\temp_20261107_01\shejixiezuo\server'
$pgBin = Join-Path $rt 'pg\bin\bin'
$pgData = Join-Path $rt 'pg\data'
$cfLog = Join-Path $rt 'logs\cloudflared.log'
$cfPidFile = Join-Path $rt 'cloudflared.pid'
$srvPidFile = Join-Path $rt 'server.pid'
$urlFile = Join-Path $rt 'tunnel-url.txt'
$urlFile2 = Join-Path $rt 'tunnel-url-cf.txt'
$eventLog = Join-Path $rt 'logs\guard-events.log'

New-Item -ItemType Directory -Force -Path (Join-Path $rt 'logs') | Out-Null

# 单实例：计划任务每分钟触发一次，已有守护在跑就直接退出
$lockFile = Join-Path $rt 'guard.lock'
if (Test-Path $lockFile) {
  $old = (Get-Content $lockFile -Raw).Trim()
  if ($old -match '^\d+$' -and (Get-Process -Id ([int]$old) -ErrorAction SilentlyContinue)) { exit }
}
Set-Content $lockFile $PID
Register-EngineEvent PowerShell.Exiting -Action { Remove-Item $lockFile -Force -ErrorAction SilentlyContinue } | Out-Null

function Log($msg) { Add-Content -Path $eventLog -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) -Encoding UTF8 }
function PortOpen($p) { return (Test-NetConnection -ComputerName 127.0.0.1 -Port $p -WarningAction SilentlyContinue).TcpTestSucceeded }
function HttpStatus($u) { try { return (Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 8).StatusCode } catch { return 0 } }

function KillRecorded($pidFile, $tag) {
  if (-not (Test-Path $pidFile)) { return }
  $id = (Get-Content $pidFile -Raw).Trim()
  if ($id -match '^\d+$') {
    $p = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue
    if ($p) { Log "$tag 结束自己记录的残留 PID $id"; Stop-Process -Id ([int]$id) -Force }
  }
  Remove-Item $pidFile -Force
}

function EnsurePostgres {
  if (PortOpen 5433) { return }
  Log 'postgres 未监听，启动中'
  & (Join-Path $pgBin 'pg_ctl.exe') start -D $pgData -l (Join-Path $rt 'pg\pg.log') -w -t 40 | Out-Null
  Start-Sleep -Seconds 2
}

function EnsureServer {
  if ((HttpStatus 'http://localhost:4000/api/health') -eq 200) { return }
  Log 'server 健康检查失败，重启中'
  KillRecorded $srvPidFile 'server'
  $p = Start-Process -FilePath 'node' -ArgumentList 'dist/index.js' -WorkingDirectory $srv -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $rt 'logs\server.out.log') `
    -RedirectStandardError  (Join-Path $rt 'logs\server.err.log')
  if ($p) { Set-Content $srvPidFile $p.Id }
  Start-Sleep -Seconds 6
}

function ReadTunnelUrl {
  # 优先问 cloudflared 的 metrics 接口（权威，避免日志里多个进程并发写导致读到过期地址）
  try {
    $j = (Invoke-WebRequest -Uri 'http://127.0.0.1:20241/quicktunnel' -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
    if ($j.hostname) { return 'https://' + $j.hostname }
  } catch { }
  if (-not (Test-Path $cfLog)) { return '' }
  $m = Select-String -Path $cfLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches | Select-Object -Last 1
  if ($m) { return $m.Matches[-1].Value }
  return ''
}

# 已有隧道在跑时，用它的真实启动时间作为宽限期起点（守护重启不会误伤健康隧道）
$runningTunnel = Get-Process -Name cloudflared -ErrorAction SilentlyContinue | Select-Object -First 1
if ($runningTunnel) { $tunnelStartedAt = $runningTunnel.StartTime } else { $tunnelStartedAt = (Get-Date).AddMinutes(-10) }

function EnsureTunnel {
  $running = Get-Process -Name cloudflared -ErrorAction SilentlyContinue
  if ($running) { return }
  Log 'cloudflared 不在了，重新拉隧道'
  KillRecorded $cfPidFile 'cloudflared'
  $p = Start-Process -FilePath (Join-Path $rt 'cloudflared.exe') `
    -ArgumentList 'tunnel','--url','http://localhost:4000','--logfile',$cfLog `
    -PassThru -WindowStyle Hidden
  if ($p) { Set-Content $cfPidFile $p.Id }
  $script:tunnelStartedAt = Get-Date
  for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 2
    $u = ReadTunnelUrl
    if ($u) {
      if ((Get-Content $urlFile -Raw -ErrorAction SilentlyContinue).Trim() -ne $u) {
        Set-Content $urlFile $u
        Set-Content $urlFile2 $u
        Log "隧道地址已更新：$u"
      }
      return
    }
  }
  Log '隧道启动 90 秒内未拿到地址'
}

function SyncUrlFile {
  $live = ReadTunnelUrl
  if (-not $live) { return }
  $cur = (Get-Content $urlFile -Raw -ErrorAction SilentlyContinue).Trim()
  if ($live -eq $cur) { return }
  Set-Content $urlFile $live
  Set-Content $urlFile2 $live
  Log "隧道地址已更新：$live"
}

Log '守护启动'
while ($true) {
  EnsurePostgres
  EnsureServer
  EnsureTunnel
  SyncUrlFile
  $u = (Get-Content $urlFile -Raw -ErrorAction SilentlyContinue).Trim()
  # 新建隧道有 30~60 秒的 Cloudflare 侧传播期，90 秒内不做「不可达」判定，避免反复重拉、地址乱跳
  $warm = ((Get-Date) - $tunnelStartedAt).TotalSeconds -lt 90
  if ($u -and -not $warm -and (HttpStatus "$u/api/health") -ne 200) {
    Log "隧道地址 $u 不可达，重连"
    KillRecorded $cfPidFile 'cloudflared'
    Start-Sleep -Seconds 2
    EnsureTunnel
  }
  if ($Once) { break }
  Start-Sleep -Seconds 30
}
