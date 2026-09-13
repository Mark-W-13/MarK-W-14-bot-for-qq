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
try {
  for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* 没有 .env(纯净检出 / 未配置)不影响运行:走 env 或代码里的默认值 */ }

/** .env 路径(排查用) */
export const envPath = () => ENV_PATH;

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
