// 登录页逻辑（两端共用）：回车/按钮提交密码 → /api/login → 跳首页。
document.getElementById("pwd").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
document.getElementById("btn").addEventListener("click", login);
async function login() {
  const st = document.getElementById("status");
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: document.getElementById("pwd").value, remember: document.getElementById("remember").checked })
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "登录失败");
    // 2026-10-14：保存服务端返回的 token，作为「会话 cookie 兜底」。
    //   cookie 按 host 隔离且不看端口 —— 换访问地址（多网卡 IP / 主机名 / 异地组网）就带不上，
    //   前端一遇 401 便跳登录页，表现为「刚登录又要登录」。服务端 extractToken() 已支持
    //   Authorization: Bearer（server/auth/auth.js），带上即可免登录。
    try { if (j.token) localStorage.setItem("auth-token", j.token); } catch (_) {}
    location.href = "/";
  } catch (e) {
    st.textContent = e.message;
    st.className = "status err";
  }
}