// 品牌配置读取：四级兜底（进程环境变量 > 项目根 .env > assemble.json 的 brand 段 > 内置默认）。
// 为什么要有兜底链：旧实现只读清单 brand 段，读不到就返回 null；渲染层（fragment-assembler）
// 遇到 null 不做替换，@brand:logo@ 这类占位符会原样显示在页面上（已知破相点）。
// 改成恒返回完整对象后，缺清单 / 缺 brand 段 / 缺某个键都不会再露出占位符。
//
// 取值优先级（高 → 低）：
//   1. process.env 的 BRAND_*（部署时最常用：不改文件就能换品牌）
//   2. <项目根>/.env 的 BRAND_*（零依赖解析，每个文件只解析一次）
//   3. <项目根>/assemble.json 的 brand 段（保留旧写法，额外键原样透传）
//   4. 内置默认值 DEFAULT_BRAND（前三级仍缺的字段用它补齐，displayTitle 回退 title）
//
// 下游 app.js 用法不变：
//   const { readBrand } = require("./config/brand");
//   const brandConf = readBrand(__dirname);   // __dirname = server/，项目根 = 上一级
//   ... createFragmentAssembler({ ..., brand: brandConf })
"use strict";

const fs = require("fs");
const path = require("path");

// 环境变量与 .env 用扁平大写键（dotenv 习惯），品牌对象与页面占位符用驼峰字段；
// 映射集中在这一处，避免两套命名在代码里各写一遍、改一处漏一处。
const ENV_KEY_MAP = {
  BRAND_TITLE: "title",
  BRAND_LOGO: "logo",
  BRAND_ICON: "icon",
  BRAND_DISPLAY_TITLE: "displayTitle",
};

// 内置默认值（第四级）：必须「安全可渲染」。
// logo / icon 取 favicon.png——三个下游项目的 public/ 下都有这个同名文件，
// 缺配置时页面至少不会出现碎图；模板层刻意不写死任何具体项目的品牌名，
// 否则 A 项目的标题会串到 B 项目的页面上。
const DEFAULT_BRAND = {
  title: "Downloader",
  logo: "favicon.png",
  icon: "favicon.png",
};

// .env 解析结果缓存：按 .env 绝对路径存，同一份文件在进程内只解析一次。
// 用 Map 而不是单个变量——同一进程可能先后对多个项目根调用 readBrand
// （例如主项目与测试建的临时项目并存），单值缓存会串项目。
const dotEnvCache = new Map();

// 判断品牌值是否「等于没配」：undefined / null / 空串 / 纯空白都算缺，交给下一级兜底。
// 好处：.env 里写了 BRAND_LOGO= 这种空值不会把清单或默认值顶掉，也不会渲染出坏图。
function isBlank(value) {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

// 解析 .env 文本为键值对象（零依赖，只支持最常见的 KEY=VALUE 形态）。
// 支持：注释行（# 开头）、空行、可选 export 前缀、单/双引号包裹的值、未加引号时的行内注释。
// 不支持：多行值、变量插值、转义序列——品牌配置只需要短字符串，保持实现简单可预测。
// 任何一行解析不出来都当「这一行没写」，绝不让 .env 写坏导致服务起不来。
function parseDotEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // 允许 export KEY=VALUE（有人习惯把 .env 当 shell 片段写）
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue; // 没有等号或键为空
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue; // 非法键名跳过，不猜测
    let value = body.slice(eq + 1).trim();
    const quote = value.charAt(0);
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.charAt(value.length - 1) === quote) {
      value = value.slice(1, -1); // 引号包裹：去掉引号，保留引号内的空格
    } else {
      const hit = value.search(/\s#/); // 未加引号：空格 + # 之后是行内注释
      if (hit >= 0) value = value.slice(0, hit).trim();
    }
    out[key] = value;
  }
  return out;
}

// 读取项目根 .env（同一路径只解析一次，走 dotEnvCache）。
// 这里刻意不把值写进 process.env，也不覆盖已存在的 process.env 键：
// 显式导出的环境变量优先级更高，而 .env 只服务本模块的取值链；
// 顺带避免一份品牌配置污染（或覆盖）整个进程的环境变量。
// 返回空对象表示「没有 .env / 读不了」，调用方继续往下一级兜底。
function loadDotEnvOnce(projectRoot) {
  const envPath = path.join(projectRoot, ".env");
  if (dotEnvCache.has(envPath)) return dotEnvCache.get(envPath);
  let parsed = {};
  try {
    if (fs.existsSync(envPath)) parsed = parseDotEnv(fs.readFileSync(envPath, "utf8"));
  } catch (_) {
    parsed = {}; // 权限 / 编码 / 写到一半：当没配，品牌还有清单与默认值兜底
  }
  dotEnvCache.set(envPath, parsed);
  return parsed;
}

// 读清单 brand 段（第三级兜底，旧行为）。返回对象原样透传：
// 下游清单可能自定义额外键（如 name），这里只负责取出来，不做字段裁剪。
// 清单缺失 / 无 brand 段 / brand 不是对象 / JSON 解析失败 → null（表示这一级没配）。
function readManifestBrand(projectRoot) {
  try {
    const manifestPath = path.join(projectRoot, "assemble.json");
    if (!fs.existsSync(manifestPath)) return null;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const brand = manifest && manifest.brand;
    if (!brand || typeof brand !== "object" || Array.isArray(brand)) return null;
    return brand;
  } catch (_) {
    return null;
  }
}

// 把一层「扁平键配置」（环境变量 / .env 解析结果）叠到品牌对象上。
// 只认非空字符串：空值等于没配，不能拿它覆盖下一级已经取到的值。
// 由低到高依次调用（清单 → .env → 环境变量），后调用者天然获得更高优先级。
function applyEnvLayer(target, source) {
  if (!source) return;
  for (const envKey of Object.keys(ENV_KEY_MAP)) {
    const raw = source[envKey];
    if (typeof raw !== "string" || raw.trim() === "") continue;
    target[ENV_KEY_MAP[envKey]] = raw.trim();
  }
}

// 补齐第四级内置默认值：只补「缺」的字段，已有值一律不动。
// displayTitle 允许含内联 HTML（如 GameBanana<br>Mod<br>Downloader），原样透传不转义；
// 它缺失时回退 title——只配了标题的项目，顶栏也能显示得出字。
function fillDefaults(out) {
  if (isBlank(out.title)) out.title = DEFAULT_BRAND.title;
  if (isBlank(out.logo)) out.logo = DEFAULT_BRAND.logo;
  if (isBlank(out.icon)) out.icon = DEFAULT_BRAND.icon;
  if (isBlank(out.displayTitle)) out.displayTitle = out.title;
  return out;
}

// 读品牌配置：恒返回对象（永不 null），四级兜底后四个标准键一定有可用值。
// @param {string} serverDir 调用方所在目录（server/）；项目根 = 其上一级
// @returns {object} { title, logo, icon, displayTitle } + 清单 brand 段里的额外键
function readBrand(serverDir) {
  try {
    const projectRoot = path.resolve(serverDir, ".."); // serverDir 为空 → 抛错，落到下面的兜底
    const out = {};
    // 第三级：清单 brand 段打底（保留额外键，兼容旧清单的 name 等字段）
    const manifestBrand = readManifestBrand(projectRoot);
    if (manifestBrand) Object.assign(out, manifestBrand);
    // 第二级：.env 覆盖清单；第一级：进程环境变量覆盖 .env
    applyEnvLayer(out, loadDotEnvOnce(projectRoot));
    applyEnvLayer(out, process.env);
    // 第四级：仍缺的字段补内置默认值
    return fillDefaults(out);
  } catch (_) {
    // 连项目根都解析不出来（调用方漏传参数等）：给可渲染品牌，绝不返回 null
    return fillDefaults({});
  }
}

module.exports = { readBrand };
