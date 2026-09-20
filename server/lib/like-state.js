// ============================================================
// iwara-downloader - 本地已赞/已关注状态缓存
// 问题背景（2026-09-20 实测）：
//   官方 /videos 列表接口与 /search 接口对所有视频恒返回 liked:false、following:false
//   （即使登录、即使真实已赞）——只有详情接口 /video/{id} 返回真实值。
//   导致搜索列表的「❤️ 已赞」badge 永不显示，下载自动收藏成功后前端也不刷新。
// 本模块：把「本服务已知的」已赞视频 / 已关注作者持久化到 json/liked_state.json，
//   下载自动收藏、播放页手动收藏都会写入；搜索缓存与播放页状态从这里合并真实值。
// ============================================================
"use strict";

const fs = require("fs");
const jsonDir = require("../store/json-dir.js");

const STATE_FILE = jsonDir.migrateRuntimeJson("liked_state.json"); //userdata-manifest.json file json/liked_state.json 已赞/已关注状态缓存

let mem = null; // { liked: {videoId: ts}, followed: {userId: {username, ts}} }

function load() {
  if (mem) return mem;
  try {
    if (fs.existsSync(STATE_FILE)) {
      const d = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (d && typeof d === "object") {
        mem = {
          liked: d.liked && typeof d.liked === "object" ? d.liked : {},
          followed: d.followed && typeof d.followed === "object" ? d.followed : {}
        };
        return mem;
      }
    }
  } catch (_) {}
  mem = { liked: {}, followed: {} };
  return mem;
}

function save() {
  const d = load();
  try {
    jsonDir.ensureJsonDir();
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(d), "utf8");
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error("[like-state] 写入失败:", e && e.message || e);
  }
}

/** 标记视频已赞（幂等）。 */
function markLiked(videoId) {
  const id = String(videoId || "").trim();
  if (!id) return;
  load().liked[id] = Date.now();
  save();
}

/** 标记作者已关注（幂等）。userId 是作者 id，username 用于展示。 */
function markFollowed(userId, username) {
  const id = String(userId || "").trim();
  if (!id) return;
  load().followed[id] = { username: String(username || ""), ts: Date.now() };
  save();
}

/**
 * 批量标记已赞（幂等，一次落盘）。
 * 用于启动/登录后从官方「我的已赞」列表回填历史真实收藏状态。
 */
function markLikedBatch(ids) {
  const d = load();
  const now = Date.now();
  let changed = false;
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw || "").trim();
    if (!id) continue;
    if (!d.liked[id]) changed = true;
    d.liked[id] = now;
  }
  if (changed) save();
  return changed;
}

/**
 * 批量标记已关注（幂等，一次落盘）。
 * list: [{userId, username}]，用于回填官方关注列表。
 */
function markFollowedBatch(list) {
  const d = load();
  const now = Date.now();
  let changed = false;
  for (const it of Array.isArray(list) ? list : []) {
    const id = String((it && (it.userId || it.id)) || "").trim();
    if (!id) continue;
    const uname = String((it && (it.username || it.name)) || "");
    if (!d.followed[id] || d.followed[id].username !== uname) changed = true;
    d.followed[id] = { username: uname, ts: now };
  }
  if (changed) save();
  return changed;
}

function isLiked(videoId) {
  const id = String(videoId || "").trim();
  if (!id) return false;
  return !!load().liked[id];
}

/** 已赞视频 id 集合（增量同步对比用） */
function likedIdSet() {
  return new Set(Object.keys(load().liked));
}

/** 取消已赞（DELETE /api/like 成功后同步删本地记录） */
function markUnliked(videoId) {
  const id = String(videoId || "").trim();
  if (!id) return;
  if (delete load().liked[id]) save();
}

/** 取消关注（DELETE /api/follow 成功后同步删本地记录） */
function markUnfollowed(userId) {
  const id = String(userId || "").trim();
  if (!id) return;
  if (delete load().followed[id]) save();
}

function isFollowing(userId) {
  const id = String(userId || "").trim();
  if (!id) return false;
  return !!load().followed[id];
}

/** 已关注作者 id 集合（供搜索 user 行合并） */
function followedUserIds() {
  return new Set(Object.keys(load().followed));
}

/** 已赞视频 id 集合（供前端一次拉取），{ liked:[id], followed:[{userId, username}] } */
function toPublic() {
  const d = load();
  return {
    liked: Object.keys(d.liked),
    followed: Object.keys(d.followed).map((id) => Object.assign({ userId: id }, d.followed[id]))
  };
}

/** 给单个视频条目补真实 liked/following（本地状态优先于官方假值） */
function mergeOne(v) {
  if (!v) return v;
  const id = String(v.id || v.modId || "").trim();
  const authorId = String(v.authorId || (v.user && v.user.id) || "").trim();
  if (id && isLiked(id)) v.liked = true;
  if (authorId && isFollowing(authorId)) v.following = true;
  return v;
}

module.exports = {
  markLiked,
  markFollowed,
  markLikedBatch,
  markFollowedBatch,
  isLiked,
  isFollowing,
  likedIdSet,
  markUnliked,
  followedUserIds,
  toPublic,
  mergeOne,
  STATE_FILE
};