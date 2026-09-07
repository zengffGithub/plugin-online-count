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
var auth_middleware_exports = {};
__export(auth_middleware_exports, {
  USER_BLACKLIST_PREFIX: () => USER_BLACKLIST_PREFIX,
  createTokenBlacklistMiddleware: () => createTokenBlacklistMiddleware,
  default: () => auth_middleware_default
});
module.exports = __toCommonJS(auth_middleware_exports);
const USER_BLACKLIST_PREFIX = "online-count-user-blacklist:";
function createTokenBlacklistMiddleware(tokenBlacklist, db, logger) {
  const USER_BLACKLIST_TTL = 30;
  return async (ctx, next) => {
    var _a, _b, _c;
    if (ctx.state.currentRole === "root") {
      return next();
    }
    const token = (_a = ctx.get("Authorization")) == null ? void 0 : _a.replace("Bearer ", "");
    if (token) {
      const blacklisted = await tokenBlacklist.get(token);
      if (blacklisted) {
        const { path } = ctx;
        if (path.startsWith("/api/auth:") || path === "/api/auth:check") {
          return next();
        }
        ctx.throw(403, "Your session has been terminated by the administrator");
      }
    }
    const userId = (_c = (_b = ctx.auth) == null ? void 0 : _b.user) == null ? void 0 : _c.id;
    if (userId) {
      let isBlacklisted = false;
      try {
        const cacheKey = `${USER_BLACKLIST_PREFIX}${userId}`;
        const cachedBlacklisted = await tokenBlacklist.get(cacheKey);
        if (cachedBlacklisted === true) {
          isBlacklisted = true;
        } else if (cachedBlacklisted === false) {
          isBlacklisted = false;
        } else {
          const userRepo = db.getRepository("users");
          const user = await userRepo.findOne({
            filterByTk: userId,
            fields: ["blacklisted"]
          });
          isBlacklisted = !!(user == null ? void 0 : user.blacklisted);
          await tokenBlacklist.set(cacheKey, isBlacklisted, USER_BLACKLIST_TTL);
        }
      } catch (readError) {
        (logger || console).error("[online-count] Failed to read user blacklist (degraded to allow):", readError);
        isBlacklisted = false;
      }
      if (isBlacklisted) {
        const { path } = ctx;
        if (path.startsWith("/api/auth:") || path === "/api/auth:check") {
          return next();
        }
        ctx.throw(403, "Your account has been blacklisted");
      }
    }
    await next();
  };
}
var auth_middleware_default = createTokenBlacklistMiddleware;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  USER_BLACKLIST_PREFIX,
  createTokenBlacklistMiddleware
});
