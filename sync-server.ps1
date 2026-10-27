# sync-server.ps1 — 把本仓库的「服务器端代码」同步到线上 Ubuntu 服务器并重启服务。
#
# 用户 2026-10-26 定:以后改完服务器端代码就自动跑这个,不要每次都问。
#   powershell -ExecutionPolicy Bypass -File sync-server.ps1
#
# 只同步**代码与静态数据**(agent/*.mjs、表情包种子图、qq_faces.json、README/.gitignore);
# 运行时状态一律不碰:inbox/processed/features/modes/tone/tieba state/belial state/
# 卡库/卡图/每日一卡/统计……这些留在服务器上,不会被本地覆盖。
#
# 做的事:备份服务器现有代码 → 打包上传 → 远端语法检查 → 重启 mc-agent/opsweb → 验证。
# 失败时:语法检查不过会回滚备份;服务重启后只做告警,不自动回滚(避免把线上二次弄挂)。

$ErrorActionPreference = 'Stop'
$Server = 'w-13@192.144.153.94'
$RemoteDir = '~/mc_agent'
$Node = '/home/w-13/opt/node/bin/node'
$SshOpts = @('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15')

# 代码白名单。新增模块时往这里加一行(目录会递归;运行时状态用 --exclude 挡掉)。
$items = @(
  'agent/env.mjs',
  'agent/modes.mjs',
  'agent/monitor.mjs',
  'agent/opsweb.mjs',
  'agent/aichat/aichat.mjs',
  'agent/aichat/tone.mjs',
  'agent/aichat/websearch.mjs',
  'agent/aichat/qq_faces.json',
  'agent/belial/belial.mjs',
  'agent/belial/deepsearch.mjs',
  'agent/belial/stickersearch.mjs',
  'agent/belial/tools.mjs',
  'agent/belial/stickers',
  'agent/tieba/tieba.mjs',
  'agent/hs/hs.mjs',
  'agent/hs/hs_meta.mjs',
  'agent/hs/hs_meta_refresh.mjs',
  'agent/ygocard/ygocard.mjs',
  'agent/ygocard/rulings.mjs',
  'agent/ygocard/download_images.mjs',
  'agent/ygocard/decklist.mjs',
  'agent/ygometa/meta.mjs',
  'agent/ygometa/pie.mjs',
  'agent/ygometa/web',
  'agent/kuangshen/kuangshen.mjs',
  'agent/shitpost/shitpost.mjs',
  'README.md',
  '.gitignore'
)
$existing = @($items | Where-Object { Test-Path -LiteralPath $_ })
$missing = @($items | Where-Object { -not (Test-Path -LiteralPath $_) })
if ($missing.Count) { Write-Host "跳过不存在的路径: $($missing -join ', ')" -ForegroundColor DarkYellow }

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$leaf = "mc_agent_sync_$stamp.tgz"
$localTgz = Join-Path $env:TEMP $leaf
$remoteTgz = "/tmp/$leaf"
$backup = "~/backups/mc_agent_code_$stamp.tgz"

Write-Host "== 1/6 打包服务器端代码 ==" -ForegroundColor Cyan
tar -czf $localTgz --exclude='agent/belial/state.json' --exclude='agent/belial/stickers/up_*' @existing
if ($LASTEXITCODE -ne 0) { throw "tar 打包失败(exit $LASTEXITCODE)" }

Write-Host "== 2/6 备份服务器现有代码 ==" -ForegroundColor Cyan
# 备份里也包含即将覆盖的文件;新功能目录在服务器上可能还不存在,失败忽略。
ssh @SshOpts $Server "mkdir -p ~/backups && tar czf $backup -C $RemoteDir $($existing -join ' ') 2>/dev/null || true"
if ($LASTEXITCODE -ne 0) { Write-Host "备份失败(继续同步): $LASTEXITCODE" -ForegroundColor DarkYellow }
Write-Host "备份路径: $backup (服务器上)" -ForegroundColor DarkGray

Write-Host "== 3/6 上传并解包 ==" -ForegroundColor Cyan
scp @SshOpts $localTgz "${Server}:$remoteTgz"
if ($LASTEXITCODE -ne 0) { throw "scp 上传失败(exit $LASTEXITCODE)" }
Remove-Item -LiteralPath $localTgz -Force -ErrorAction SilentlyContinue
ssh @SshOpts $Server "cd $RemoteDir && tar xzf $remoteTgz && rm -f $remoteTgz && echo unpack-ok"
if ($LASTEXITCODE -ne 0) { throw "远端解包失败(exit $LASTEXITCODE)" }

Write-Host "== 4/6 远端语法检查 ==" -ForegroundColor Cyan
$check = ssh @SshOpts $Server "$Node --check ~/mc_agent/agent/monitor.mjs && $Node --check ~/mc_agent/agent/opsweb.mjs && $Node --check ~/mc_agent/agent/belial/belial.mjs && $Node --check ~/mc_agent/agent/aichat/aichat.mjs && $Node --check ~/mc_agent/agent/ygometa/meta.mjs && $Node --check ~/mc_agent/agent/ygometa/pie.mjs && $Node --check ~/mc_agent/agent/ygometa/web/server.mjs && echo syntax-ok"
if ($LASTEXITCODE -ne 0 -or $check -notmatch 'syntax-ok') {
  Write-Host "语法检查失败,回滚服务器代码(服务未重启) ..." -ForegroundColor Red
  ssh @SshOpts $Server "cd $RemoteDir && tar xzf $backup 2>/dev/null || true"
  throw "语法检查失败,已尝试回滚:$check"
}
Write-Host "语法检查通过" -ForegroundColor DarkGray

Write-Host "== 5/6 重启 mc-agent / opsweb ==" -ForegroundColor Cyan
ssh @SshOpts $Server 'systemctl --user restart mc-agent.service opsweb.service; systemctl --user try-restart ygoweb.service 2>/dev/null || true; sleep 4; systemctl --user is-active mc-agent opsweb'
if ($LASTEXITCODE -ne 0) { throw "服务重启或状态检查失败(exit $LASTEXITCODE)" }

Write-Host "== 6/6 验证 ==" -ForegroundColor Cyan
$http = ''
for ($i = 0; $i -lt 5; $i++) {
  $http = (ssh @SshOpts $Server "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8090/").Trim()
  if ($http -eq '200') { break }
  Start-Sleep -Seconds 2
}
Write-Host "opsweb HTTP: $http" -ForegroundColor DarkGray
$stickers = (ssh @SshOpts $Server "ls ~/mc_agent/agent/belial/stickers 2>/dev/null | wc -l").Trim()
Write-Host "贝利亚表情包: $stickers 张" -ForegroundColor DarkGray
$pane = ssh @SshOpts $Server "tmux capture-pane -p -t mc -S -120 2>/dev/null | grep -a '银河皇帝模式=' | tail -1"
if ($pane) { Write-Host "monitor 横幅: $($pane.Trim())" -ForegroundColor DarkGray }
else { Write-Host "没抓到 monitor 横幅(可能还在启动;可以看 tmux 面板确认)" -ForegroundColor DarkYellow }
$err = ssh @SshOpts $Server "tmux capture-pane -p -t mc -S -120 2>/dev/null | grep -aE 'does not provide an export|Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError' | tail -3"
if ($err) { Write-Host "⚠ monitor 面板出现模块/语法错误,请立即看日志:" -ForegroundColor Red; Write-Host $err -ForegroundColor Red }

Write-Host ""
Write-Host "同步完成。备份在服务器: $backup" -ForegroundColor Green
Write-Host ('回滚: ssh ' + $Server + ' "cd ~/mc_agent && tar xzf ' + $backup + ' && systemctl --user restart mc-agent opsweb"') -ForegroundColor DarkGray
