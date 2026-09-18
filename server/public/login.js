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
    location.href = "/";
  } catch (e) {
    st.textContent = e.message;
    st.className = "status err";
  }
}