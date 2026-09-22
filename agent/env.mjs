// 加载 agent/.env(含 token 等敏感配置;.env 被 .gitignore 排除,不入库)
//
// ⚠ **必须排在其它 import 之前** —— ESM 按 import 声明的顺序求值,而 .env 里那些值
//   (CHROME_PATH / API_TOKEN / BOT_ID …)是模块**顶层**常量要读的。放在后面加载的话,
//   顶层已经读完了,值永远是 undefined(只吃到代码里的默认值)。
//   2026-09-13 之前这段代码就写在 monitor.mjs 的 import 之后,踩到的真实故障:
//     · rulings.mjs / shitpost.mjs 顶层读 CHROME_PATH → 服务器上回退到 Windows 的 msedge
//       路径,完整裁定 PDF 与搬屎截图全挂在 `spawn C:/Program Files (x86)/.../msedge.exe ENOENT`;
//     · kuangshen.mjs 顶层读 API_TOKEN → 框神语录采集/回填没带鉴权。
//   所以:monitor.mjs 第一行 import 它,各模块自己跑 CLI 时也 import 它。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), '.env');

/**
 * 把 .env 灌进 process.env(**已存在的环境变量优先**,即真正的 env 能盖过文件)。
 * 返回灌进去的键名数组 —— **只给排查用,别把值打出来**(里面全是 key/token)。
 *
 * ⚠ 这是**唯一**的 .env 解析实现:opsweb.mjs 以前自己抄了一份,抄错了正则
 *   (`(.*)` + `\s*$`),而这个仓库的 .env 是 **CRLF** 的 —— 在 Node 24 上那条正则
 *   **一行都匹配不上**(实测:`"A=1\r".match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)` → null,
 *   因为 `\s*$` 撞上结尾的 `\r` 会回退失败)。后果是 opsweb 读不到 OPSWEB_TOKEN(登录直接废)、
 *   也读不到 ZHIPU_API_KEY(联网源被误判成零 key 的 bing),而 monitor 一切正常 —— 极难查。
 *   2026-09-21 定位并修:两边统一走这里,别再各写一份。
 */
export function loadEnvFile() {
  const loaded = [];
  try {
    for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || (m[1] in process.env)) continue;
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      loaded.push(m[1]);
    }
  } catch { /* 没有 .env(纯净检出 / 未配置)不影响运行:走 env 或代码里的默认值 */ }
  return loaded;
}
// ⚠ 只调这一次:**再调一次只会返回空数组**(键已经在 process.env 里,会被第 33 行的「已存在」跳过),
//   而那份「读到了哪些键」的清单只有这一次才拿得到 —— 2026-09-21 这里真被写成了调两次,
//   于是启动日志一直打「读入 0 个键」,又白查了一轮。
const loadedEnvKeys = loadEnvFile();

/** .env 路径(排查用) */
export const envPath = () => ENV_PATH;

/**
 * **本进程启动时从 .env 真正读进来的键名**(只有名字,没有值;值全是 token/key,不许打)。
 *
 * ⚠ 别以为「自己再调一次 loadEnvFile() 就能拿到这份清单」:本模块**一被 import 就自己读过了**,
 *   那时 .env 里的键已经进了 process.env,再调一次只会因为「已存在」而全部跳过、返回空数组。
 *   2026-09-21 就在 opsweb 上打出过误导人的「agent/.env: 读入 0 个键」,差点又去查一遍解析。
 */
export const envLoadedKeys = () => [...loadedEnvKeys];

/**
 * 无头浏览器(截图 / HTML → PDF):**延迟读** CHROME_PATH,别在模块顶层取值。
 * 平台默认值让没配 .env 的 CLI 自测也能跑起来:Windows = Edge,其余 = google-chrome。
 */
export function chromePath() {
  return process.env.CHROME_PATH
    || (process.platform === 'win32'
      ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
      : 'google-chrome');
}
