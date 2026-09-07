/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var plugin_exports = {};
__export(plugin_exports, {
  PluginOnlineCountServer: () => PluginOnlineCountServer,
  default: () => plugin_default
});
module.exports = __toCommonJS(plugin_exports);
var import_server = require("@nocobase/server");
var import_lodash = require("lodash");
var import_auth_middleware = require("./auth-middleware");
var import_device_logic = require("./device-logic");
const BROADCAST_THROTTLE_MS = 2e3;
const CONFIG_KEY = "default";
const MAX_BUFFER_SIZE = 1e3;
const MAX_BUFFER_RETRIES = 5;
function normalizeIp(ip) {
  let s = ip.trim();
  if (s.startsWith("::ffff:")) s = s.slice(7);
  if (s === "::1") s = "127.0.0.1";
  return s;
}
function extractClientIp(headers) {
  if (!headers) return void 0;
  const forwarded = headers["x-forwarded-for"];
  if (forwarded) {
    const firstIp = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0];
    return (firstIp == null ? void 0 : firstIp.trim()) || void 0;
  }
  const realIp = headers["x-real-ip"];
  if (realIp) {
    return Array.isArray(realIp) ? realIp[0] : realIp;
  }
  return void 0;
}
class PluginOnlineCountServer extends import_server.Plugin {
  /** 用户会话 Map，key = userId */
  userSessions = /* @__PURE__ */ new Map();
  /** clientId -> userId 反向映射 */
  clientIdToUserId = /* @__PURE__ */ new Map();
  /** clientId -> 最后心跳时间戳 */
  clientPingTimes = /* @__PURE__ */ new Map();
  /** clientId -> 设备指纹（同浏览器多标签页共享同一 deviceId，不同浏览器/设备各自独立） */
  clientDeviceId = /* @__PURE__ */ new Map();
  /** 会话日志缓冲队列，每 60 秒批量写入数据库 */
  bufferQueue = [];
  /** 缓冲区连续写入失败次数，成功时重置，超过上限后清空队列 */
  bufferRetryCount = 0;
  /** 插件配置（内存存储） */
  config = {
    visibleToAll: true,
    singleSession: false
  };
  /** 上次 listOnlineUsers 输出的 userId 签名，用于变化时才打印调试日志（避免轮询刷屏） */
  lastListSignature = "";
  /** 按 userId 串行化 onWsSetTag 执行，防止并发竞态（互斥登录的核心保障） */
  userSetTagLocks = /* @__PURE__ */ new Map();
  /** Cache 实例，用于 JWT 黑名单存储 */
  tokenBlacklist;
  /**
   * 广播节流器（逻辑三·后端 Throttle）：所有 broadcastOnlineUsers() 调用都经过它，
   * 最高 2000ms/次（leading 立即执行 + trailing 兜底），防止状态高频变化导致广播风暴。
   */
  throttledBroadcast = (0, import_lodash.throttle)(() => this.doBroadcastOnlineUsers(), BROADCAST_THROTTLE_MS, {
    leading: true,
    trailing: true
  });
  // Diff 快照：仅含 totalCount/userId/status/clientCount，剔除自增字段，仅实质变化才 emit
  lastBroadcastSnapshot = null;
  // 定时器引用
  heartbeatTimer = null;
  cleanupTimer = null;
  flushTimer = null;
  retentionTimer = null;
  async load() {
    this.tokenBlacklist = await this.app.cacheManager.createCache({
      name: "online-count-token-blacklist",
      prefix: "online-count-token-blacklist",
      store: "memory"
    });
    if (this.app.listenerCount("ws:sendToClient") === 0) {
      this.app.logger.warn("[online-count] ws:sendToClient not registered, using Gateway fallback");
      this.app.on("ws:sendToClient", ({ clientId, message }) => {
        const wsServer = import_server.Gateway.getInstance().wsServer;
        if (wsServer) {
          wsServer.sendToClient(clientId, message);
        }
      });
    }
    if (this.app.listenerCount("ws:disconnectClient") === 0) {
      this.app.logger.warn("[online-count] ws:disconnectClient not registered, using Gateway fallback");
      this.app.on("ws:disconnectClient", ({ clientId }) => {
        const wsServer = import_server.Gateway.getInstance().wsServer;
        if (wsServer) {
          const client = wsServer.webSocketClients.get(clientId);
          if (client) {
            client.ws.close(4001, "force logout");
          }
        }
      });
    }
    this.app.resourceManager.define({
      name: "online_users",
      actions: {
        list: this.listOnlineUsers.bind(this),
        kick: this.kickUser.bind(this),
        blacklist: this.blacklistUser.bind(this),
        unblacklist: this.unblacklistUser.bind(this),
        blacklisted_users: this.listBlacklistedUsers.bind(this),
        broadcast: this.broadcastMessage.bind(this),
        read_broadcast: this.markBroadcastRead.bind(this),
        list_broadcasts: this.listUnreadBroadcasts.bind(this),
        broadcasts: this.listBroadcasts.bind(this),
        broadcast_reads: this.broadcastReads.bind(this),
        broadcast_delete: this.deleteBroadcasts.bind(this)
      }
    });
    this.app.logger.debug("[online-count] resource online_users registered with 11 actions");
    this.app.acl.allow("online_users", "list", "loggedIn");
    this.app.acl.allow("online_users", "kick", (ctx) => {
      return this.isAdminRequest(ctx);
    });
    this.app.acl.allow("online_users", "blacklist", (ctx) => {
      return this.isAdminRequest(ctx);
    });
    this.app.acl.allow("online_users", "unblacklist", (ctx) => {
      return this.isAdminRequest(ctx);
    });
    this.app.acl.allow("online_users", "blacklisted_users", (ctx) => {
      return this.isAdminRequest(ctx);
    });
    this.app.acl.allow("online_users", "broadcast", (ctx) => {
      return this.isAdminRequest(ctx);
    });
    this.app.acl.allow("online_users", "read_broadcast", "loggedIn");
    this.app.acl.allow("online_users", "list_broadcasts", "loggedIn");
    this.app.acl.allow("online_users", "broadcasts", (ctx) => {
      return this.isAdminRequest(ctx);
    });
    this.app.acl.allow("online_users", "broadcast_reads", (ctx) => {
      return this.isAdminRequest(ctx);
    });
    this.app.acl.allow("online_users", "broadcast_delete", (ctx) => {
      return this.isAdminRequest(ctx);
    });
    this.app.resourceManager.define({
      name: "online_count_config",
      actions: {
        get: this.getConfig.bind(this),
        set: this.setConfig.bind(this)
      }
    });
    this.app.acl.allow("online_count_config", "get", "loggedIn");
    this.app.acl.allow("online_count_config", "set", (ctx) => {
      return this.isAdminRequest(ctx);
    });
    this.app.on("ws:setTag", this.onWsSetTag.bind(this));
    this.app.on("ws:message:online_device", this.onWsDeviceTag.bind(this));
    this.app.on("ws:removeTag", this.onWsRemoveTag.bind(this));
    this.app.on("ws:message:pong", this.onPong.bind(this));
    this.app.on("ws:message:STATUS_AWAY", this.onStatusAway.bind(this));
    this.app.on("ws:message:STATUS_ACTIVE", this.onStatusActive.bind(this));
    this.app.on("ws:message:LOGOUT_NOTIFY", this.onLogoutNotify.bind(this));
    this.app.resourcer.use(async (ctx, next) => {
      var _a, _b, _c, _d, _e;
      try {
        const resourceName = (_a = ctx.action) == null ? void 0 : _a.resourceName;
        const actionName = (_b = ctx.action) == null ? void 0 : _b.actionName;
        const path = ((_c = ctx.request) == null ? void 0 : _c.path) || "";
        const isSignOut = resourceName === "auth" && actionName === "signOut" || path.includes("/auth:signOut");
        if (isSignOut) {
          const userId = (_e = (_d = ctx.auth) == null ? void 0 : _d.user) == null ? void 0 : _e.id;
          if (userId != null) {
            this.app.logger.info(`[online-count] Intercepted auth:signOut, removing all sessions of user=${userId}`);
            this.removeUserSessions(String(userId), "normal");
          }
        }
      } catch (error) {
        this.app.logger.error("[online-count] Error in signOut interceptor:", error);
      }
      await next();
    });
    this.app.use((0, import_auth_middleware.createTokenBlacklistMiddleware)(this.tokenBlacklist, this.db, this.app.logger));
    this.app.on("beforeStop", async () => {
      this.app.logger.info("[online-count] Graceful shutdown: flushing buffer and broadcasting SERVER_RESTART");
      await this.flushBufferQueue();
      this.app.emit("ws:sendToCurrentApp", {
        message: {
          type: "SERVER_RESTART",
          payload: { timestamp: Date.now() }
        }
      });
    });
    this.scheduleDataRetention();
  }
  async afterEnable() {
    await this.ensureTablesExist();
    try {
      await this.loadConfig();
    } catch (error) {
      this.app.logger.warn("[online-count] loadConfig failed, using in-memory defaults:", error);
    }
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 3e4);
    this.cleanupTimer = setInterval(() => this.cleanupStaleConnections(), 3e4);
    this.flushTimer = setInterval(() => this.flushBufferQueue(), 6e4);
  }
  /**
   * 确保本插件持久化表存在：配置表 onlineCountConfig 与会话日志表 sessionLogs。
   * 这两张表由 collections/ 目录定义，经核心 loadCollections + db.sync 创建；
   * 若因历史异常启动漏建，这里通过一次兜底 db.sync 补建（幂等、安全）。
   */
  async ensureTablesExist() {
    const collections = ["onlineCountConfig", "sessionLogs", "systemBroadcasts", "userBroadcastReads"];
    try {
      const missing = [];
      for (const name of collections) {
        const exists = await this.db.collectionExistsInDb(name).catch(() => false);
        if (!exists) missing.push(name);
      }
      if (missing.length > 0) {
        this.app.logger.warn(`[online-count] missing tables [${missing.join(", ")}], running db.sync to heal`);
        await this.db.sync();
      }
    } catch (error) {
      this.app.logger.warn("[online-count] ensureTablesExist heal sync failed:", error);
    }
  }
  async afterDisable() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    if (this.flushTimer) {
      await this.flushBufferQueue();
      clearInterval(this.flushTimer);
    }
  }
  // ===== 数据保留定时任务 =====
  /**
   * 每小时检查一次，若当前小时为凌晨 3 点则自动清理超过 30 天的 SessionLogs 数据。
   * 使用 setInterval 替代递归 setTimeout，更简洁且不会因极端延迟值溢出。
   */
  scheduleDataRetention() {
    const HOURLY = 60 * 60 * 1e3;
    this.retentionTimer = setInterval(() => {
      const now = /* @__PURE__ */ new Date();
      if (now.getHours() === 3) {
        this.cleanOldSessionLogs();
      }
    }, HOURLY);
  }
  /**
   * 删除超过 30 天的会话日志
   */
  async cleanOldSessionLogs() {
    try {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1e3);
      const repo = this.db.getRepository("sessionLogs");
      const count = await repo.destroy({
        filter: { loginTime: { $lt: cutoff } }
      });
      this.app.logger.info(
        `[online-count] Data retention: cleaned ${count} old session logs older than ${cutoff.toISOString()}`
      );
    } catch (error) {
      this.app.logger.error("[online-count] Failed to clean old session logs", error);
    }
  }
  // ===== 配置管理 =====
  isAdminRequest(ctx) {
    var _a, _b, _c, _d;
    const roles = /* @__PURE__ */ new Set();
    if ((_a = ctx.state) == null ? void 0 : _a.currentRole) {
      roles.add(ctx.state.currentRole);
    }
    for (const role of ((_b = ctx.state) == null ? void 0 : _b.currentRoles) || []) {
      if (role) roles.add(typeof role === "string" ? role : role.name);
    }
    for (const role of ((_d = (_c = ctx.auth) == null ? void 0 : _c.user) == null ? void 0 : _d.roles) || []) {
      if (role == null ? void 0 : role.name) roles.add(role.name);
    }
    return roles.has("admin") || roles.has("root");
  }
  async loadConfig(ctx) {
    const repo = ((ctx == null ? void 0 : ctx.db) || this.db).getRepository("onlineCountConfig");
    let record = await repo.findOne({ filterByTk: CONFIG_KEY });
    if (!record) {
      record = await repo.create({
        values: {
          key: CONFIG_KEY,
          visibleToAll: this.config.visibleToAll,
          singleSession: this.config.singleSession
        }
      });
    }
    this.config = {
      visibleToAll: typeof record.visibleToAll === "boolean" ? record.visibleToAll : true,
      singleSession: typeof record.singleSession === "boolean" ? record.singleSession : false
    };
    return this.config;
  }
  async getConfig(ctx, next) {
    ctx.body = await this.loadConfig(ctx);
    await next();
  }
  async setConfig(ctx, next) {
    var _a, _b, _c;
    const inputValues = ((_b = (_a = ctx.action) == null ? void 0 : _a.params) == null ? void 0 : _b.values) || ((_c = ctx.request) == null ? void 0 : _c.body) || {};
    const { visibleToAll, singleSession } = inputValues;
    this.app.logger.info(
      `[online-count] setConfig called visibleToAll=${visibleToAll} singleSession=${singleSession} current=${JSON.stringify(
        this.config
      )}`
    );
    if (typeof visibleToAll === "boolean") {
      this.config.visibleToAll = visibleToAll;
    }
    if (typeof singleSession === "boolean") {
      this.config.singleSession = singleSession;
    }
    const repo = (ctx.db ?? this.db).getRepository("onlineCountConfig");
    const existing = await repo.findOne({ filterByTk: CONFIG_KEY });
    const values = {
      visibleToAll: this.config.visibleToAll,
      singleSession: this.config.singleSession
    };
    if (existing) {
      await repo.update({ filterByTk: CONFIG_KEY, values });
    } else {
      await repo.create({ values: { key: CONFIG_KEY, ...values } });
    }
    this.app.logger.info(`[online-count] setConfig saved: ${JSON.stringify(this.config)}`);
    ctx.body = this.config;
    await next();
  }
  // ===== WebSocket 事件处理 =====
  /**
   * 逻辑一·登录触发更新：用户登录认证成功，设置 userId 标签
   * 核心逻辑：
   * 1. 检查黑名单
   * 2. 互斥登录：如果启用了 singleSession，向旧 clientId 发送 LOGGED_IN_ELSEWHERE 信令，
   *    并在延迟 100ms 后强制断开旧连接
   * 3. 在内存 userSessions Map 中分配会话，并触发全网广播（经过节流器）
   */
  async onWsSetTag({ clientId, tagKey, tagValue }) {
    if (tagKey !== "userId") return;
    const userId = String(tagValue);
    this.app.logger.info(
      `[online-count] ws:setTag userId=${userId} clientId=${clientId} singleSession=${this.config.singleSession}`
    );
    this.clientIdToUserId.set(clientId, userId);
    this.clientPingTimes.set(clientId, Date.now());
    const ip = this.getClientIpFromGateway(clientId);
    if (ip) {
      const sess = this.userSessions.get(userId);
      if (sess) sess.clientIps.set(clientId, ip);
    }
    const previous = this.userSetTagLocks.get(userId) ?? Promise.resolve();
    const current = previous.then(() => this.processSetTag(userId, clientId)).catch((err) => {
      this.app.logger.error(`[online-count] processSetTag failed for userId=${userId}:`, err);
    }).then(() => {
      if (this.userSetTagLocks.get(userId) === current) this.userSetTagLocks.delete(userId);
    });
    this.userSetTagLocks.set(userId, current);
    await current;
    try {
      await this.syncUnreadBroadcasts(userId, clientId);
    } catch (error) {
      this.app.logger.error(`[online-count] syncUnreadBroadcasts failed for userId=${userId}:`, error);
    }
  }
  /**
   * 执行 setTag 的核心逻辑（在 per-userId 锁内串行执行）。
   * 从 onWsSetTag 中拆分出来，确保同一用户的并发 setTag 调用不会互相干扰。
   */
  async processSetTag(userId, clientId) {
    try {
      const user = await this.resolveUser(userId);
      if (!user) {
        this.ensureSession(userId, clientId, null);
        this.broadcastOnlineUsers();
        return;
      }
      if (this.handleBlacklistedUser(userId, clientId, user)) {
        return;
      }
      const existing = this.userSessions.get(userId);
      if (this.config.singleSession && existing) {
        const newDeviceId = this.clientDeviceId.get(clientId);
        if (!newDeviceId) {
          this.ensureSession(userId, clientId, user);
        } else {
          this.kickOtherDevices(userId, clientId, existing, newDeviceId, user);
        }
      } else {
        this.ensureSession(userId, clientId, user);
      }
      this.broadcastOnlineUsers();
    } catch (error) {
      this.app.logger.error(`[online-count] Error in processSetTag for userId=${userId} clientId=${clientId}:`, error);
      try {
        const existing = this.userSessions.get(userId);
        if (existing) {
          existing.clientIds.add(clientId);
        } else {
          this.ensureSession(userId, clientId, null);
        }
        this.broadcastOnlineUsers();
      } catch (fallbackError) {
        this.app.logger.error("[online-count] Fallback session creation also failed:", fallbackError);
      }
    }
  }
  /**
   * 从数据库查询用户信息（含角色），用户不存在时返回 null。
   */
  async resolveUser(userId) {
    const userRepo = this.db.getRepository("users");
    return userRepo.findOne({ filterByTk: userId, appends: ["roles"] });
  }
  /**
   * 检查用户是否被拉黑。若被拉黑且非 root，发送 FORCE_LOGOUT 并在 100ms 后断开连接，
   * 同时清理 clientId 映射。返回 true 表示已拦截（调用方应 return）。
   */
  handleBlacklistedUser(userId, clientId, user) {
    var _a;
    const isRoot = (_a = user == null ? void 0 : user.roles) == null ? void 0 : _a.some((r) => r.name === "root");
    if (!isRoot && (user == null ? void 0 : user.blacklisted)) {
      this.app.emit("ws:sendToClient", {
        clientId,
        message: { type: "FORCE_LOGOUT", payload: { reason: "blacklisted" } }
      });
      setTimeout(() => {
        this.app.emit("ws:disconnectClient", { clientId });
      }, 0);
      this.clientIdToUserId.delete(clientId);
      this.clientPingTimes.delete(clientId);
      this.clientDeviceId.delete(clientId);
      return true;
    }
    return false;
  }
  /**
   * 确保用户在当前 clientId 下存在会话记录。
   * - user 为 null 时创建最小化会话（用户不存在于 DB 的兜底）
   * - 已有会话则追加 clientId
   * - 新用户则创建完整会话
   */
  ensureSession(userId, clientId, user) {
    var _a, _b, _c;
    const existing = this.userSessions.get(userId);
    if (existing) {
      existing.clientIds.add(clientId);
      return;
    }
    const roleName = ((_a = user == null ? void 0 : user.roles) == null ? void 0 : _a.find((r) => r.name === "root")) ? "root" : ((_c = (_b = user == null ? void 0 : user.roles) == null ? void 0 : _b[0]) == null ? void 0 : _c.name) || "";
    const userAgent = this.getClientUserAgentFromGateway(clientId);
    this.userSessions.set(userId, {
      userId,
      nickname: (user == null ? void 0 : user.nickname) || `User ${userId}`,
      clientIds: /* @__PURE__ */ new Set([clientId]),
      clientIps: /* @__PURE__ */ new Map(),
      loginTime: Date.now(),
      status: "ACTIVE",
      roleName,
      blacklisted: Boolean(user == null ? void 0 : user.blacklisted),
      userAgent
    });
  }
  /**
   * 客户端建连时上报设备指纹（online_device 消息）。
   * 记录 clientId -> deviceId，并在网关侧打 `deviceId#` 标签便于按设备聚合/排查；
   * 随后若单会话模式已开启，立即对所属用户重新执行单设备互斥判定（收敛消息乱序竞态）。
   */
  onWsDeviceTag({ clientId, payload }) {
    let deviceId = payload == null ? void 0 : payload.deviceId;
    if (!deviceId) {
      deviceId = clientId;
    }
    this.clientDeviceId.set(clientId, deviceId);
    this.app.emit("ws:setTag", { clientId, tagKey: "deviceId", tagValue: deviceId });
    const userId = this.clientIdToUserId.get(clientId);
    if (userId && this.config.singleSession) {
      const previous = this.userSetTagLocks.get(userId) ?? Promise.resolve();
      const current = previous.then(() => {
        this.enforceSingleDevice(userId);
        this.broadcastOnlineUsers();
      }).catch((err) => {
        this.app.logger.error(`[online-count] enforceSingleDevice failed for userId=${userId}:`, err);
      }).then(() => {
        if (this.userSetTagLocks.get(userId) === current) this.userSetTagLocks.delete(userId);
      });
      this.userSetTagLocks.set(userId, current);
    }
  }
  // 单设备互斥：同浏览器多标签页共享 deviceId 不互踢；仅 >=2 个不同 deviceId 时踢旧设备。
  // 收敛点：无论 online_device 早于或晚于 auth:setTag，最终都收敛到正确结果。判定逻辑见 device-logic.ts。
  enforceSingleDevice(userId) {
    const existing = this.userSessions.get(userId);
    if (!existing || !this.config.singleSession) return;
    const { toKick } = (0, import_device_logic.computeEnforceSingleDevice)({
      existingClientIds: Array.from(existing.clientIds),
      clientDeviceId: this.clientDeviceId,
      clientPingTimes: this.clientPingTimes
    });
    if (toKick.length === 0) return;
    this.kickClientIds(userId, existing, toKick, "logged_in_elsewhere");
    this.recomputeLoginTime(existing);
  }
  /**
   * 单会话模式下的踢人：仅踢出 deviceId 与 newDeviceId 不同的旧连接，
   * 保留同浏览器多标签页（同 deviceId）。新连接本身始终保留并计入会话。
   * 纯判定逻辑见 ./device-logic.ts（computeKickOnNewConnection），此处仅套用副作用。
   */
  kickOtherDevices(userId, clientId, existing, newDeviceId, user) {
    this.ensureSession(userId, clientId, user);
    const { toKick } = (0, import_device_logic.computeKickOnNewConnection)({
      newClientId: clientId,
      newDeviceId,
      existingClientIds: Array.from(existing.clientIds),
      clientDeviceId: this.clientDeviceId
    });
    if (toKick.length > 0) {
      this.kickClientIds(userId, existing, toKick, "logged_in_elsewhere");
      this.recomputeLoginTime(existing);
    }
  }
  /**
   * 统一踢出一批连接：发送 LOGGED_IN_ELSEWHERE 信令、延迟断开、清理映射，
   * 并记一条会话日志（被踢设备下线）。被踢连接之间视为同一设备事件，合并为一条日志。
   */
  kickClientIds(userId, existing, clientIdsToKick, reason) {
    let firstIp = "";
    if (clientIdsToKick.length > 0) {
      firstIp = existing.clientIps.get(clientIdsToKick[0]) || "";
    }
    for (const cid of clientIdsToKick) {
      this.app.emit("ws:sendToClient", {
        clientId: cid,
        message: {
          type: "LOGGED_IN_ELSEWHERE",
          payload: { reason: "logged_in_elsewhere" }
        }
      });
      setTimeout(() => {
        this.app.emit("ws:disconnectClient", { clientId: cid });
      }, 0);
      this.clientIdToUserId.delete(cid);
      this.clientPingTimes.delete(cid);
      this.clientDeviceId.delete(cid);
      existing.clientIps.delete(cid);
      existing.clientIds.delete(cid);
    }
    if (clientIdsToKick.length > 0) {
      this.pushToBufferQueue({
        userId,
        loginTime: new Date(existing.loginTime),
        logoutTime: /* @__PURE__ */ new Date(),
        duration: Math.floor((Date.now() - existing.loginTime) / 1e3),
        logoutReason: reason,
        ip: firstIp,
        userAgent: existing.userAgent,
        status: existing.status
      });
    }
  }
  /**
   * 重新计算会话 loginTime：取剩余连接中最早的 clientPingTimes。
   * 单设备互斥把旧设备踢光、只留新设备时，让 loginTime 反映留存设备的首次登录。
   */
  recomputeLoginTime(session) {
    let min = Infinity;
    for (const cid of session.clientIds) {
      const p = this.clientPingTimes.get(cid);
      if (p && p < min) min = p;
    }
    if (min !== Infinity) session.loginTime = min;
  }
  /**
   * 用户下线或 WebSocket 断开，移除 userId 标签
   */
  onWsRemoveTag({ clientId, tagKey }) {
    if (tagKey !== "userId") return;
    this.removeClientSession(clientId);
  }
  /**
   * 客户端主动上报退出登录（正常登出 / 强制下线 / 异地登录）
   * 由 ws:message:LOGOUT_NOTIFY 触发，立即移除该 clientId 对应的会话
   */
  onLogoutNotify({ clientId }) {
    this.removeClientSession(clientId);
  }
  /**
   * 移除某个 clientId 对应的会话；当该用户所有连接都断开时删除会话并广播
   */
  removeClientSession(clientId) {
    const userId = this.clientIdToUserId.get(clientId);
    this.clientIdToUserId.delete(clientId);
    this.clientPingTimes.delete(clientId);
    this.clientDeviceId.delete(clientId);
    if (!userId) return;
    const session = this.userSessions.get(userId);
    if (!session) return;
    const ip = session.clientIps.get(clientId) || Array.from(session.clientIps.values())[0] || "";
    session.clientIds.delete(clientId);
    session.clientIps.delete(clientId);
    if (session.clientIds.size === 0) {
      this.userSessions.delete(userId);
      this.broadcastOnlineUsers();
      this.pushToBufferQueue({
        userId,
        loginTime: new Date(session.loginTime),
        logoutTime: /* @__PURE__ */ new Date(),
        duration: Math.floor((Date.now() - session.loginTime) / 1e3),
        logoutReason: "normal",
        ip,
        userAgent: session.userAgent,
        status: session.status
      });
    }
  }
  /**
   * 移除某用户的所有会话（登出 / 被踢），清理其全部 clientId 映射并广播。
   * 供 auth:signOut 拦截器与 kickUser 共用，是"逻辑二·后端 API 截杀"的落点。
   * @returns 是否存在可移除的会话
   */
  removeUserSessions(userId, logoutReason) {
    const session = this.userSessions.get(userId);
    if (!session) return false;
    const firstIp = Array.from(session.clientIps.values())[0] || "";
    const { loginTime, status, userAgent } = session;
    for (const clientId of session.clientIds) {
      this.clientIdToUserId.delete(clientId);
      this.clientPingTimes.delete(clientId);
      this.clientDeviceId.delete(clientId);
    }
    session.clientIds.clear();
    session.clientIps.clear();
    this.userSessions.delete(userId);
    this.pushToBufferQueue({
      userId,
      loginTime: new Date(loginTime),
      logoutTime: /* @__PURE__ */ new Date(),
      duration: Math.floor((Date.now() - loginTime) / 1e3),
      logoutReason,
      ip: firstIp,
      userAgent,
      status
    });
    this.broadcastOnlineUsers();
    return true;
  }
  /**
   * 心跳响应 Pong
   */
  onPong({ clientId }) {
    if (this.clientPingTimes.has(clientId)) {
      this.clientPingTimes.set(clientId, Date.now());
    }
  }
  /**
   * 用户进入离开状态（15 分钟无操作）
   */
  onStatusAway({ clientId }) {
    const userId = this.clientIdToUserId.get(clientId);
    if (!userId) return;
    const session = this.userSessions.get(userId);
    if (session) {
      session.status = "AWAY";
      this.broadcastOnlineUsers();
    }
  }
  /**
   * 用户恢复活跃状态（仅当客户端真正从 AWAY 变回 ACTIVE 时上报，前端已做防抖）
   */
  onStatusActive({ clientId }) {
    const userId = this.clientIdToUserId.get(clientId);
    if (!userId) return;
    const session = this.userSessions.get(userId);
    if (session) {
      session.status = "ACTIVE";
      this.clientPingTimes.set(clientId, Date.now());
      this.broadcastOnlineUsers();
    }
  }
  // ===== 心跳与清理 =====
  /**
   * 向所有客户端发送心跳 Ping
   */
  sendHeartbeat() {
    this.app.emit("ws:sendToCurrentApp", {
      message: { type: "ping" }
    });
  }
  /**
   * 清理超过 90 秒未响应的过期连接（兜底：浏览器直接关闭标签页等场景）
   */
  cleanupStaleConnections() {
    const now = Date.now();
    const staleThreshold = 9e4;
    const staleClientIds = [];
    for (const [clientId, lastPing] of this.clientPingTimes) {
      if (now - lastPing > staleThreshold) {
        staleClientIds.push(clientId);
      }
    }
    if (staleClientIds.length === 0) return;
    for (const clientId of staleClientIds) {
      const userId = this.clientIdToUserId.get(clientId);
      this.clientIdToUserId.delete(clientId);
      this.clientPingTimes.delete(clientId);
      this.clientDeviceId.delete(clientId);
      if (userId) {
        const session = this.userSessions.get(userId);
        if (session) {
          const ip = session.clientIps.get(clientId) || Array.from(session.clientIps.values())[0] || "";
          session.clientIds.delete(clientId);
          session.clientIps.delete(clientId);
          if (session.clientIds.size === 0) {
            this.userSessions.delete(userId);
            this.pushToBufferQueue({
              userId,
              loginTime: new Date(session.loginTime),
              logoutTime: /* @__PURE__ */ new Date(),
              duration: Math.floor((now - session.loginTime) / 1e3),
              logoutReason: "timeout",
              ip,
              userAgent: session.userAgent,
              status: session.status
            });
          }
        }
      }
    }
    this.broadcastOnlineUsers();
  }
  /**
   * 将会话日志缓冲队列批量写入数据库
   */
  async flushBufferQueue() {
    if (this.bufferQueue.length === 0) return;
    const entries = this.bufferQueue.splice(0, this.bufferQueue.length);
    const repo = this.db.getRepository("sessionLogs");
    try {
      await repo.createMany({ records: entries });
      this.bufferRetryCount = 0;
    } catch (error) {
      this.bufferRetryCount++;
      this.app.logger.error(
        `[online-count] Failed to flush session logs (retry ${this.bufferRetryCount}/${MAX_BUFFER_RETRIES})`,
        error
      );
      if (this.bufferRetryCount >= MAX_BUFFER_RETRIES) {
        this.app.logger.error(
          `[online-count] Buffer flush retry limit exceeded, discarding ${entries.length} log entries`
        );
        this.bufferRetryCount = 0;
      } else {
        this.bufferQueue.unshift(...entries);
      }
    }
  }
  /**
   * 向缓冲队列追加会话日志，超过容量上限时丢弃旧日志。
   */
  pushToBufferQueue(entry) {
    if (this.bufferQueue.length >= MAX_BUFFER_SIZE) {
      this.app.logger.warn("[online-count] Buffer queue full, discarding oldest log entry");
      this.bufferQueue.shift();
    }
    this.bufferQueue.push(entry);
  }
  // ===== 在线用户 API =====
  /** 获取在线用户列表，根据 visibleToAll 配置决定是否所有登录用户可见 */
  // 以网关切真实 WS 连接为权威源，按 userId 聚合真实连接数与 IP，根治 userSessions 漂移导致计数偏差
  // 从网关 WS 客户端提取 IP：x-forwarded-for/x-real-ip → ws socket.remoteAddress → upgradeReq.socket，归一化 IPv6
  extractIpFromGatewayClient(client) {
    var _a, _b, _c, _d;
    if (!client) return void 0;
    const ipFromHeader = extractClientIp(client.headers);
    if (ipFromHeader) return normalizeIp(ipFromHeader);
    const ws = client.ws;
    const raw = ((_a = ws == null ? void 0 : ws._socket) == null ? void 0 : _a.remoteAddress) ?? ((_b = client == null ? void 0 : client._socket) == null ? void 0 : _b.remoteAddress) ?? ((_d = (_c = client == null ? void 0 : client.upgradeReq) == null ? void 0 : _c.socket) == null ? void 0 : _d.remoteAddress);
    if (raw) return normalizeIp(raw);
    return void 0;
  }
  /** 按 clientId 从网关取真实客户端 IP（供 onWsSetTag 写入 clientIps） */
  getClientIpFromGateway(clientId) {
    var _a;
    const wsServer = (_a = import_server.Gateway.getInstance()) == null ? void 0 : _a.wsServer;
    if (!wsServer) return void 0;
    const client = wsServer.webSocketClients.get(clientId);
    if (!client) return void 0;
    return this.extractIpFromGatewayClient(client);
  }
  /** 按 clientId 从网关取客户端 User-Agent */
  getClientUserAgentFromGateway(clientId) {
    var _a;
    const wsServer = (_a = import_server.Gateway.getInstance()) == null ? void 0 : _a.wsServer;
    if (!wsServer) return "";
    const client = wsServer.webSocketClients.get(clientId);
    if (!(client == null ? void 0 : client.headers)) return "";
    const ua = client.headers["user-agent"];
    if (!ua) return "";
    return Array.isArray(ua) ? ua[0] ?? "" : ua;
  }
  getGatewayOnlineUsers() {
    var _a;
    const result = /* @__PURE__ */ new Map();
    const wsServer = (_a = import_server.Gateway.getInstance()) == null ? void 0 : _a.wsServer;
    if (!wsServer) return result;
    const appTag = `app#${this.app.name}`;
    for (const [clientId, client] of wsServer.webSocketClients) {
      if (!client.tags.has(appTag)) continue;
      let userId = null;
      for (const tag of client.tags) {
        if (tag.startsWith("userId#")) {
          userId = tag.slice("userId#".length);
          break;
        }
      }
      if (!userId) continue;
      let entry = result.get(userId);
      if (!entry) {
        entry = { clientIds: [], ips: [] };
        result.set(userId, entry);
      }
      entry.clientIds.push(clientId);
      const clientIp = this.extractIpFromGatewayClient(client);
      if (clientIp && !entry.ips.includes(clientIp)) {
        entry.ips.push(clientIp);
      }
    }
    return result;
  }
  /**
   * 合并在线名单：权威名单来自网关真实 WS 连接（getGatewayOnlineUsers），
   * 富化字段（nickname / status / roleName / loginTime）来自本插件 `userSessions`。
   * 若某 userId 在网关中存在但 `userSessions` 缺失（极端漂移场景），用最小默认值兜底，
   * 保证不漏计，且 status 默认 ACTIVE。
   */
  buildOnlineUsers() {
    const now = Date.now();
    const gatewayUsers = this.getGatewayOnlineUsers();
    const users = [];
    for (const [userId, gw] of gatewayUsers) {
      const sess = this.userSessions.get(userId);
      const loginTime = (sess == null ? void 0 : sess.loginTime) ?? now;
      users.push({
        userId,
        nickname: (sess == null ? void 0 : sess.nickname) ?? `User ${userId}`,
        clientCount: gw.clientIds.length,
        loginTime,
        duration: Math.floor((now - loginTime) / 1e3),
        status: (sess == null ? void 0 : sess.status) ?? "ACTIVE",
        ip: gw.ips[0] || "unknown",
        roleName: (sess == null ? void 0 : sess.roleName) ?? "",
        blacklisted: (sess == null ? void 0 : sess.blacklisted) ?? false
      });
    }
    users.sort((a, b) => b.loginTime - a.loginTime);
    return users;
  }
  /**
   * 取某 userId 在当前 app 下的全部真实 WS clientId：
   * 优先来自网关权威连接，再补充本插件 userSessions 中记录的 clientIds（防漂移遗漏）。
   * 供 kickUser 使用，确保"列表显示在线即可被踢"。
   */
  getClientIdsByUserId(userId) {
    var _a;
    const ids = /* @__PURE__ */ new Set();
    const wsServer = (_a = import_server.Gateway.getInstance()) == null ? void 0 : _a.wsServer;
    const appTag = `app#${this.app.name}`;
    if (wsServer) {
      for (const [clientId, client] of wsServer.webSocketClients) {
        if (!client.tags.has(appTag)) continue;
        if (client.tags.has(`userId#${userId}`)) {
          ids.add(clientId);
        }
      }
    }
    const sess = this.userSessions.get(userId);
    if (sess) {
      for (const cid of sess.clientIds) ids.add(cid);
    }
    return Array.from(ids);
  }
  async listOnlineUsers(ctx, next) {
    if (!this.config.visibleToAll) {
      if (!this.isAdminRequest(ctx)) {
        ctx.throw(403, "Access denied");
      }
    }
    const users = this.buildOnlineUsers();
    const signature = users.map((u) => u.userId).sort().join(",");
    if (signature !== this.lastListSignature) {
      this.lastListSignature = signature;
      this.app.logger.info(`[online-count] online users changed -> count=${users.length} users=[${signature}]`);
    }
    ctx.body = {
      users,
      totalCount: users.length
    };
    await next();
  }
  /**
   * 强制下线用户（附加约束：踢出不等于永久封禁）
   * 1. 向目标发送 FORCE_LOGOUT 消息
   * 2. 断开 WebSocket 连接
   * 3. 销毁当前 Token 缓存（JWT 黑名单，TTL = token 剩余有效期）
   * 4. 从内存中移除该用户全部会话并广播
   * ⚠️ 绝对禁止修改数据库 users 表的 blacklisted 字段 —— 踢出是临时下线，重新登录应正常放行
   */
  async kickUser(ctx, next) {
    var _a, _b, _c, _d, _e;
    const { userId } = ((_b = (_a = ctx.action) == null ? void 0 : _a.params) == null ? void 0 : _b.values) || ((_c = ctx.request) == null ? void 0 : _c.body) || {};
    if (!userId) {
      ctx.throw(400, "userId is required");
    }
    const targetUserId = String(userId);
    const targetUser = await (ctx.db ?? this.db).getRepository("users").findOne({ filterByTk: targetUserId, appends: ["roles"] });
    if ((_d = targetUser == null ? void 0 : targetUser.roles) == null ? void 0 : _d.some((r) => r.name === "root")) {
      ctx.throw(403, "Root user cannot be kicked out");
    }
    const clientIds = this.getClientIdsByUserId(targetUserId);
    if (clientIds.length === 0) {
      ctx.body = { success: false, message: "User is not online" };
      await next();
      return;
    }
    for (const clientId of clientIds) {
      this.app.emit("ws:sendToClient", {
        clientId,
        message: { type: "FORCE_LOGOUT", payload: { reason: "kicked" } }
      });
      setTimeout(() => {
        this.app.emit("ws:disconnectClient", { clientId });
      }, 0);
    }
    const userToken = (_e = ctx.get) == null ? void 0 : _e.call(ctx, "X-Kick-Token");
    if (userToken) {
      try {
        const payload = JSON.parse(Buffer.from(userToken.split(".")[1], "base64").toString());
        const expiresAt = payload.exp ? payload.exp * 1e3 : 0;
        const remainingTTL = Math.floor((expiresAt - Date.now()) / 1e3);
        if (remainingTTL > 0) {
          await this.tokenBlacklist.set(userToken, true, remainingTTL);
        }
      } catch {
        await this.tokenBlacklist.set(userToken, true, 5 * 60);
      }
    }
    this.removeUserSessions(targetUserId, "kicked");
    ctx.body = { success: true };
    await next();
  }
  /**
   * 解除用户黑名单
   * 同时清除该用户的黑名单缓存（Fix #4：避免解封后仍被缓存拦截 60s）
   */
  async unblacklistUser(ctx, next) {
    var _a, _b, _c;
    const { userId } = ((_b = (_a = ctx.action) == null ? void 0 : _a.params) == null ? void 0 : _b.values) || ((_c = ctx.request) == null ? void 0 : _c.body) || {};
    if (!userId) {
      ctx.throw(400, "userId is required");
    }
    const userRepo = this.db.getRepository("users");
    await userRepo.update({
      filterByTk: String(userId),
      values: { blacklisted: false }
    });
    try {
      await this.tokenBlacklist.del(`${import_auth_middleware.USER_BLACKLIST_PREFIX}${userId}`);
    } catch {
    }
    ctx.body = { success: true };
    await next();
  }
  /**
   * 禁用（拉黑）用户：
   * 1. 将 users.blacklisted 置为 true
   * 2. 立即强制下线其全部在线连接（FORCE_LOGOUT + WS 断开 + 内存移除）
   * 3. 写入 JWT 黑名单缓存，使其当前 Token 立即失效（重新登录也会被拦截）
   * 与 kickUser 的区别：kick 是临时下线（不写 blacklisted），禁用是持久封禁。
   * root 用户禁止被禁用。
   */
  async blacklistUser(ctx, next) {
    var _a, _b, _c, _d;
    const { userId } = ((_b = (_a = ctx.action) == null ? void 0 : _a.params) == null ? void 0 : _b.values) || ((_c = ctx.request) == null ? void 0 : _c.body) || {};
    if (!userId) {
      ctx.throw(400, "userId is required");
    }
    const targetUserId = String(userId);
    const targetUser = await (ctx.db ?? this.db).getRepository("users").findOne({ filterByTk: targetUserId, appends: ["roles"] });
    if ((_d = targetUser == null ? void 0 : targetUser.roles) == null ? void 0 : _d.some((r) => r.name === "root")) {
      ctx.throw(403, "Root user cannot be blacklisted");
    }
    await this.db.getRepository("users").update({
      filterByTk: targetUserId,
      values: { blacklisted: true }
    });
    const clientIds = this.getClientIdsByUserId(targetUserId);
    for (const clientId of clientIds) {
      this.app.emit("ws:sendToClient", {
        clientId,
        message: { type: "FORCE_LOGOUT", payload: { reason: "blacklisted" } }
      });
      setTimeout(() => {
        this.app.emit("ws:disconnectClient", { clientId });
      }, 0);
    }
    this.removeUserSessions(targetUserId, "blacklisted");
    try {
      await this.tokenBlacklist.set(`${import_auth_middleware.USER_BLACKLIST_PREFIX}${targetUserId}`, true, 30 * 24 * 60 * 60);
    } catch {
    }
    ctx.body = { success: true };
    await next();
  }
  /**
   * 已禁用（黑名单）用户列表
   * 从 users 表查 blacklisted=true 的记录（与在线状态无关——被禁用的用户已被强制下线，
   * 不会出现在在线列表中，必须从数据库查才能让管理员看到并恢复）。
   * 返回：userId、nickname、username、当前是否在线、是否 root（root 不应被禁用，兜底过滤）。
   */
  async listBlacklistedUsers(ctx, next) {
    var _a, _b;
    const repo = ((_b = (_a = ctx.db) == null ? void 0 : _a.getRepository) == null ? void 0 : _b.call(_a, "users")) ?? this.db.getRepository("users");
    const users = await repo.find({
      filter: { blacklisted: true },
      appends: ["roles"]
    });
    const onlineIds = new Set(this.getGatewayOnlineUsers().keys());
    const data = (users || []).filter((u) => !(u.roles ?? []).some((r) => r.name === "root")).map((u) => ({
      userId: String(u.id),
      nickname: u.nickname || u.username || `User ${u.id}`,
      username: u.username,
      online: onlineIds.has(String(u.id))
    }));
    ctx.body = { users: data, count: data.length };
    await next();
  }
  // ===== 系统广播 =====
  /**
   * 管理员发送全站广播消息
   * 1. 保存广播到 systemBroadcasts 表，获取生成的 id
   * 2. 通过 WS 向所有在线客户端推送 SYSTEM_BROADCAST 消息（含 broadcastId）
   */
  async broadcastMessage(ctx, next) {
    var _a, _b, _c;
    const actionValues = ((_b = (_a = ctx.action) == null ? void 0 : _a.params) == null ? void 0 : _b.values) || void 0;
    const requestBody = ((_c = ctx.request) == null ? void 0 : _c.body) || void 0;
    const bodyData = requestBody == null ? void 0 : requestBody.data;
    const hasContent = (obj) => !!obj && Object.keys(obj).length > 0;
    let inputValues = {};
    if (hasContent(actionValues)) {
      inputValues = actionValues;
    } else if (hasContent(bodyData)) {
      inputValues = bodyData;
    } else if (hasContent(requestBody)) {
      inputValues = requestBody;
    } else {
      try {
        const rawBody = await new Promise((resolve, reject) => {
          const req = ctx.req;
          if (!req || req.readableEnded || typeof req.on !== "function") {
            resolve("");
            return;
          }
          const chunks = [];
          req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
          req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
          req.on("error", (err) => reject(err instanceof Error ? err : new Error(String(err))));
        });
        if (rawBody) {
          inputValues = JSON.parse(rawBody);
        }
      } catch {
      }
    }
    this.app.logger.debug("[online-count] broadcastMessage: inputValues parsed successfully");
    const { content, msgType = "info", sender = "system" } = inputValues;
    if (!content) {
      ctx.throw(400, "content is required");
    }
    const repo = (ctx.db ?? this.db).getRepository("systemBroadcasts");
    const broadcast = await repo.create({
      values: {
        content: String(content),
        msgType: String(msgType),
        sender: String(sender),
        // 默认 7 天后过期，前端可覆盖
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1e3)
      }
    });
    this.app.logger.info(
      `[online-count] broadcastMessage: id=${broadcast.id} msgType=${broadcast.msgType} sender=${broadcast.sender}`
    );
    this.app.emit("ws:sendToCurrentApp", {
      message: {
        type: "SYSTEM_BROADCAST",
        payload: {
          id: broadcast.id,
          content: broadcast.content,
          msgType: broadcast.msgType,
          sender: broadcast.sender,
          createdAt: broadcast.createdAt
        }
      }
    });
    ctx.body = broadcast;
    await next();
  }
  /**
   * 用户标记广播已读（幂等：userId + broadcastId 唯一索引防止重复记录）
   */
  async markBroadcastRead(ctx, next) {
    var _a, _b, _c, _d, _e;
    const inputValues = ((_b = (_a = ctx.action) == null ? void 0 : _a.params) == null ? void 0 : _b.values) || ((_c = ctx.request) == null ? void 0 : _c.body) || {};
    const { broadcastId } = inputValues;
    const userId = (_e = (_d = ctx.auth) == null ? void 0 : _d.user) == null ? void 0 : _e.id;
    if (!broadcastId || !userId) {
      ctx.throw(400, "broadcastId and userId are required");
    }
    const repo = (ctx.db ?? this.db).getRepository("userBroadcastReads");
    const existing = await repo.findOne({
      filter: {
        userId: String(userId),
        broadcastId: Number(broadcastId)
      }
    });
    if (!existing) {
      await repo.create({
        values: {
          userId: String(userId),
          broadcastId: Number(broadcastId),
          readAt: /* @__PURE__ */ new Date()
        }
      });
    }
    ctx.body = { success: true };
    await next();
  }
  /**
   * 计算某用户当前未读的广播列表（未过期且该用户尚未标记已读）。
   * 抽纯后供两处复用：
   * - syncUnreadBroadcasts：登录时经 WS 推送给客户端（SYSTEM_BROADCAST_SYNC）
   * - listUnreadBroadcasts：客户端在 WS 鉴权成功后主动拉取（online_users:list_broadcasts），
   *   作为推送的兜底，彻底解决「登录后收不到历史广播」的竞态（推送早于前端监听器就绪）。
   */
  async getUnreadBroadcasts(userId) {
    const broadcastRepo = this.db.getRepository("systemBroadcasts");
    const readRepo = this.db.getRepository("userBroadcastReads");
    const now = /* @__PURE__ */ new Date();
    const broadcasts = await broadcastRepo.find({
      filter: {
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]
      },
      sort: ["-createdAt"]
    });
    if (!broadcasts || !broadcasts.length) return [];
    const reads = await readRepo.find({
      filter: { userId },
      fields: ["broadcastId"]
    });
    const readBroadcastIds = new Set(reads.map((r) => r.broadcastId));
    return broadcasts.filter((b) => !readBroadcastIds.has(b.id)).map((b) => ({
      id: b.id,
      content: b.content,
      msgType: b.msgType,
      sender: b.sender,
      createdAt: b.createdAt
    }));
  }
  /**
   * 同步未读系统广播给新连接的客户端（在 onWsSetTag 中调用）
   * 查询所有未过期且该用户未读的广播，通过 SYSTEM_BROADCAST_SYNC 消息发送给指定客户端
   * 此方法由 onWsSetTag 调用，失败时由调用方 catch 处理，不影响主流程
   */
  async syncUnreadBroadcasts(userId, clientId) {
    const unreadBroadcasts = await this.getUnreadBroadcasts(userId);
    if (!unreadBroadcasts.length) return;
    this.app.emit("ws:sendToClient", {
      clientId,
      message: {
        type: "SYSTEM_BROADCAST_SYNC",
        payload: { broadcasts: unreadBroadcasts }
      }
    });
  }
  /**
   * 当前登录用户主动拉取未读广播（online_users:list_broadcasts）。
   * 作为 WS 推送的兜底，确保登录后稳定收到已发送但未读的广播。
   */
  async listUnreadBroadcasts(ctx, next) {
    var _a, _b;
    const userId = (_b = (_a = ctx.auth) == null ? void 0 : _a.user) == null ? void 0 : _b.id;
    if (!userId) {
      ctx.throw(401, "Unauthorized");
    }
    const unreadBroadcasts = await this.getUnreadBroadcasts(String(userId));
    ctx.body = { broadcasts: unreadBroadcasts };
    await next();
  }
  /**
   * 管理员查看全部系统广播及其已读统计（online_users:broadcasts）。
   * 返回每条广播的内容、级别、发送人、过期时间，以及已读人数与系统用户总数，
   * 供管理端「广播管理」页面展示「哪些人已读」的概览。
   */
  async listBroadcasts(ctx, next) {
    if (!this.isAdminRequest(ctx)) {
      ctx.throw(403, "Access denied");
    }
    const broadcastRepo = this.db.getRepository("systemBroadcasts");
    const readRepo = this.db.getRepository("userBroadcastReads");
    const userRepo = this.db.getRepository("users");
    const broadcasts = await broadcastRepo.find({ sort: ["-createdAt"] });
    const totalUsers = await userRepo.count();
    const broadcastIds = broadcasts.map((b) => b.id);
    const allReads = broadcastIds.length > 0 ? await readRepo.find({ filter: { broadcastId: { $in: broadcastIds } }, fields: ["broadcastId"] }) : [];
    const readCountMap = /* @__PURE__ */ new Map();
    for (const r of allReads) {
      readCountMap.set(r.broadcastId, (readCountMap.get(r.broadcastId) ?? 0) + 1);
    }
    const result = broadcasts.map((b) => ({
      id: b.id,
      content: b.content,
      msgType: b.msgType,
      sender: b.sender,
      createdAt: b.createdAt,
      expiresAt: b.expiresAt,
      readCount: readCountMap.get(b.id) ?? 0,
      totalUsers
    }));
    ctx.body = { broadcasts: result };
    await next();
  }
  /**
   * 管理员查看某条广播的已读用户明细（online_users:broadcast_reads）。
   * 返回已读用户列表（userId / nickname / readAt）与已读人数、系统用户总数。
   */
  async broadcastReads(ctx, next) {
    var _a, _b, _c, _d, _e;
    if (!this.isAdminRequest(ctx)) {
      ctx.throw(403, "Access denied");
    }
    const actionParams = ((_a = ctx.action) == null ? void 0 : _a.params) ?? {};
    const broadcastId = ((_b = actionParams == null ? void 0 : actionParams.values) == null ? void 0 : _b.broadcastId) ?? (actionParams == null ? void 0 : actionParams.broadcastId) ?? ((_c = ctx.query) == null ? void 0 : _c.broadcastId) ?? ((_e = (_d = ctx.request) == null ? void 0 : _d.body) == null ? void 0 : _e.broadcastId);
    if (!broadcastId) {
      ctx.throw(400, "broadcastId is required");
    }
    const readRepo = this.db.getRepository("userBroadcastReads");
    const reads = await readRepo.find({
      filter: { broadcastId: Number(broadcastId) },
      appends: ["user"],
      sort: ["-readAt"]
    });
    const readers = reads.map((r) => {
      var _a2;
      return {
        userId: r.userId,
        nickname: ((_a2 = r.user) == null ? void 0 : _a2.nickname) ?? "",
        readAt: r.readAt
      };
    });
    const userRepo = this.db.getRepository("users");
    const totalUsers = await userRepo.count();
    ctx.body = { readers, readCount: readers.length, totalUsers };
    await next();
  }
  /**
   * 管理员删除广播（支持单条与批量）：POST { ids: number[] } 或 { id: number }。
   * 同时级联删除对应的已读记录（userBroadcastReads）。
   * 注意：已通过 WS 推送并弹出的通知无法撤回，删除后：
   * - 广播管理列表立即移除；
   * - 其他用户后续拉取未读（list_broadcasts / 登录同步）不再包含该广播。
   */
  async deleteBroadcasts(ctx, next) {
    var _a, _b, _c, _d;
    if (!this.isAdminRequest(ctx)) {
      ctx.throw(403, "Access denied");
    }
    const actionParams = ((_a = ctx.action) == null ? void 0 : _a.params) ?? {};
    const body = ((_b = ctx.request) == null ? void 0 : _b.body) ?? {};
    const rawIds = ((_c = actionParams == null ? void 0 : actionParams.values) == null ? void 0 : _c.ids) ?? (actionParams == null ? void 0 : actionParams.ids) ?? body.ids ?? (Array.isArray(body) ? body : []);
    const singleId = ((_d = actionParams == null ? void 0 : actionParams.values) == null ? void 0 : _d.id) ?? (actionParams == null ? void 0 : actionParams.id) ?? body.id;
    const ids = [];
    if (Array.isArray(rawIds)) {
      rawIds.forEach((v) => {
        const n = Number(v);
        if (Number.isInteger(n) && n > 0) ids.push(n);
      });
    } else if (singleId !== void 0 && singleId !== null) {
      const n = Number(singleId);
      if (Number.isInteger(n) && n > 0) ids.push(n);
    }
    if (!ids.length) {
      ctx.throw(400, "ids is required");
    }
    const uniqueIds = Array.from(new Set(ids));
    this.app.logger.info(`[online-count] deleteBroadcasts: ids=${JSON.stringify(uniqueIds)}`);
    const readRepo = this.db.getRepository("userBroadcastReads");
    const broadcastRepo = this.db.getRepository("systemBroadcasts");
    await readRepo.destroy({ filter: { broadcastId: { $in: uniqueIds } } });
    const deleted = await broadcastRepo.destroy({ filter: { id: { $in: uniqueIds } } });
    ctx.body = { deleted: typeof deleted === "number" ? deleted : uniqueIds.length };
    await next();
  }
  // ===== 广播 =====
  /**
   * 广播在线用户列表给所有客户端（逻辑三·后端 Throttle 入口）
   * 所有调用都经过 throttledBroadcast（2000ms/次，leading + trailing）。
   */
  broadcastOnlineUsers() {
    this.throttledBroadcast();
  }
  /**
   * 实际执行广播（逻辑三·后端 Diff 拦截）
   * 下发前比对上次快照：Diff 对象只包含 totalCount / userId / status / clientCount，
   * 剔除 duration、loginTime 等随时间自增的动态字段 —— 只有实质状态变化才真正 emit，
   * 杜绝"每秒时长变化导致持续广播"的无效流量。
   */
  doBroadcastOnlineUsers() {
    const users = this.buildOnlineUsers();
    const totalCount = users.length;
    const snapshotKey = JSON.stringify({
      totalCount,
      users: users.map((u) => ({
        userId: u.userId,
        status: u.status,
        clientCount: u.clientCount
      }))
    });
    if (snapshotKey === this.lastBroadcastSnapshot) {
      this.app.logger.debug("[online-count] broadcastOnlineUsers: snapshot unchanged, skip emit");
      return;
    }
    this.lastBroadcastSnapshot = snapshotKey;
    this.app.logger.debug(`[online-count] broadcastOnlineUsers: totalCount=${totalCount} users=${users.length}`);
    this.app.emit("ws:sendToCurrentApp", {
      message: {
        type: "online_users",
        payload: {
          users: users.slice(0, 20),
          totalCount
        }
      }
    });
  }
}
var plugin_default = PluginOnlineCountServer;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PluginOnlineCountServer
});
