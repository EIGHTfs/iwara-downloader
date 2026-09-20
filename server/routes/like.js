// ============================================================
// iwara-downloader - 路由：赞/关注（视频点赞、用户关注、状态查询）
// 背景（2026-09-20）：官方列表接口 liked/following 恒 false，
// 搜索列表靠 like_state 本地状态展示「已赞/已关注」；播放页手动收藏/关注也走这里。
// ============================================================
"use strict";

module.exports = function register(api) {
  const { route, routePublic, sendJson, readBody, cfg, iwaraApi, likeState } = api;

  // GET /api/liked-state（需鉴权）- 本地已赞/已关注 id 集合（搜索列表合并展示用）
  route("GET", "/api/liked-state", (req, res) => {
    return sendJson(res, 200, { ok: true, ...likeState.toPublic() });
  });

  // GET /api/video-state（公开，handler 内可访问） - 播放页「收藏/关注」按钮初始状态：
  //   官方详情接口返回真实 liked/following，再与本地 like_state 合并；
  //   未登录/联网失败时回退本地状态（至少能看本地已知的收藏/关注）
  routePublic("GET", "/api/video-state", async (req, res, parsed) => {
    const id = String((parsed.query && parsed.query.id) || "").trim();
    if (!id) return sendJson(res, 400, { ok: false, error: "缺视频 id" });
    try {
      const st = await iwaraApi.getVideoState(id);
      if (!st) return sendJson(res, 200, { ok: false, error: "视频不存在" });
      // 本地已赞状态兜底（官方接口可能刚点赞还没生效/接口不稳定）
      if (likeState.isLiked(id)) st.liked = true;
      if (st.authorId && likeState.isFollowing(st.authorId)) st.following = true;
      return sendJson(res, 200, Object.assign({ ok: true }, st));
    } catch (e) {
      // 联网失败：用本地状态兜底（至少播放页按钮显示本地已知状态）
      return sendJson(res, 200, {
        ok: true,
        id,
        liked: likeState.isLiked(id),
        following: false,
        authorId: "",
        author: "",
        online: false,
        error: String(e.message || e)
      });
    }
  });

  // POST /api/like（需鉴权）- 点赞视频（幂等：已赞也 201/409 视为成功）
  route("POST", "/api/like", async (req, res) => {
    const body = await readBody(req);
    const id = String((body && body.id) || "").trim();
    if (!id) return sendJson(res, 400, { ok: false, error: "缺视频 id" });
    try {
      await iwaraApi.likeVideo(id);
      likeState.markLiked(id); // 本地记录，搜索列表 badge 立即生效
      return sendJson(res, 200, { ok: true, id });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: String(e.message || e) });
    }
  });

  // DELETE /api/like（需鉴权）- 取消点赞（备用：不做前端入口则无人调用）
  route("DELETE", "/api/like", async (req, res, parsed) => {
    const id = String((parsed.query && parsed.query.id) || "").trim();
    if (!id) return sendJson(res, 400, { ok: false, error: "缺视频 id" });
    try {
      await iwaraApi.unlikeVideo(id);
      likeState.markUnliked(id); // 同步删本地记录
      return sendJson(res, 200, { ok: true, id });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: String(e.message || e) });
    }
  });

  // POST /api/follow（需鉴权）- 关注作者（幂等）
  route("POST", "/api/follow", async (req, res) => {
    const body = await readBody(req);
    const userId = String((body && body.userId) || "").trim();
    if (!userId) return sendJson(res, 400, { ok: false, error: "缺 userId" });
    try {
      await iwaraApi.followUser(userId);
      likeState.markFollowed(userId, String((body && body.username) || "")); // 本地记录
      return sendJson(res, 200, { ok: true, userId });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: String(e.message || e) });
    }
  });

  // DELETE /api/follow（需鉴权）- 取消关注
  route("DELETE", "/api/follow", async (req, res, parsed) => {
    const userId = String((parsed.query && parsed.query.userId) || "").trim();
    if (!userId) return sendJson(res, 400, { ok: false, error: "缺 userId" });
    try {
      await iwaraApi.unfollowUser(userId);
      likeState.markUnfollowed(userId); // 同步删本地记录
      return sendJson(res, 200, { ok: true, userId });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: String(e.message || e) });
    }
  });
};