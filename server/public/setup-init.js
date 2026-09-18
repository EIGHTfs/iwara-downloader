// 设置向导页：首次设置密码 → /api/change-password → 自动登录 → 跳首页
document.getElementById("btn").addEventListener("click", async () => {
  const pwd = document.getElementById("pwd").value;
  const pwd2 = document.getElementById("pwd2").value;
  const st = document.getElementById("status");
  if (pwd.length < 4) { st.textContent = "密码至少 4 位"; st.className = "status err"; return; }
  if (pwd !== pwd2) { st.textContent = "两次输入不一致"; st.className = "status err"; return; }
  try {
    const r = await fetch("/api/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pwd })
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "设置失败");
    const l = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pwd })
    });
    const lj = await l.json();
    if (!lj.ok) throw new Error(lj.error || "登录失败");
    location.href = "/";
  } catch (e) {
    st.textContent = e.message;
    st.className = "status err";
  }
});