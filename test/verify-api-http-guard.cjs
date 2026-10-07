// ============================================================
// test/verify-api-http-guard.cjs —— HTTP 请求层崩溃防线回归测试
//
// 背景（2026-10-08 线上崩溃，进程被 ReferenceError 直接带走）：
//   ① server/lib/iwara-api.js 的 httpsJson 旧写法把 `const req` 声明在
//      setTimeout 之后。一旦 https.request() 同步抛错，异常被 Promise 捕获了，
//      但超时定时器不会被清理 → 到点回调访问处于 TDZ 的 req
//      → `ReferenceError: Cannot access 'req' before initialization`（未捕获）
//      → Node 进程退出：服务整机不可用、在跑的任务全断、油猴端表现为「发不了 Cookie」。
//   ② 触发同步抛错的最常见输入：Cookie 值里混入换行/控制字符
//      （油猴回传的组合文本、手工粘贴的多行内容）→ ERR_INVALID_CHAR。
//
// 本测试直接驱动真实实现（不用复制一份逻辑），断言四条：
//   1. Cookie 控制字符清洗（换行按项分隔、控制字符剔除、deleted/空值仍丢弃）
//   2. 同步抛错 → 转成 Promise reject，且等待超过原超时阈值后进程仍存活（回归 ①）
//   3. 正常 200 JSON 路径不受修复影响
//   4. 超时保护仍然生效（到点真的调用 req.destroy）
//
// 运行：node test/verify-api-http-guard.cjs
// ============================================================
"use strict";

const EventEmitter = require("events");
const https = require("https");

const api = require("../server/lib/iwara-api.js");
const { _httpsJson, _cookieForRequest } = api;

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log((ok ? "  ✓ " : "  ✗ ") + name + (detail ? "  [" + detail + "]" : ""));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TEST_URL = "https://api.iwara.tv/user";

(async () => {
  console.log("== 1. Cookie 控制字符清洗（同步抛错的触发源）==");
  const c1 = _cookieForRequest("a=1\r\nb=2\nc=3");
  check("换行不再残留在请求头里", !/[\r\n]/.test(c1), JSON.stringify(c1));
  check("换行分隔出的各项都保留", /a=1/.test(c1) && /b=2/.test(c1) && /c=3/.test(c1), c1);

  const c2 = _cookieForRequest("x=\u0001y\u007f; z=9");
  check("控制字符（\\x01 / DEL）被剔除", !/[\u0000-\u001f\u007f]/.test(c2), JSON.stringify(c2));

  const c3 = _cookieForRequest("keep=1; gone=deleted; empty=; also=2");
  check("deleted 与空值项仍被丢弃", /keep=1/.test(c3) && /also=2/.test(c3) && !/deleted/.test(c3) && !/empty=/.test(c3), c3);

  const clean = "cf_clearance=abc; token=xyz";
  check("正常 cookie 原样保留", _cookieForRequest(clean) === clean, _cookieForRequest(clean));

  const origRequest = https.request;

  console.log("== 2. https.request 同步抛错 → 不崩进程（本次崩溃根因回归）==");
  https.request = function () {
    throw new Error("ERR_INVALID_CHAR: Invalid character in header content ['Cookie']");
  };
  let caught = null;
  try {
    await _httpsJson(TEST_URL, { timeoutMs: 120, retries: 0 });
  } catch (e) {
    caught = e;
  }
  https.request = origRequest;
  check("同步抛错被转成 Promise reject（错误交给调用方）", !!(caught && /ERR_INVALID_CHAR/.test(caught.message)), caught ? caught.message.slice(0, 46) : "未捕获到错误");
  // 旧实现：超时定时器没清，300ms 后回调访问 TDZ 的 req → ReferenceError → 进程直接退出。
  // 能走到下一行并打印，就说明定时器已被清理。
  await sleep(300);
  check("等待超过原 timeoutMs 后进程仍存活（定时器已清理，无 TDZ 回调）", true);

  console.log("== 3. 正常 200 JSON 路径不受修复影响 ==");
  https.request = function (opts, cb) {
    const req = new EventEmitter();
    req.destroy = function () {};
    req.write = function () {};
    req.end = function () {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      setImmediate(function () {
        cb(res);
        res.emit("data", Buffer.from('{"ok":true}'));
        res.emit("end");
      });
    };
    return req;
  };
  let data = null;
  let err3 = null;
  try {
    data = await _httpsJson(TEST_URL, { timeoutMs: 800, retries: 0 });
  } catch (e) {
    err3 = e;
  }
  https.request = origRequest;
  check("200 JSON 正常 resolve", !!(data && data.ok === true), err3 ? err3.message : JSON.stringify(data));

  console.log("== 4. 超时保护仍然生效 ==");
  let destroyed = false;
  https.request = function () {
    const req = new EventEmitter();
    req.destroy = function () { destroyed = true; };
    req.write = function () {};
    req.end = function () {};
    return req;
  };
  _httpsJson(TEST_URL, { timeoutMs: 100, retries: 0 }).catch(function () {});
  await sleep(280);
  https.request = origRequest;
  check("到点真的调用 req.destroy（超时保护仍在）", destroyed);

  console.log("\n结果：通过 " + pass + " / 失败 " + fail);
  // 主动退出：超时用例内部按退避计划还挂着重试定时器，不必等它跑完。
  process.exit(fail ? 1 : 0);
})();
