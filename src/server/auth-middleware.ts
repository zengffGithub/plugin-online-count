import { Cache } from '@nocobase/cache';
import { Database } from '@nocobase/database';

/** 用户级黑名单缓存 key 前缀，供 auth-middleware 和 plugin.ts 共用 */
export const USER_BLACKLIST_PREFIX = 'online-count-user-blacklist:';

/** JWT 黑名单拦截中间件：Cache 级拦截被踢 token + DB 级黑名单检查（带 30s 缓存），放行认证接口 */
interface BlacklistContext {
  state: { currentRole?: string };
  auth?: { user?: { id?: string | number } };
  path: string;
  get: (key: string) => string;
  throw: (code: number, message: string) => void;
}

export function createTokenBlacklistMiddleware(
  tokenBlacklist: Cache,
  db: Database,
  logger?: { error: (...args: unknown[]) => void },
) {
  // cache-manager memory store TTL 单位是秒不是毫秒；之前误写 60*1000 导致 false 缓存存活 16.7h 使黑名单失效
  const USER_BLACKLIST_TTL = 30; // 秒

  return async (ctx: BlacklistContext, next: () => Promise<void>) => {
    // ===== 0. root 用户彻底不受任何黑名单限制 =====
    if (ctx.state.currentRole === 'root') {
      return next();
    }

    // ===== 1. 检查 JWT Token 是否在 Cache 黑名单中 =====
    const token = ctx.get('Authorization')?.replace('Bearer ', '');
    if (token) {
      const blacklisted = await tokenBlacklist.get(token);
      if (blacklisted) {
        // 不拦截认证相关接口（允许重新登录）
        const { path } = ctx;
        if (path.startsWith('/api/auth:') || path === '/api/auth:check') {
          return next();
        }
        ctx.throw(403, 'Your session has been terminated by the administrator');
      }
    }

    // ===== 2. 检查数据库级黑名单（持久化黑名单）—— 带缓存优化 =====
    const userId = ctx.auth?.user?.id;
    if (userId) {
      let isBlacklisted = false;

      // ctx.throw 必须在 try 之外，否则被 catch 吞掉导致黑名单失效且刷屏
      try {
        const cacheKey = `${USER_BLACKLIST_PREFIX}${userId}`;
        const cachedBlacklisted = await tokenBlacklist.get(cacheKey);

        if (cachedBlacklisted === true) {
          isBlacklisted = true; // 缓存命中：用户已被拉黑
        } else if (cachedBlacklisted === false) {
          isBlacklisted = false; // 缓存命中：用户正常，直接放行（不查DB）
        } else {
          // 缓存未命中：查 DB 并写入缓存
          const userRepo = db.getRepository('users');
          const user = await userRepo.findOne({
            filterByTk: userId,
            fields: ['blacklisted'],
          });
          isBlacklisted = !!user?.blacklisted;
          // 写入缓存（TTL 单位：秒，见 USER_BLACKLIST_TTL 注释）
          await tokenBlacklist.set(cacheKey, isBlacklisted, USER_BLACKLIST_TTL);
        }
      } catch (readError) {
        // DB/缓存读取失败时降级放行，避免 DB 故障导致全员不可用
        (logger || console).error('[online-count] Failed to read user blacklist (degraded to allow):', readError);
        isBlacklisted = false;
      }

      // ===== 黑名单拦截：在 try/catch 【之外】，确保真正生效 =====
      if (isBlacklisted) {
        const { path } = ctx;
        // 认证相关接口放行，允许被踢用户重新登录
        if (path.startsWith('/api/auth:') || path === '/api/auth:check') {
          return next();
        }
        ctx.throw(403, 'Your account has been blacklisted');
      }
    }

    await next();
  };
}

export default createTokenBlacklistMiddleware;
