# 迁移到 Ubuntu 服务器方案(实际落地版)

> 初版写于 2026-09-08,当时假设「有 root + 用 Docker」。
> **本文档已于 2026-09-11 按实际落地形态重写** —— 真实情况是 `w-13` 账号无 sudo,
> 因此改走「纯用户态 + 一次 setcap」。原方案的 Docker 路线未采用,原因见第 2 节。
>
> 本文用途:① 记录现状 ② 服务器重装时照着复现。

---

## 一、实际形态总览

```
腾讯云 Ubuntu 24.04(2 核 / 1.9GB 内存 / 40GB 盘)—— 共享机器,非独占
└── /home/w-13/            ← 全部在用户态,不需要 root
    ├── opt/node/          Node v24.14.0(官方 tarball 解包)
    ├── opt/snowluma/      SnowLuma v1.14.15(免 Docker 包,自带 Node v22.13.0)
    │   └── config/        onebot.json + onebot_<uin>.json + runtime.json
    ├── opt/xvfb-root/     Xvfb(dpkg-deb -x 从 xvfb.deb 解包)
    ├── opt/qqroot/        Linux QQ 解包副本(被 /opt/QQ 正式安装取代,可删)
    ├── mc_agent/          git 仓库部署位
    │   └── agent/opsweb.mjs   运维 WebUI
    ├── .claude/           Claude CLI 网关配置(600)
    ├── .config/systemd/user/  5 个用户级 unit
    └── ops/bot            命令行运维小助手
└── /opt/QQ/               Linux QQ 3.2.32(root 正规安装,唯一需要 root 的产物之一)
```

**进程托管**:`systemctl --user`(该账号 `Linger=yes` 已由机主开启 → 开机自启 + 退出登录不停)。
**访问**:OneBot 与各 WebUI 全部只绑 `127.0.0.1`,一律走 SSH 隧道,公网零暴露。

| 服务 | 作用 | 端口 |
|---|---|---|
| `xvfb` | 虚拟显示 `:99` | — |
| `snowluma` | QQ 协议桥接 → OneBot | 3000 / 3001 / 5099 |
| `qq` | Linux QQ 客户端 | — |
| `mc-agent` | monitor(tmux 会话 `mc` 内运行) | — |
| `opsweb` | 运维 WebUI | 8090 |

---

## 二、为什么没用 Docker(调研结论,勿重复踩)

初版方案的核心是「Docker 跑 SnowLuma 官方镜像」。实际这台机器上**走不通**:

1. `w-13` **不在 sudoers 里**(`w-13 is not in the sudoers file`),装不了 docker。
2. **rootless Docker 也不行**:`unshare -U` 报 `Operation not permitted` —— 内核禁用了
   unprivileged user namespaces,且 `newuidmap` 缺失且需 root 安装。
3. 初版方案里 apt 装的 xvfb / ttyd / nodejs / 字体,一律装不了。

**替代路径(已全部验证可行)**:

| 原本要 root 的事 | 用户态替代 |
|---|---|
| Docker 镜像 | 官方 **Linux x64 免 Docker 压缩包**(自带 Node,`launcher.sh` 直接跑) |
| `apt install xvfb` | `apt-get download xvfb` + `dpkg-deb -x` 解包到 `$HOME`(实测依赖零缺失) |
| 系统级 systemd | `systemctl --user`(linger 已开,效果等同) |
| nginx 反代 + TLS | 不需要:服务只绑回环,SSH 隧道本身就带加密与鉴权 |
| 绑定 80/443 | 不需要:用 8090 等高位端口 |

---

## 三、唯一需要 root 的三条命令

SnowLuma 的 native addon **通过 ptrace 把 hook 注入 QQ 进程**,而本机 `ptrace_scope=2`
(admin-only),`w-13` 的 `CapEff=0` —— 所以必须给 node 二进制一个文件 capability:

```bash
# 1) 注入 hook 必需。官方 Docker 镜像内部做的就是这件事
#    (Dockerfile 里:setcap cap_sys_ptrace+ep /usr/local/bin/node)
sudo setcap cap_sys_ptrace=ep /home/w-13/opt/snowluma/node

# 2) 正规安装 Linux QQ:装到 /opt/QQ,root 属主,chrome-sandbox 自动配好 4755
sudo apt-get install -y /home/w-13/dl/QQ_3.2.32_260812_amd64_01.deb

# 3) 冻结 QQ 静默热更新。hook 是按 QQ 版本对齐的,后台热更会把 hook 悄悄打坏
echo "0.0.0.0 qqpatch.gtimg.cn" | sudo tee -a /etc/hosts
```

这三条**不授予 `w-13` 任何通用权限**:`setcap` 只作用于那一个文件,随时 `setcap -r` 撤销。

### ⚠️ setcap 的两个坑(踩过)

1. **capability 在 `exec()` 时才生效** —— setcap 之后**必须重启 snowluma 服务**,
   否则那个已经在跑的进程仍然没有能力。症状:`[Hook] load failed: ... [COMPONENT_LOAD_FAILED]`。
   我第一次就撞上了:用 `node -e` 测明明有 capability,但服务照旧注入失败。
   验证方式:`~/opt/snowluma/node -e "console.log(require('fs').readFileSync('/proc/self/status','utf8').match(/CapEff.*/)[0])"`
   期望 `CapEff` 含 bit19(`0000000000080000`)。
2. **升级/替换 node 二进制会丢 capability** → **别动 `~/opt/snowluma/node`**。真升了要重新 setcap。

---

## 四、从零复现步骤

```bash
# ── 0. 前置:机主执行第三节那 3 条 ──

# ── 1. 用户态 Node ──
cd ~/dl
curl -fL -o node.tar.xz https://registry.npmmirror.com/-/binary/node/v24.14.0/node-v24.14.0-linux-x64.tar.xz
mkdir -p ~/opt && tar -xJf node.tar.xz -C ~/opt && mv ~/opt/node-v24.14.0-linux-x64 ~/opt/node
echo 'export PATH="$HOME/opt/node/bin:$HOME/.local/bin:$PATH"' >> ~/.profile

# ── 2. claude CLI + 网关 ──
npm config set prefix ~/.local
npm config set registry https://registry.npmmirror.com
npm i -g @anthropic-ai/claude-code
# 复刻本机 ~/.claude/settings.json 的 env 段(BASE_URL / AUTH_TOKEN / 模型映射),chmod 600

# ── 3. Xvfb(免 root 解包) ──
apt-get download xvfb xserver-common xfonts-base
for d in ~/dl/*.deb; do dpkg-deb -x "$d" ~/opt/xvfb-root; done
~/opt/xvfb-root/usr/bin/Xvfb :99 -screen 0 1280x800x24 &

# ── 4. SnowLuma ──
#    国内直连 GitHub Release 会卡死,用加速镜像
curl -fL -o snowluma.tar.gz \
  https://gh-proxy.com/https://github.com/SnowLuma/SnowLuma/releases/download/v1.14.15/SnowLuma-v1.14.15-linux-x64.tar.gz
#    ⚠ 务必校验:从 api.github.com 取官方 digest 比对 sha256
mkdir -p ~/opt/snowluma && tar -xzf snowluma.tar.gz -C ~/opt/snowluma

# ── 5. QQ ──
#    ⚠ 不要凭空猜版本号。官方下载页是 JS 渲染的,从 SnowLuma 的 Docker 仓库取准确版本:
#    https://api.github.com/repos/SnowLuma/SnowLuma.Docker.Framework/contents/Dockerfile
#    里面 QQ_VERSION / QQ_BASE_URL / QQ_CHANNEL / QQ_AMD64_SHA256 就是要的东西
#    本次:QQ_3.2.32_260812_amd64_01.deb,官方 CDN 直链,sha256 校验通过
curl -fL -o QQ.deb 'https://qqdl.gtimg.cn/qqfile/QQNT/9.9.33/release/3f89efc5/QQ_3.2.32_260812_amd64_01.deb'
#    校验后由机主 apt install(第三节第 2 条)

# ── 6. 部署仓库 + 数据 ──
#    代码走 mc_agent-migrate 工作树(分支 migrate-ubuntu)打包上传;
#    数据:cards.json / kuangshen / shitpost / daily_card / features / inbox / processed
#    卡图不必上传 —— 服务器端 `node download_images.mjs` 重建(实测 ~15 分钟,14249 张)

# ── 7. 配 OneBot token 与 .env ──
#    config/onebot.json 里 accessToken 与 agent/.env 的 WS_TOKEN/API_TOKEN 必须一致
#    host 写 127.0.0.1(默认是 0.0.0.0,共享机器上别用默认)

# ── 8. 用户级 unit + 起服务 ──
mkdir -p ~/.config/systemd/user
#    xvfb / snowluma / qq / mc-agent / opsweb 五个 unit(见仓库 opsweb.service 等)
systemctl --user daemon-reload
systemctl --user enable --now xvfb snowluma qq mc-agent opsweb
```

---

## 五、运维

### 运维 WebUI(推荐)

```bash
ssh -N -L 8090:127.0.0.1:8090 w-13@192.144.153.94
# 浏览器 http://127.0.0.1:8090,令牌见 agent/.env 的 OPSWEB_TOKEN
```
看状态 / 切搬屎·语录 / 重启服务 / 更新卡库 / 看 QQ 截图 / 看日志。

**切开关走 `tmux send-keys` 敲 monitor 自己的面板**,所以 monitor.mjs 零改动、
即时生效零重启。代价是依赖 tmux 会话,已用「切完回读 features.json 校验」兜底。

### 命令行

```bash
~/ops/bot status     # 总览
~/ops/bot attach     # 进面板(按键 1/2/h/u/q/Q;离开用 Ctrl-b 再按 d,别按 q)
~/ops/bot log        # 看日志
~/ops/bot on shit    # 开搬屎(off 关;ks = 框神语录)
```

### 关键注意

- **直接改 `agent/features.json` 文件对运行中的 monitor 不生效**(启动时读一次),
  要走面板按键或 WebUI。
- monitor **不写日志文件**,只有 stdout → 日志与 WS 状态是从 tmux 面板抓的。
- `tmux history-limit` 已设 20000;它只在**创建会话时**生效,改完要重启 `mc-agent`。

---

## 六、风险与取舍

| 项 | 说明 |
|---|---|
| **共享机器** | 同机还有他人服务(openclaw、browser-VNC、onelegocg.top)。本 bot 全部文件在 `/home/w-13` 下,未触碰他人资源;反之他人的调整也可能波及本 bot |
| **内存** | 1.9GB 总量,全栈跑起来约 1.1GB,剩 ~900MB。够用但不宽裕 |
| **setcap 单点** | 唯一的特权依赖,且挂在 node 二进制上(见第三节的坑) |
| **QQ 登录态** | 存在 `~/.config/QQ/`,重启不用重扫;QQ 侧风控下线则需重扫(用 WebUI 的 QQ 界面看状态) |
| **官方口径** | SnowLuma 文档明确写「Linux 手动部署属进阶/非官方路径」。本方案即属此类,升级 SnowLuma 版本时需重新验证 hook |
| **热更新屏蔽** | 依赖 `/etc/hosts` 那条;若被清理,QQ 静默热更可能打坏 hook |

---

## 七、与初版方案的差异

| 初版假设 | 实际 |
|---|---|
| Docker 跑官方镜像 | 免 Docker 压缩包 + 用户态 Xvfb |
| `apt install` 装依赖 | `dpkg-deb -x` 解包到家目录 |
| 系统级 systemd unit | `systemctl --user`(linger 已开) |
| nginx + 自签 TLS + Basic Auth 反代 | 全部只绑回环,SSH 隧道;opsweb 自带令牌登录 |
| ttyd 网页终端保留按键面板 | 运维 WebUI(走 tmux send-keys)+ `~/ops/bot attach` |
| 卡图 2.3GB 从 Windows 上传 | **服务器端重建**(省掉一次大上传) |
| 需要完整 root | 只需机主执行 3 条命令,其中 setcap 只作用于单个文件 |

初版里仍然有效、值得保留的判断:**协议层不换框架**(SnowLuma 的 OneBot v11 与私有扩展
表情反馈事件行为一致,monitor 逻辑零改动)、**Claude 出口走 dsv4 网关直连**、
**时区必须设 `Asia/Shanghai`**(每日一卡当日键依赖)。
