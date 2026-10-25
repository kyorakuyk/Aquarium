# 向正在运行的 SnowLuma 调用一次 OneBot 的 fetch_sys_faces，把结果存到 data\sys-faces.json
# 只读：不启动、不重启 SnowLuma/QQ；token 只在内存里用，不打印、不写文件。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
$vars = @{}
Get-Content $envFile -Encoding UTF8 | ForEach-Object {
  if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $vars[$Matches[1]] = $Matches[2].Trim() }
}
$cfgPath = Join-Path $vars['SNOWLUMA_DIR'] ("config\onebot_" + $vars['BOT_UIN'] + ".json")
$server = (Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json).networks.wsServers[0]
$wsHost = if ($server.host -in @('0.0.0.0', '::', '')) { '127.0.0.1' } else { $server.host }
$path = if ($server.path) { $server.path } else { '/' }
$uri = [Uri]("ws://" + $wsHost + ":" + $server.port + $path)
Write-Host "连接 $uri ..."

$ws = New-Object System.Net.WebSockets.ClientWebSocket
if ($server.accessToken) { $ws.Options.SetRequestHeader('Authorization', 'Bearer ' + $server.accessToken) }
$ct = [Threading.CancellationToken]::None
$ws.ConnectAsync($uri, $ct).Wait()

$req = '{"action":"fetch_sys_faces","params":{"refresh":true},"echo":"faces"}'
$bytes = [Text.Encoding]::UTF8.GetBytes($req)
$ws.SendAsync([ArraySegment[byte]]$bytes, 'Text', $true, $ct).Wait()

$buf = New-Object byte[] 65536
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  $ms = New-Object IO.MemoryStream
  do {
    $r = $ws.ReceiveAsync([ArraySegment[byte]]$buf, $ct).Result
    $ms.Write($buf, 0, $r.Count)
  } while (-not $r.EndOfMessage)
  $text = [Text.Encoding]::UTF8.GetString($ms.ToArray())
  if ($text -match '"echo"\s*:\s*"faces"') {
    $out = Join-Path $root 'data\sys-faces.json'
    [IO.File]::WriteAllText($out, $text, (New-Object Text.UTF8Encoding $false))
    Write-Host "好了，已保存到 $out"
    $ws.Dispose()
    return
  }
}
$ws.Dispose()
Write-Host '20 秒内没收到回复。SnowLuma 在运行吗？'
