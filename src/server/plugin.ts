import { Cache } from '@nocobase/cache';
import { Database } from '@nocobase/database';
import { Plugin, Gateway } from '@nocobase/server';
import { throttle } from 'lodash';
import { createTokenBlacklistMiddleware, USER_BLACKLIST_PREFIX } from './auth-middleware';
import { computeEnforceSingleDevice, computeKickOnNewConnection } from './device-logic';

/** 用户会话：userId 为键，clientIds 为当前所有 WS 连接，单设备模式下最多 1 个 */
interface UserSession {
  userId: string;
  nickname: string;
  clientIds: Set<string>;
  clientIps: Map<string, string>;
  loginTime: number;
  status: 'ACTIVE' | 'AWAY';
  /** 用户角色名，用于前端判断是否显示强制下线按钮（root 不显示） */
  roleName: string;
  /** 是否被管理员拉黑（禁用），用于前端显示禁用/恢复按钮 */
  blacklisted: boolean;
  /** 客户端 User-Agent，供会话日志使用 */
  userAgent: string;
}

/**
 * 会话日志记录（用于异步批量写入 SessionLogs 表）
 */
interface SessionLogEntry {
  userId: string;
  loginTime: Date;
  logoutTime: Date;
  duration: number;
  logoutReason: string;
  ip: string;
  userAgent: string;
  status: string;
}

/** WebSocket 客户端扩展接口（运行时 webSocketClients 中的客户端实际携带 headers 字段） */
interface WebSocketClientWithIp {
  headers?: Record<string, string | string[] | undefined>;
  tags: Set<string>;
  ws: { close(code?: number, reason?: string): void; _socket?: { remoteAddress?: string } };
  _socket?: { remoteAddress?: string };
  upgradeReq?: { socket?: { remoteAddress?: string } };
}

interface UserRole {
  name: string;
}

interface UserRecord {
  id: string | number;
  nickname?: string;
  username?: string;
  blacklisted?: boolean;
  roles?: UserRole[];
}

interface BroadcastRecord {
  id: number;
  content: string;
  msgType: string;
  sender: string;
  createdAt: string;
  expiresAt: string | null;
}

interface ReadRecord {
  userId: string;
  broadcastId: number;
  readAt: string;
  user?: { nickname?: string };
}

interface ActionParams {
  values?: Record<string, unknown>;
  resourceName?: string;
  actionName?: string;
  broadcastId?: unknown;
  ids?: unknown[];
  id?: unknown;
}

/** 插件方法中使用的 Koa 上下文最小接口 */
interface PluginContext {
  db?: Database;
  auth?: { user?: { id?: string | number; roles?: UserRole[] } };
  state?: { currentRole?: string; currentRoles?: Array<string | UserRole> };
  request?: { path?: string; body?: Record<string, unknown> };
  action?: { resourceName?: string; actionName?: string; params?: ActionParams };
  body?: unknown;
  get?: (key: string) => string;
  query?: Record<string, unknown>;
  throw: (code: number, message: string) => void;
  req?: { readableEnded?: boolean; on?: (event: string, listener: (...args: unknown[]) => void) => void };
}

/**
 * 广播节流间隔（毫秒）：最高 2000ms/次，leading + trailing
 */
const BROADCAST_THROTTLE_MS = 2000;
const CONFIG_KEY = 'default';
/** 缓冲区最大容量：超过此值后新日志将被丢弃，防止 DB 不可用时内存无限膨胀 */
const MAX_BUFFER_SIZE = 1000;
/** 缓冲区最大连续失败次数：超过后清空队列，防止无限重试 */
const MAX_BUFFER_RETRIES = 5;

/**
 * 从 WebSocket 升级请求的 HTTP 头中提取真实客户端 IP。
 * 优先级：x-forwarded-for（第一个 IP）> x-real-ip。
 */
function normalizeIp(ip: string): string {
  let s = ip.trim();
  // 去掉 IPv6 映射前缀 ::ffff:1.2.3.4 -> 1.2.3.4
  if (s.startsWith('::ffff:')) s = s.slice(7);
  // 回环地址归一化，至少给出可读值而非 unknown
  if (s === '::1') s = '127.0.0.1';
  return s;
}

function extractClientIp(headers?: Record<string, string | string[] | undefined>): string | undefined {
  if (!headers) return undefined;
  const forwarded = headers['x-forwarded-for'];
  if (forwarded) {
    const firstIp = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
    return firstIp?.trim() || undefined;
  }
  const realIp = headers['x-real-ip'];
  if (realIp) {
    return Array.isArray(realIp) ? realIp[0] : realIp;
  }
  return undefined;
}

export class PluginOnlineCountServer extends Plugin {
  /** 用户会话 Map，key = userId */
  userSessions: Map<string, UserSession> = new Map();
  /** clientId -> userId 反向映射 */
  clientIdToUserId: Map<string, string> = new Map();
  /** clientId -> 最后心跳时间戳 */
  clientPingTimes: Map<string, number> = new Map();
  /** clientId -> 设备指纹（同浏览器多标签页共享同一 deviceId，不同浏览器/设备各自独立） */
  clientDeviceId: Map<string, string> = new Map();
  /** 会话日志缓冲队列，每 60 秒批量写入数据库 */
  bufferQueue: SessionLogEntry[] = [];
  /** 缓冲区连续写入失败次数，成功时重置，超过上限后清空队列 */
  private bufferRetryCount = 0;
  /** 插件配置（内存存储） */
  config: { visibleToAll: boolean; singleSession: boolean } = {
    visibleToAll: true,
    singleSession: false,
  };
  /** 上次 listOnlineUsers 输出的 userId 签名，用于变化时才打印调试日志（避免轮询刷屏） */
  private lastListSignature = '';
  /** 按 userId 串行化 onWsSetTag 执行，防止并发竞态（互斥登录的核心保障） */
  private userSetTagLocks: Map<string, Promise<void>> = new Map();
  /** Cache 实例，用于 JWT 黑名单存储 */
  tokenBlacklist!: Cache;

  /**
   * 广播节流器（逻辑三·后端 Throttle）：所有 broadcastOnlineUsers() 调用都经过它，
   * 最高 2000ms/次（leading 立即执行 + trailing 兜底），防止状态高频变化导致广播风暴。
   */
  private throttledBroadcast = throttle(() => this.doBroadcastOnlineUsers(), BROADCAST_THROTTLE_MS, {
    leading: true,
    trailing: true,
  });
  // Diff 快照：仅含 totalCount/userId/status/clientCount，剔除自增字段，仅实质变化才 emit
  private lastBroadcastSnapshot: string | null = null;

  // 定时器引用
  heartbeatTimer: NodeJS.Timeout | null = null;
  cleanupTimer: NodeJS.Timeout | null = null;
  flushTimer: NodeJS.Timeout | null = null;
  retentionTimer: NodeJS.Timeout | null = null;

  async load() {
    // ===== 初始化 Cache（用于 JWT 黑名单） =====
    this.tokenBlacklist = await this.app.cacheManager.createCache({
      name: 'online-count-token-blacklist',
      prefix: 'online-count-token-blacklist',
      store: 'memory',
    });

    // ===== 确保 ws:sendToClient / ws:disconnectClient 事件已注册 =====
    // 正常情况下 bindAppWSEvents 已注册这些事件，但作为安全网，如果未注册则直接访问 Gateway.wsServer
    if (this.app.listenerCount('ws:sendToClient') === 0) {
      this.app.logger.warn('[online-count] ws:sendToClient not registered, using Gateway fallback');
      this.app.on('ws:sendToClient', ({ clientId, message }) => {
        const wsServer = Gateway.getInstance().wsServer;
        if (wsServer) {
          wsServer.sendToClient(clientId, message);
        }
      });
    }
    if (this.app.listenerCount('ws:disconnectClient') === 0) {
      this.app.logger.warn('[online-count] ws:disconnectClient not registered, using Gateway fallback');
      this.app.on('ws:disconnectClient', ({ clientId }) => {
        const wsServer = Gateway.getInstance().wsServer;
        if (wsServer) {
          const client = wsServer.webSocketClients.get(clientId);
          if (client) {
            client.ws.close(4001, 'force logout');
          }
        }
      });
    }

    // ===== 注册 REST API 资源 =====
    this.app.resourceManager.define({
      name: 'online_users',
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
        broadcast_delete: this.deleteBroadcasts.bind(this),
      },
    });

    this.app.logger.debug('[online-count] resource online_users registered with 11 actions');

    // 在线用户列表：所有登录用户可查看
    this.app.acl.allow('online_users', 'list', 'loggedIn');
    // 强制下线：仅管理员和 root 角色
    this.app.acl.allow('online_users', 'kick', (ctx) => {
      return this.isAdminRequest(ctx);
    });
    // 禁用（拉黑）：仅管理员和 root 角色
    this.app.acl.allow('online_users', 'blacklist', (ctx) => {
      return this.isAdminRequest(ctx);
    });
    // 解除黑名单：仅管理员和 root 角色
    this.app.acl.allow('online_users', 'unblacklist', (ctx) => {
      return this.isAdminRequest(ctx);
    });
    // 已禁用用户列表：仅管理员和 root 角色
    this.app.acl.allow('online_users', 'blacklisted_users', (ctx) => {
      return this.isAdminRequest(ctx);
    });
    // 发送广播：仅管理员和 root 角色
    this.app.acl.allow('online_users', 'broadcast', (ctx) => {
      return this.isAdminRequest(ctx);
    });
    // 标记已读：所有登录用户
    this.app.acl.allow('online_users', 'read_broadcast', 'loggedIn');
    // 拉取未读广播：所有登录用户
    this.app.acl.allow('online_users', 'list_broadcasts', 'loggedIn');
    // 广播管理（列表 + 已读明细）：仅管理员和 root 角色
    this.app.acl.allow('online_users', 'broadcasts', (ctx) => {
      return this.isAdminRequest(ctx);
    });
    this.app.acl.allow('online_users', 'broadcast_reads', (ctx) => {
      return this.isAdminRequest(ctx);
    });
    // 删除广播（单条/批量）：仅管理员和 root 角色
    this.app.acl.allow('online_users', 'broadcast_delete', (ctx) => {
      return this.isAdminRequest(ctx);
    });

    // ===== 配置 API =====
    this.app.resourceManager.define({
      name: 'online_count_config',
      actions: {
        get: this.getConfig.bind(this),
        set: this.setConfig.bind(this),
      },
    });
    this.app.acl.allow('online_count_config', 'get', 'loggedIn');
    this.app.acl.allow('online_count_config', 'set', (ctx) => {
      return this.isAdminRequest(ctx);
    });

    // ===== WebSocket 事件监听 =====
    // 逻辑一·登录触发更新：ws:setTag 生命周期钩子 -> 分配会话 / 互斥登录 / 广播（节流）
    this.app.on('ws:setTag', this.onWsSetTag.bind(this));
    // 客户端建连时上报的设备指纹（同浏览器多标签页共享同一 deviceId）。
    // 单会话模式下据此把「同浏览器多标签」归并为同一设备，不再互相踢下线。
    this.app.on('ws:message:online_device', this.onWsDeviceTag.bind(this));
    this.app.on('ws:removeTag', this.onWsRemoveTag.bind(this));
    this.app.on('ws:message:pong', this.onPong.bind(this));
    this.app.on('ws:message:STATUS_AWAY', this.onStatusAway.bind(this));
    this.app.on('ws:message:STATUS_ACTIVE', this.onStatusActive.bind(this));
    // 客户端退出登录（含正常登出 / 强制下线 / 异地登录）时主动上报，立即移除会话
    this.app.on('ws:message:LOGOUT_NOTIFY', this.onLogoutNotify.bind(this));

    // ===== 逻辑二·后端 API 截杀（最核心）：拦截 /api/auth:signOut，立即移除会话 =====
    // 用户发起注销请求的瞬间即从内存 userSessions 删除该用户、清理 clientId 映射并广播减人。
    // 不依赖 WS 延时断开或 90 秒心跳超时 —— 彻底杜绝"幽灵在线"。
    this.app.resourcer.use(async (ctx: PluginContext, next: () => Promise<void>) => {
      try {
        const resourceName = ctx.action?.resourceName;
        const actionName = ctx.action?.actionName;
        const path = ctx.request?.path || '';
        const isSignOut = (resourceName === 'auth' && actionName === 'signOut') || path.includes('/auth:signOut');

        if (isSignOut) {
          const userId = ctx.auth?.user?.id;
          if (userId != null) {
            this.app.logger.info(`[online-count] Intercepted auth:signOut, removing all sessions of user=${userId}`);
            this.removeUserSessions(String(userId), 'normal');
          }
        }
      } catch (error) {
        // 拦截器自身异常不得影响 signOut 主流程
        this.app.logger.error('[online-count] Error in signOut interceptor:', error);
      }
      await next();
    });

    // ===== Token 黑名单拦截中间件 =====
    // 使用 auth-middleware 模块，基于 Cache Manager 拦截被踢出用户的 JWT
    this.app.use(createTokenBlacklistMiddleware(this.tokenBlacklist, this.db, this.app.logger));

    // ===== 优雅停机（Graceful Shutdown） =====
    this.app.on('beforeStop', async () => {
      this.app.logger.info('[online-count] Graceful shutdown: flushing buffer and broadcasting SERVER_RESTART');
      // 强制将缓冲区的会话日志同步落盘
      await this.flushBufferQueue();
      // 广播 SERVER_RESTART 消息给所有在线客户端
      this.app.emit('ws:sendToCurrentApp', {
        message: {
          type: 'SERVER_RESTART',
          payload: { timestamp: Date.now() },
        },
      });
    });

    // ===== 冷热降级：每日凌晨 3 点清理超过 30 天的会话日志 =====
    this.scheduleDataRetention();
  }

  async afterEnable() {
    // 兜底自愈：确保本插件持久化表（配置表 / 会话日志表）存在。
    // 正常启动由核心 loadCollections + db.sync 统一建表；若因历史异常启动（如依赖插件崩溃、
    // db.sync 被中断）导致这两张表从未创建，则 setConfig/getConfig 会直接报 SQL
    // 「关系不存在」。此处显式补建，保证插件始终可正常启用。
    await this.ensureTablesExist();

    // 加载配置（表已确保存在）；用默认值兜底，避免任何残留 DB 异常阻断插件启用。
    try {
      await this.loadConfig();
    } catch (error) {
      this.app.logger.warn('[online-count] loadConfig failed, using in-memory defaults:', error);
    }

    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 30000);
    this.cleanupTimer = setInterval(() => this.cleanupStaleConnections(), 30000);
    this.flushTimer = setInterval(() => this.flushBufferQueue(), 60000);
  }

  /**
   * 确保本插件持久化表存在：配置表 onlineCountConfig 与会话日志表 sessionLogs。
   * 这两张表由 collections/ 目录定义，经核心 loadCollections + db.sync 创建；
   * 若因历史异常启动漏建，这里通过一次兜底 db.sync 补建（幂等、安全）。
   */
  private async ensureTablesExist() {
    const collections = ['onlineCountConfig', 'sessionLogs', 'systemBroadcasts', 'userBroadcastReads'];
    try {
      const missing: string[] = [];
      for (const name of collections) {
        const exists = await this.db.collectionExistsInDb(name).catch(() => false);
        if (!exists) missing.push(name);
      }
      if (missing.length > 0) {
        this.app.logger.warn(`[online-count] missing tables [${missing.join(', ')}], running db.sync to heal`);
        await this.db.sync();
      }
    } catch (error) {
      this.app.logger.warn('[online-count] ensureTablesExist heal sync failed:', error);
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
    const HOURLY = 60 * 60 * 1000;
    this.retentionTimer = setInterval(() => {
      const now = new Date();
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
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const repo = this.db.getRepository('sessionLogs');
      const count = await repo.destroy({
        filter: { loginTime: { $lt: cutoff } },
      });
      this.app.logger.info(
        `[online-count] Data retention: cleaned ${count} old session logs older than ${cutoff.toISOString()}`,
      );
    } catch (error) {
      this.app.logger.error('[online-count] Failed to clean old session logs', error);
    }
  }

  // ===== 配置管理 =====

  private isAdminRequest(ctx: PluginContext) {
    const roles = new Set<string>();
    if (ctx.state?.currentRole) {
      roles.add(ctx.state.currentRole);
    }
    for (const role of ctx.state?.currentRoles || []) {
      if (role) roles.add(typeof role === 'string' ? role : role.name);
    }
    for (const role of ctx.auth?.user?.roles || []) {
      if (role?.name) roles.add(role.name);
    }
    return roles.has('admin') || roles.has('root');
  }

  private async loadConfig(ctx?: PluginContext) {
    const repo = (ctx?.db || this.db).getRepository('onlineCountConfig');
    let record = await repo.findOne({ filterByTk: CONFIG_KEY });
    if (!record) {
      record = await repo.create({
        values: {
          key: CONFIG_KEY,
          visibleToAll: this.config.visibleToAll,
          singleSession: this.config.singleSession,
        },
      });
    }
    this.config = {
      visibleToAll: typeof record.visibleToAll === 'boolean' ? record.visibleToAll : true,
      singleSession: typeof record.singleSession === 'boolean' ? record.singleSession : false,
    };
    return this.config;
  }

  async getConfig(ctx: PluginContext, next: () => Promise<void>) {
    ctx.body = await this.loadConfig(ctx);
    await next();
  }

  async setConfig(ctx: PluginContext, next: () => Promise<void>) {
    // 优先从 ctx.action.params.values 读取，回退到 ctx.request.body（兼容不同请求处理路径）
    const inputValues = ctx.action?.params?.values || ctx.request?.body || {};
    const { visibleToAll, singleSession } = inputValues as Record<string, unknown>;
    this.app.logger.info(
      `[online-count] setConfig called visibleToAll=${visibleToAll} singleSession=${singleSession} current=${JSON.stringify(
        this.config,
      )}`,
    );
    if (typeof visibleToAll === 'boolean') {
      this.config.visibleToAll = visibleToAll;
    }
    if (typeof singleSession === 'boolean') {
      this.config.singleSession = singleSession;
    }
    const repo = (ctx.db ?? this.db).getRepository('onlineCountConfig');
    const existing = await repo.findOne({ filterByTk: CONFIG_KEY });
    const values = {
      visibleToAll: this.config.visibleToAll,
      singleSession: this.config.singleSession,
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
  async onWsSetTag({ clientId, tagKey, tagValue }: { clientId: string; tagKey: string; tagValue: string }) {
    if (tagKey !== 'userId') return;

    const userId = String(tagValue);
    this.app.logger.info(
      `[online-count] ws:setTag userId=${userId} clientId=${clientId} singleSession=${this.config.singleSession}`,
    );
    this.clientIdToUserId.set(clientId, userId);
    this.clientPingTimes.set(clientId, Date.now());

    // 抓取真实客户端 IP 并记入 clientIps（供会话日志 ip 字段与在线列表兜底使用）。
    // 之前 clientIps 从未被写入，导致 sessionLogs.ip 永远为空、在线列表也回落到 unknown。
    const ip = this.getClientIpFromGateway(clientId);
    if (ip) {
      const sess = this.userSessions.get(userId);
      if (sess) sess.clientIps.set(clientId, ip);
    }

    // 按 userId 串行化：防止两个连接几乎同时触发 setTag 时并发竞态导致互斥登录失效
    // （TOCTOU：两个 async 调用都读到同一个 existing session，各自操作后两连接都存活）
    const previous = this.userSetTagLocks.get(userId) ?? Promise.resolve();
    const current = previous
      .then(() => this.processSetTag(userId, clientId))
      .catch((err) => {
        this.app.logger.error(`[online-count] processSetTag failed for userId=${userId}:`, err);
      })
      .then(() => {
        if (this.userSetTagLocks.get(userId) === current) this.userSetTagLocks.delete(userId);
      });
    this.userSetTagLocks.set(userId, current);
    await current;

    // 同步未读系统广播给新连接的客户端（失败不影响 WS 握手）
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
  private async processSetTag(userId: string, clientId: string) {
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
          // 设备指纹尚未到达（客户端 open 时 device 消息可能晚于 auth:token 几毫秒），
          // 先确保会话存在、暂不踢人；待 online_device 消息到达后由 enforceSingleDevice 收敛判定。
          this.ensureSession(userId, clientId, user);
        } else {
          // 仅踢「设备指纹不同」的连接；同浏览器多标签页（deviceId 相同）保留。
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
        this.app.logger.error('[online-count] Fallback session creation also failed:', fallbackError);
      }
    }
  }

  /**
   * 从数据库查询用户信息（含角色），用户不存在时返回 null。
   */
  private async resolveUser(userId: string) {
    const userRepo = this.db.getRepository('users');
    return userRepo.findOne({ filterByTk: userId, appends: ['roles'] });
  }

  /**
   * 检查用户是否被拉黑。若被拉黑且非 root，发送 FORCE_LOGOUT 并在 100ms 后断开连接，
   * 同时清理 clientId 映射。返回 true 表示已拦截（调用方应 return）。
   */
  private handleBlacklistedUser(
    userId: string,
    clientId: string,
    user: { roles?: Array<{ name: string }>; blacklisted?: boolean },
  ): boolean {
    const isRoot = user?.roles?.some((r) => r.name === 'root');
    if (!isRoot && user?.blacklisted) {
      this.app.emit('ws:sendToClient', {
        clientId,
        message: { type: 'FORCE_LOGOUT', payload: { reason: 'blacklisted' } },
      });
      setTimeout(() => {
        this.app.emit('ws:disconnectClient', { clientId });
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
  private ensureSession(
    userId: string,
    clientId: string,
    user: { nickname?: string; roles?: Array<{ name: string }>; blacklisted?: boolean } | null,
  ) {
    const existing = this.userSessions.get(userId);
    if (existing) {
      existing.clientIds.add(clientId);
      return;
    }

    const roleName = user?.roles?.find((r) => r.name === 'root') ? 'root' : user?.roles?.[0]?.name || '';
    const userAgent = this.getClientUserAgentFromGateway(clientId);

    this.userSessions.set(userId, {
      userId,
      nickname: user?.nickname || `User ${userId}`,
      clientIds: new Set([clientId]),
      clientIps: new Map(),
      loginTime: Date.now(),
      status: 'ACTIVE',
      roleName,
      blacklisted: Boolean(user?.blacklisted),
      userAgent,
    });
  }

  /**
   * 客户端建连时上报设备指纹（online_device 消息）。
   * 记录 clientId -> deviceId，并在网关侧打 `deviceId#` 标签便于按设备聚合/排查；
   * 随后若单会话模式已开启，立即对所属用户重新执行单设备互斥判定（收敛消息乱序竞态）。
   */
  private onWsDeviceTag({ clientId, payload }: { clientId: string; payload?: { deviceId?: string } }) {
    let deviceId = payload?.deviceId;
    if (!deviceId) {
      deviceId = clientId;
    }
    this.clientDeviceId.set(clientId, deviceId);
    this.app.emit('ws:setTag', { clientId, tagKey: 'deviceId', tagValue: deviceId });

    const userId = this.clientIdToUserId.get(clientId);
    if (userId && this.config.singleSession) {
      const previous = this.userSetTagLocks.get(userId) ?? Promise.resolve();
      const current = previous
        .then(() => {
          this.enforceSingleDevice(userId);
          this.broadcastOnlineUsers();
        })
        .catch((err) => {
          this.app.logger.error(`[online-count] enforceSingleDevice failed for userId=${userId}:`, err);
        })
        .then(() => {
          if (this.userSetTagLocks.get(userId) === current) this.userSetTagLocks.delete(userId);
        });
      this.userSetTagLocks.set(userId, current);
    }
  }

  // 单设备互斥：同浏览器多标签页共享 deviceId 不互踢；仅 >=2 个不同 deviceId 时踢旧设备。
  // 收敛点：无论 online_device 早于或晚于 auth:setTag，最终都收敛到正确结果。判定逻辑见 device-logic.ts。
  private enforceSingleDevice(userId: string) {
    const existing = this.userSessions.get(userId);
    if (!existing || !this.config.singleSession) return;

    const { toKick } = computeEnforceSingleDevice({
      existingClientIds: Array.from(existing.clientIds),
      clientDeviceId: this.clientDeviceId,
      clientPingTimes: this.clientPingTimes,
    });
    if (toKick.length === 0) return;

    this.kickClientIds(userId, existing, toKick, 'logged_in_elsewhere');
    // 被踢设备的连接已移除，重新计算会话 loginTime 为剩余连接中最早的时间
    this.recomputeLoginTime(existing);
  }

  /**
   * 单会话模式下的踢人：仅踢出 deviceId 与 newDeviceId 不同的旧连接，
   * 保留同浏览器多标签页（同 deviceId）。新连接本身始终保留并计入会话。
   * 纯判定逻辑见 ./device-logic.ts（computeKickOnNewConnection），此处仅套用副作用。
   */
  private kickOtherDevices(
    userId: string,
    clientId: string,
    existing: UserSession,
    newDeviceId: string,
    user: { nickname?: string; roles?: Array<{ name: string }>; blacklisted?: boolean } | null,
  ) {
    // 确保新连接已计入会话（同设备其它标签已在则仅追加）
    this.ensureSession(userId, clientId, user);

    const { toKick } = computeKickOnNewConnection({
      newClientId: clientId,
      newDeviceId,
      existingClientIds: Array.from(existing.clientIds),
      clientDeviceId: this.clientDeviceId,
    });
    if (toKick.length > 0) {
      this.kickClientIds(userId, existing, toKick, 'logged_in_elsewhere');
      this.recomputeLoginTime(existing);
    }
  }

  /**
   * 统一踢出一批连接：发送 LOGGED_IN_ELSEWHERE 信令、延迟断开、清理映射，
   * 并记一条会话日志（被踢设备下线）。被踢连接之间视为同一设备事件，合并为一条日志。
   */
  private kickClientIds(userId: string, existing: UserSession, clientIdsToKick: string[], reason: string) {
    let firstIp = '';
    if (clientIdsToKick.length > 0) {
      firstIp = existing.clientIps.get(clientIdsToKick[0]) || '';
    }

    for (const cid of clientIdsToKick) {
      this.app.emit('ws:sendToClient', {
        clientId: cid,
        message: {
          type: 'LOGGED_IN_ELSEWHERE',
          payload: { reason: 'logged_in_elsewhere' },
        },
      });
      setTimeout(() => {
        this.app.emit('ws:disconnectClient', { clientId: cid });
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
        logoutTime: new Date(),
        duration: Math.floor((Date.now() - existing.loginTime) / 1000),
        logoutReason: reason,
        ip: firstIp,
        userAgent: existing.userAgent,
        status: existing.status,
      });
    }
  }

  /**
   * 重新计算会话 loginTime：取剩余连接中最早的 clientPingTimes。
   * 单设备互斥把旧设备踢光、只留新设备时，让 loginTime 反映留存设备的首次登录。
   */
  private recomputeLoginTime(session: UserSession) {
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
  onWsRemoveTag({ clientId, tagKey }: { clientId: string; tagKey: string }) {
    if (tagKey !== 'userId') return;
    this.removeClientSession(clientId);
  }

  /**
   * 客户端主动上报退出登录（正常登出 / 强制下线 / 异地登录）
   * 由 ws:message:LOGOUT_NOTIFY 触发，立即移除该 clientId 对应的会话
   */
  onLogoutNotify({ clientId }: { clientId: string }) {
    this.removeClientSession(clientId);
  }

  /**
   * 移除某个 clientId 对应的会话；当该用户所有连接都断开时删除会话并广播
   */
  private removeClientSession(clientId: string) {
    const userId = this.clientIdToUserId.get(clientId);
    this.clientIdToUserId.delete(clientId);
    this.clientPingTimes.delete(clientId);
    this.clientDeviceId.delete(clientId);

    if (!userId) return;

    const session = this.userSessions.get(userId);
    if (!session) return;

    const ip = session.clientIps.get(clientId) || Array.from(session.clientIps.values())[0] || '';
    session.clientIds.delete(clientId);
    session.clientIps.delete(clientId);

    if (session.clientIds.size === 0) {
      this.userSessions.delete(userId);
      this.broadcastOnlineUsers();

      this.pushToBufferQueue({
        userId,
        loginTime: new Date(session.loginTime),
        logoutTime: new Date(),
        duration: Math.floor((Date.now() - session.loginTime) / 1000),
        logoutReason: 'normal',
        ip,
        userAgent: session.userAgent,
        status: session.status,
      });
    }
  }

  /**
   * 移除某用户的所有会话（登出 / 被踢），清理其全部 clientId 映射并广播。
   * 供 auth:signOut 拦截器与 kickUser 共用，是"逻辑二·后端 API 截杀"的落点。
   * @returns 是否存在可移除的会话
   */
  private removeUserSessions(userId: string, logoutReason: string): boolean {
    const session = this.userSessions.get(userId);
    if (!session) return false;

    const firstIp = Array.from(session.clientIps.values())[0] || '';
    const { loginTime, status, userAgent } = session;

    // 清理该用户全部 clientId 的反向映射
    for (const clientId of session.clientIds) {
      this.clientIdToUserId.delete(clientId);
      this.clientPingTimes.delete(clientId);
      this.clientDeviceId.delete(clientId);
    }
    session.clientIds.clear();
    session.clientIps.clear();
    this.userSessions.delete(userId);

    // 记录会话日志
    this.pushToBufferQueue({
      userId,
      loginTime: new Date(loginTime),
      logoutTime: new Date(),
      duration: Math.floor((Date.now() - loginTime) / 1000),
      logoutReason,
      ip: firstIp,
      userAgent,
      status,
    });

    // 触发全网广播（经过节流器）
    this.broadcastOnlineUsers();
    return true;
  }

  /**
   * 心跳响应 Pong
   */
  onPong({ clientId }: { clientId: string }) {
    if (this.clientPingTimes.has(clientId)) {
      this.clientPingTimes.set(clientId, Date.now());
    }
  }

  /**
   * 用户进入离开状态（15 分钟无操作）
   */
  onStatusAway({ clientId }: { clientId: string }) {
    const userId = this.clientIdToUserId.get(clientId);
    if (!userId) return;
    const session = this.userSessions.get(userId);
    if (session) {
      session.status = 'AWAY';
      this.broadcastOnlineUsers();
    }
  }

  /**
   * 用户恢复活跃状态（仅当客户端真正从 AWAY 变回 ACTIVE 时上报，前端已做防抖）
   */
  onStatusActive({ clientId }: { clientId: string }) {
    const userId = this.clientIdToUserId.get(clientId);
    if (!userId) return;
    const session = this.userSessions.get(userId);
    if (session) {
      session.status = 'ACTIVE';
      this.clientPingTimes.set(clientId, Date.now());
      this.broadcastOnlineUsers();
    }
  }

  // ===== 心跳与清理 =====

  /**
   * 向所有客户端发送心跳 Ping
   */
  sendHeartbeat() {
    this.app.emit('ws:sendToCurrentApp', {
      message: { type: 'ping' },
    });
  }

  /**
   * 清理超过 90 秒未响应的过期连接（兜底：浏览器直接关闭标签页等场景）
   */
  cleanupStaleConnections() {
    const now = Date.now();
    const staleThreshold = 90000;
    /** 收集所有过期 clientId，迭代结束后批量删除，避免在迭代中修改 Map */
    const staleClientIds: string[] = [];

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
          const ip = session.clientIps.get(clientId) || Array.from(session.clientIps.values())[0] || '';
          session.clientIds.delete(clientId);
          session.clientIps.delete(clientId);
          if (session.clientIds.size === 0) {
            this.userSessions.delete(userId);
            this.pushToBufferQueue({
              userId,
              loginTime: new Date(session.loginTime),
              logoutTime: new Date(),
              duration: Math.floor((now - session.loginTime) / 1000),
              logoutReason: 'timeout',
              ip,
              userAgent: session.userAgent,
              status: session.status,
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
    const repo = this.db.getRepository('sessionLogs');

    try {
      await repo.createMany({ records: entries });
      this.bufferRetryCount = 0;
    } catch (error) {
      this.bufferRetryCount++;
      this.app.logger.error(
        `[online-count] Failed to flush session logs (retry ${this.bufferRetryCount}/${MAX_BUFFER_RETRIES})`,
        error,
      );
      if (this.bufferRetryCount >= MAX_BUFFER_RETRIES) {
        this.app.logger.error(
          `[online-count] Buffer flush retry limit exceeded, discarding ${entries.length} log entries`,
        );
        this.bufferRetryCount = 0;
      } else {
        // 失败时重新放回队列，下次重试
        this.bufferQueue.unshift(...entries);
      }
    }
  }

  /**
   * 向缓冲队列追加会话日志，超过容量上限时丢弃旧日志。
   */
  private pushToBufferQueue(entry: SessionLogEntry) {
    if (this.bufferQueue.length >= MAX_BUFFER_SIZE) {
      this.app.logger.warn('[online-count] Buffer queue full, discarding oldest log entry');
      this.bufferQueue.shift();
    }
    this.bufferQueue.push(entry);
  }

  // ===== 在线用户 API =====

  /** 获取在线用户列表，根据 visibleToAll 配置决定是否所有登录用户可见 */
  // 以网关切真实 WS 连接为权威源，按 userId 聚合真实连接数与 IP，根治 userSessions 漂移导致计数偏差
  // 从网关 WS 客户端提取 IP：x-forwarded-for/x-real-ip → ws socket.remoteAddress → upgradeReq.socket，归一化 IPv6
  private extractIpFromGatewayClient(client: WebSocketClientWithIp | undefined): string | undefined {
    if (!client) return undefined;
    const ipFromHeader = extractClientIp(client.headers);
    if (ipFromHeader) return normalizeIp(ipFromHeader);

    const ws = client.ws;
    const raw =
      ws?._socket?.remoteAddress ?? client?._socket?.remoteAddress ?? client?.upgradeReq?.socket?.remoteAddress;
    if (raw) return normalizeIp(raw);
    return undefined;
  }

  /** 按 clientId 从网关取真实客户端 IP（供 onWsSetTag 写入 clientIps） */
  private getClientIpFromGateway(clientId: string): string | undefined {
    const wsServer = Gateway.getInstance()?.wsServer;
    if (!wsServer) return undefined;
    const client = wsServer.webSocketClients.get(clientId) as WebSocketClientWithIp | undefined;
    if (!client) return undefined;
    return this.extractIpFromGatewayClient(client);
  }

  /** 按 clientId 从网关取客户端 User-Agent */
  private getClientUserAgentFromGateway(clientId: string): string {
    const wsServer = Gateway.getInstance()?.wsServer;
    if (!wsServer) return '';
    const client = wsServer.webSocketClients.get(clientId) as WebSocketClientWithIp | undefined;
    if (!client?.headers) return '';
    const ua = client.headers['user-agent'];
    if (!ua) return '';
    return Array.isArray(ua) ? ua[0] ?? '' : ua;
  }

  private getGatewayOnlineUsers(): Map<string, { clientIds: string[]; ips: string[] }> {
    const result = new Map<string, { clientIds: string[]; ips: string[] }>();
    const wsServer = Gateway.getInstance()?.wsServer;
    if (!wsServer) return result;

    const appTag = `app#${this.app.name}`;
    for (const [clientId, client] of wsServer.webSocketClients) {
      // 仅统计当前 app 的连接（与广播隔离维度一致：ws:sendToCurrentApp 也按 app 名投送）
      if (!client.tags.has(appTag)) continue;
      // 找出 userId 标签；未认证连接（无 userId# 标签）不算在线
      let userId: string | null = null;
      for (const tag of client.tags) {
        if (tag.startsWith('userId#')) {
          userId = tag.slice('userId#'.length);
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
      // 从网关 WebSocket 客户端对象提取真实客户端 IP（多源回退，避免 unknown）
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
  private buildOnlineUsers() {
    const now = Date.now();
    const gatewayUsers = this.getGatewayOnlineUsers();
    const users: Array<{
      userId: string;
      nickname: string;
      clientCount: number;
      loginTime: number;
      duration: number;
      status: 'ACTIVE' | 'AWAY';
      ip: string;
      roleName: string;
      blacklisted: boolean;
    }> = [];

    for (const [userId, gw] of gatewayUsers) {
      const sess = this.userSessions.get(userId);
      const loginTime = sess?.loginTime ?? now;
      users.push({
        userId,
        nickname: sess?.nickname ?? `User ${userId}`,
        clientCount: gw.clientIds.length,
        loginTime,
        duration: Math.floor((now - loginTime) / 1000),
        status: sess?.status ?? 'ACTIVE',
        ip: gw.ips[0] || 'unknown',
        roleName: sess?.roleName ?? '',
        blacklisted: sess?.blacklisted ?? false,
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
  private getClientIdsByUserId(userId: string): string[] {
    const ids = new Set<string>();
    const wsServer = Gateway.getInstance()?.wsServer;
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

  async listOnlineUsers(ctx: PluginContext, next: () => Promise<void>) {
    if (!this.config.visibleToAll) {
      if (!this.isAdminRequest(ctx)) {
        ctx.throw(403, 'Access denied');
      }
    }

    const users = this.buildOnlineUsers();
    const signature = users
      .map((u) => u.userId)
      .sort()
      .join(',');
    if (signature !== this.lastListSignature) {
      this.lastListSignature = signature;
      this.app.logger.info(`[online-count] online users changed -> count=${users.length} users=[${signature}]`);
    }
    ctx.body = {
      users,
      totalCount: users.length,
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
  async kickUser(ctx: PluginContext, next: () => Promise<void>) {
    const { userId } = ctx.action?.params?.values || ctx.request?.body || {};
    if (!userId) {
      ctx.throw(400, 'userId is required');
    }

    const targetUserId = String(userId);
    const targetUser = await (ctx.db ?? this.db)
      .getRepository('users')
      .findOne({ filterByTk: targetUserId, appends: ['roles'] });
    if (targetUser?.roles?.some((r: UserRole) => r.name === 'root')) {
      ctx.throw(403, 'Root user cannot be kicked out');
    }
    // 以网关切真实 WS 连接为权威源取该用户的全部 clientId（与 list/broadcast 同一原则），
    // 避免 userSessions 漂移导致"列表显示在线却踢不动"。
    const clientIds = this.getClientIdsByUserId(targetUserId);
    // roleName 仅用于跳过 root 的 token 黑名单，取自 userSessions（缺失则视为非 root）
    if (clientIds.length === 0) {
      ctx.body = { success: false, message: 'User is not online' };
      await next();
      return;
    }

    // 1. 仅销毁 WS 连接：发送 FORCE_LOGOUT 信令并在 100ms 后强制断开
    for (const clientId of clientIds) {
      this.app.emit('ws:sendToClient', {
        clientId,
        message: { type: 'FORCE_LOGOUT', payload: { reason: 'kicked' } },
      });
      setTimeout(() => {
        this.app.emit('ws:disconnectClient', { clientId });
      }, 0);
    }

    // 2. 销毁当前 Token 缓存（JWT 黑名单，TTL = token 剩余有效期）
    //    注：需管理端在踢人请求中携带目标用户的真实 JWT（X-Kick-Token 请求头）才会生效；
    //    当前管理端未携带时跳过，FORCE_LOGOUT + WS 断开 + 内存移除已是主要拦截手段。
    const userToken = ctx.get?.('X-Kick-Token');
    if (userToken) {
      try {
        const payload = JSON.parse(Buffer.from(userToken.split('.')[1], 'base64').toString());
        const expiresAt = payload.exp ? payload.exp * 1000 : 0;
        const remainingTTL = Math.floor((expiresAt - Date.now()) / 1000);
        if (remainingTTL > 0) {
          await this.tokenBlacklist.set(userToken, true, remainingTTL);
        }
      } catch {
        await this.tokenBlacklist.set(userToken, true, 5 * 60);
      }
    }

    // 3. 从内存移除该用户全部会话（含 clientId 映射清理、会话日志、节流广播）
    this.removeUserSessions(targetUserId, 'kicked');

    ctx.body = { success: true };
    await next();
  }

  /**
   * 解除用户黑名单
   * 同时清除该用户的黑名单缓存（Fix #4：避免解封后仍被缓存拦截 60s）
   */
  async unblacklistUser(ctx: PluginContext, next: () => Promise<void>) {
    const { userId } = ctx.action?.params?.values || ctx.request?.body || {};
    if (!userId) {
      ctx.throw(400, 'userId is required');
    }

    const userRepo = this.db.getRepository('users');
    await userRepo.update({
      filterByTk: String(userId),
      values: { blacklisted: false },
    });

    // 清除用户级黑名单缓存，使解封立即生效
    try {
      // ⚠️ Cache 的方法名是 del（不是 delete）
      await this.tokenBlacklist.del(`${USER_BLACKLIST_PREFIX}${userId}`);
    } catch {
      // 缓存删除失败不影响主流程
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
  async blacklistUser(ctx: PluginContext, next: () => Promise<void>) {
    const { userId } = ctx.action?.params?.values || ctx.request?.body || {};
    if (!userId) {
      ctx.throw(400, 'userId is required');
    }

    const targetUserId = String(userId);
    const targetUser = await (ctx.db ?? this.db)
      .getRepository('users')
      .findOne({ filterByTk: targetUserId, appends: ['roles'] });
    if (targetUser?.roles?.some((r: UserRole) => r.name === 'root')) {
      ctx.throw(403, 'Root user cannot be blacklisted');
    }

    // 1. 持久化黑名单标记
    await this.db.getRepository('users').update({
      filterByTk: targetUserId,
      values: { blacklisted: true },
    });

    // 2. 强制下线其全部在线连接
    const clientIds = this.getClientIdsByUserId(targetUserId);
    for (const clientId of clientIds) {
      this.app.emit('ws:sendToClient', {
        clientId,
        message: { type: 'FORCE_LOGOUT', payload: { reason: 'blacklisted' } },
      });
      setTimeout(() => {
        this.app.emit('ws:disconnectClient', { clientId });
      }, 0);
    }
    this.removeUserSessions(targetUserId, 'blacklisted');

    // 3. 写入 JWT 黑名单缓存（TTL 较长，确保禁用期间 Token 失效）
    try {
      await this.tokenBlacklist.set(`${USER_BLACKLIST_PREFIX}${targetUserId}`, true, 30 * 24 * 60 * 60);
    } catch {
      // 缓存写入失败不影响主流程（users.blacklisted 已落库，中间件会拦截登录）
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
  async listBlacklistedUsers(ctx: PluginContext, next: () => Promise<void>) {
    const repo = ctx.db?.getRepository?.('users') ?? this.db.getRepository('users');
    const users = (await repo.find({
      filter: { blacklisted: true },
      appends: ['roles'],
    })) as UserRecord[];

    const onlineIds = new Set(this.getGatewayOnlineUsers().keys());

    const data = (users || [])
      .filter((u) => !(u.roles ?? []).some((r: UserRole) => r.name === 'root'))
      .map((u: UserRecord) => ({
        userId: String(u.id),
        nickname: u.nickname || u.username || `User ${u.id}`,
        username: u.username,
        online: onlineIds.has(String(u.id)),
      }));

    // 注意：不要把数组嵌在 ctx.body.data 里 —— NocoBase wire 层会再包一层 data，
    // 前端 res.data.data 将拿到 {data:[...]} 对象而非数组（曾导致禁用列表恒空的 bug）。
    ctx.body = { users: data, count: data.length };
    await next();
  }

  // ===== 系统广播 =====

  /**
   * 管理员发送全站广播消息
   * 1. 保存广播到 systemBroadcasts 表，获取生成的 id
   * 2. 通过 WS 向所有在线客户端推送 SYSTEM_BROADCAST 消息（含 broadcastId）
   */
  async broadcastMessage(ctx: PluginContext, next: () => Promise<void>) {
    // NocoBase 的 resourceManager 自定义 action 中，POST body 可能位于多种路径：
    // 1. ctx.action.params.values（标准资源 action 路径，由 resourcer middleware 将 ctx.request.body 赋值到此）
    // 2. ctx.request.body（koa-bodyparser 中间件解析后的原始 body）
    // 3. ctx.request.body?.data（部分 API client 会包裹一层 data）
    const actionValues = (ctx.action?.params?.values as Record<string, unknown>) || undefined;
    const requestBody = (ctx.request?.body as Record<string, unknown>) || undefined;
    const bodyData = requestBody?.data as Record<string, unknown> | undefined;

    const hasContent = (obj: Record<string, unknown> | undefined): boolean => !!obj && Object.keys(obj).length > 0;

    let inputValues: Record<string, unknown> = {};
    if (hasContent(actionValues)) {
      inputValues = actionValues;
    } else if (hasContent(bodyData)) {
      inputValues = bodyData;
    } else if (hasContent(requestBody)) {
      inputValues = requestBody;
    } else {
      try {
        const rawBody = await new Promise<string>((resolve, reject) => {
          const req = ctx.req;
          if (!req || req.readableEnded || typeof req.on !== 'function') {
            resolve('');
            return;
          }
          const chunks: Buffer[] = [];
          req.on('data', (chunk: unknown) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
          req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
          req.on('error', (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
        });
        if (rawBody) {
          inputValues = JSON.parse(rawBody);
        }
      } catch {
        // 流已被消费或其他错误，忽略
      }
    }

    this.app.logger.debug('[online-count] broadcastMessage: inputValues parsed successfully');

    const { content, msgType = 'info', sender = 'system' } = inputValues;

    if (!content) {
      ctx.throw(400, 'content is required');
    }

    const repo = (ctx.db ?? this.db).getRepository('systemBroadcasts');
    const broadcast = await repo.create({
      values: {
        content: String(content),
        msgType: String(msgType),
        sender: String(sender),
        // 默认 7 天后过期，前端可覆盖
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    this.app.logger.info(
      `[online-count] broadcastMessage: id=${broadcast.id} msgType=${broadcast.msgType} sender=${broadcast.sender}`,
    );

    // 全站广播给所有在线客户端
    this.app.emit('ws:sendToCurrentApp', {
      message: {
        type: 'SYSTEM_BROADCAST',
        payload: {
          id: broadcast.id,
          content: broadcast.content,
          msgType: broadcast.msgType,
          sender: broadcast.sender,
          createdAt: broadcast.createdAt,
        },
      },
    });

    ctx.body = broadcast;
    await next();
  }

  /**
   * 用户标记广播已读（幂等：userId + broadcastId 唯一索引防止重复记录）
   */
  async markBroadcastRead(ctx: PluginContext, next: () => Promise<void>) {
    const inputValues = ctx.action?.params?.values || ctx.request?.body || {};
    const { broadcastId } = inputValues as Record<string, unknown>;
    const userId = ctx.auth?.user?.id;

    if (!broadcastId || !userId) {
      ctx.throw(400, 'broadcastId and userId are required');
    }

    const repo = (ctx.db ?? this.db).getRepository('userBroadcastReads');

    // 幂等：先查后插，避免唯一索引冲突
    const existing = await repo.findOne({
      filter: {
        userId: String(userId),
        broadcastId: Number(broadcastId),
      },
    });

    if (!existing) {
      await repo.create({
        values: {
          userId: String(userId),
          broadcastId: Number(broadcastId),
          readAt: new Date(),
        },
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
  private async getUnreadBroadcasts(userId: string) {
    const broadcastRepo = this.db.getRepository('systemBroadcasts');
    const readRepo = this.db.getRepository('userBroadcastReads');

    const now = new Date();
    // 查询所有未过期的广播（expiresAt 为 null 表示永不过期）
    const broadcasts = await broadcastRepo.find({
      filter: {
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      },
      sort: ['-createdAt'],
    });

    if (!broadcasts || !broadcasts.length) return [];

    // 查询该用户已读的广播 ID
    const reads = await readRepo.find({
      filter: { userId },
      fields: ['broadcastId'],
    });
    const readBroadcastIds = new Set(reads.map((r: ReadRecord) => r.broadcastId));

    return broadcasts
      .filter((b: BroadcastRecord) => !readBroadcastIds.has(b.id))
      .map((b: BroadcastRecord) => ({
        id: b.id,
        content: b.content,
        msgType: b.msgType,
        sender: b.sender,
        createdAt: b.createdAt,
      }));
  }

  /**
   * 同步未读系统广播给新连接的客户端（在 onWsSetTag 中调用）
   * 查询所有未过期且该用户未读的广播，通过 SYSTEM_BROADCAST_SYNC 消息发送给指定客户端
   * 此方法由 onWsSetTag 调用，失败时由调用方 catch 处理，不影响主流程
   */
  private async syncUnreadBroadcasts(userId: string, clientId: string) {
    const unreadBroadcasts = await this.getUnreadBroadcasts(userId);
    if (!unreadBroadcasts.length) return;

    this.app.emit('ws:sendToClient', {
      clientId,
      message: {
        type: 'SYSTEM_BROADCAST_SYNC',
        payload: { broadcasts: unreadBroadcasts },
      },
    });
  }

  /**
   * 当前登录用户主动拉取未读广播（online_users:list_broadcasts）。
   * 作为 WS 推送的兜底，确保登录后稳定收到已发送但未读的广播。
   */
  async listUnreadBroadcasts(ctx: PluginContext, next: () => Promise<void>) {
    const userId = ctx.auth?.user?.id;
    if (!userId) {
      ctx.throw(401, 'Unauthorized');
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
  async listBroadcasts(ctx: PluginContext, next: () => Promise<void>) {
    if (!this.isAdminRequest(ctx)) {
      ctx.throw(403, 'Access denied');
    }
    const broadcastRepo = this.db.getRepository('systemBroadcasts');
    const readRepo = this.db.getRepository('userBroadcastReads');
    const userRepo = this.db.getRepository('users');

    const broadcasts = await broadcastRepo.find({ sort: ['-createdAt'] });
    const totalUsers = await userRepo.count();

    // Batch query: fetch all reads in one shot instead of N+1 per-broadcast count
    const broadcastIds = broadcasts.map((b: BroadcastRecord) => b.id);
    const allReads =
      broadcastIds.length > 0
        ? await readRepo.find({ filter: { broadcastId: { $in: broadcastIds } }, fields: ['broadcastId'] })
        : [];
    const readCountMap = new Map<number, number>();
    for (const r of allReads as ReadRecord[]) {
      readCountMap.set(r.broadcastId, (readCountMap.get(r.broadcastId) ?? 0) + 1);
    }

    const result = broadcasts.map((b: BroadcastRecord) => ({
      id: b.id,
      content: b.content,
      msgType: b.msgType,
      sender: b.sender,
      createdAt: b.createdAt,
      expiresAt: b.expiresAt,
      readCount: readCountMap.get(b.id) ?? 0,
      totalUsers,
    }));

    ctx.body = { broadcasts: result };
    await next();
  }

  /**
   * 管理员查看某条广播的已读用户明细（online_users:broadcast_reads）。
   * 返回已读用户列表（userId / nickname / readAt）与已读人数、系统用户总数。
   */
  async broadcastReads(ctx: PluginContext, next: () => Promise<void>) {
    if (!this.isAdminRequest(ctx)) {
      ctx.throw(403, 'Access denied');
    }
    // GET 请求时参数在 ctx.query（ctx.action.params.values 是空对象 {}，为 truthy，
    // 不能用 `||` 短路判断——曾导致 broadcastId 永远读不到的 bug）
    const actionParams: ActionParams = ctx.action?.params ?? {};
    const broadcastId =
      actionParams?.values?.broadcastId ??
      actionParams?.broadcastId ??
      ctx.query?.broadcastId ??
      (ctx.request?.body as Record<string, unknown>)?.broadcastId;
    if (!broadcastId) {
      ctx.throw(400, 'broadcastId is required');
    }

    const readRepo = this.db.getRepository('userBroadcastReads');
    const reads = await readRepo.find({
      filter: { broadcastId: Number(broadcastId) },
      appends: ['user'],
      sort: ['-readAt'],
    });
    const readers = reads.map((r: ReadRecord) => ({
      userId: r.userId,
      nickname: r.user?.nickname ?? '',
      readAt: r.readAt,
    }));

    const userRepo = this.db.getRepository('users');
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
  async deleteBroadcasts(ctx: PluginContext, next: () => Promise<void>) {
    if (!this.isAdminRequest(ctx)) {
      ctx.throw(403, 'Access denied');
    }
    // 与 broadcastReads 同理：GET/POST 参数位置不同，逐级兜底取值
    const actionParams: ActionParams = ctx.action?.params ?? {};
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const rawIds = actionParams?.values?.ids ?? actionParams?.ids ?? body.ids ?? (Array.isArray(body) ? body : []);
    const singleId = actionParams?.values?.id ?? actionParams?.id ?? body.id;

    const ids: number[] = [];
    if (Array.isArray(rawIds)) {
      rawIds.forEach((v: unknown) => {
        const n = Number(v);
        if (Number.isInteger(n) && n > 0) ids.push(n);
      });
    } else if (singleId !== undefined && singleId !== null) {
      const n = Number(singleId);
      if (Number.isInteger(n) && n > 0) ids.push(n);
    }

    if (!ids.length) {
      ctx.throw(400, 'ids is required');
    }

    // 去重
    const uniqueIds = Array.from(new Set(ids));
    this.app.logger.info(`[online-count] deleteBroadcasts: ids=${JSON.stringify(uniqueIds)}`);

    const readRepo = this.db.getRepository('userBroadcastReads');
    const broadcastRepo = this.db.getRepository('systemBroadcasts');

    // 先删已读记录（无外键约束，但保持数据一致）
    await readRepo.destroy({ filter: { broadcastId: { $in: uniqueIds } } });
    const deleted = await broadcastRepo.destroy({ filter: { id: { $in: uniqueIds } } });

    ctx.body = { deleted: typeof deleted === 'number' ? deleted : uniqueIds.length };
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
  private doBroadcastOnlineUsers() {
    // 权威在线名单以网关真实 WS 连接为准，富化字段来自 userSessions
    const users = this.buildOnlineUsers();
    const totalCount = users.length;

    // Diff 快照 Key：剔除动态字段，仅比较会实质改变的量
    const snapshotKey = JSON.stringify({
      totalCount,
      users: users.map((u) => ({
        userId: u.userId,
        status: u.status,
        clientCount: u.clientCount,
      })),
    });

    // Diff 拦截：快照未变则不 emit
    if (snapshotKey === this.lastBroadcastSnapshot) {
      this.app.logger.debug('[online-count] broadcastOnlineUsers: snapshot unchanged, skip emit');
      return;
    }
    this.lastBroadcastSnapshot = snapshotKey;

    this.app.logger.debug(`[online-count] broadcastOnlineUsers: totalCount=${totalCount} users=${users.length}`);

    this.app.emit('ws:sendToCurrentApp', {
      message: {
        type: 'online_users',
        payload: {
          users: users.slice(0, 20),
          totalCount,
        },
      },
    });
  }
}

export default PluginOnlineCountServer;
