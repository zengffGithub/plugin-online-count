/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { notification } from 'antd';

// WebSocket 连接地址固定使用 '/ws'；网关已剥离 APP_PUBLIC_PATH，不需自行拼接子路径

interface EventBusLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  dispatchEvent(event: Event): boolean;
}

interface WsLike {
  on(type: string, listener: () => void): void;
  off?(type: string, listener: () => void): void;
  connected?: boolean;
  send(data: string): void;
  close?(): void;
  reconnect?(): void;
}

interface AuthLike {
  role?: string;
  signOut(): Promise<unknown>;
  setToken(token: string): void;
  setRole(role: string): void;
  setAuthenticator(authenticator: string): void;
}

export interface OnlineCountRuntimeOptions {
  app: {
    eventBus?: EventBusLike;
    ws?: WsLike;
    apiClient: { auth: AuthLike };
  };
  /** i18n translator（传入 plugin.t 包装后的纯 string 版本） */
  t: (key: string) => string;
}

/**
 * 建立在线人数插件的共享 WebSocket 运行时（client-v1 / client-v2 双端复用）：
 *
 * 1. 设备指纹：连接建立时上报 deviceId，服务端区分「同浏览器多标签」与「异设备」；
 * 2. 心跳：回复服务端 ping，否则 90 秒后连接会被服务端判离线清理；
 * 3. 强制下线 / 异地登录 / 服务重启的通知与跳转；
 * 4. 系统广播转发到 eventBus，供 HeaderOnlineIcon 等组件消费；
 * 5. 登出检测（auth:tokenChanged）：登出时立即通知服务端移除会话并销毁 WS；
 *    重新登录时主动救活长连接（新登录不整页刷新时核心不会自动建连）。
 *
 * @returns dispose 函数：移除本运行时注册的全部监听，插件 afterDisable 时调用。
 */
export function setupOnlineCountRuntime({ app, t }: OnlineCountRuntimeOptions): () => void {
  let deviceId: string | null = null;
  const STORAGE_KEY = 'nocobase:online-count:deviceId';

  /**
   * 获取稳定的设备指纹：优先读取 localStorage（同浏览器所有标签页共享），
   * 不存在则生成 UUID 并持久化。不同浏览器/隐私窗口有各自独立的存储，天然视为不同设备。
   */
  const getDeviceId = (): string => {
    if (deviceId) return deviceId;
    try {
      const existing = window.localStorage.getItem(STORAGE_KEY);
      if (existing) {
        deviceId = existing;
        return existing;
      }
      const generated =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      window.localStorage.setItem(STORAGE_KEY, generated);
      deviceId = generated;
      return generated;
    } catch {
      // localStorage 不可用（隐私模式禁用等）时降级为内存随机值：本标签页内稳定，
      // 但跨标签不共享——此时多开窗口会被误判为不同设备（保守但不致误踢同标签）。
      if (!deviceId) {
        deviceId = `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      }
      return deviceId;
    }
  };

  /**
   * 通过 WebSocket 把本浏览器 deviceId 上报给后端。
   * 后端据此把「同一浏览器的多个标签页」归并为同一设备，单会话模式下不会互相踢下线。
   */
  const sendDeviceId = () => {
    try {
      if (app.ws?.connected) {
        app.ws.send(JSON.stringify({ type: 'online_device', payload: { deviceId: getDeviceId() } }));
      }
    } catch {
      // WS 不可用时忽略，open / reconnect 会再次触发补发
    }
  };

  /**
   * 强制下线 / 异地登录后的跳转目标。
   * 部署在 /v 子路径下（pathname 为 /v 或以 /v/ 开头）时跳转到 /v/signin，
   * 其余场景跳转到 /signin。
   */
  const getSigninUrl = (): string => {
    const { pathname } = window.location;
    if (pathname === '/v' || pathname.startsWith('/v/')) {
      return '/v/signin';
    }
    return '/signin';
  };

  /**
   * 通过 WebSocket 主动上报退出登录，让服务器立即移除当前 clientId 的会话
   */
  const notifyLogout = () => {
    try {
      if (app.ws?.connected) {
        app.ws.send(JSON.stringify({ type: 'LOGOUT_NOTIFY' }));
      }
    } catch {
      // WS 已不可用时忽略，stale 清理会作为兜底
    }
  };

  // ===== WebSocket 消息处理器 =====

  const handlePing = () => {
    app.ws?.send(JSON.stringify({ type: 'pong' }));
  };

  const handleForceLogout = async (event: Event) => {
    const payload = (event as CustomEvent).detail;
    const reason = payload?.reason || 'unknown';

    // 在清空 token 前通知服务器移除本会话（此时 WS 仍在线，可立即减员）
    notifyLogout();

    try {
      await app.apiClient.auth.signOut();
    } catch {
      app.apiClient.auth.setToken('');
      app.apiClient.auth.setRole('');
      app.apiClient.auth.setAuthenticator('');
    }

    notification.error({
      message: t('You have been kicked out'),
      description:
        reason === 'blacklisted'
          ? t('Your account has been blacklisted by the administrator.')
          : t('You have been forcibly logged out by the administrator.'),
      duration: 5,
      onClose: () => {
        window.location.href = getSigninUrl();
      },
    });

    setTimeout(() => {
      window.location.href = getSigninUrl();
    }, 5000);
  };

  const handleLoggedInElsewhere = () => {
    // 在清空 token 前通知服务器移除本会话（此时 WS 仍在线，可立即减员）
    notifyLogout();

    app.apiClient.auth.setToken('');
    app.apiClient.auth.setRole('');
    app.apiClient.auth.setAuthenticator('');

    notification.warning({
      message: t('Logged in elsewhere'),
      description: t('Logged in elsewhere'),
      duration: 5,
      onClose: () => {
        window.location.href = getSigninUrl();
      },
    });

    setTimeout(() => {
      window.location.href = getSigninUrl();
    }, 5000);
  };

  const handleServerRestart = () => {
    notification.warning({
      message: t('Server is restarting'),
      description: t('The server is restarting, some features may be temporarily unavailable.'),
      duration: 5,
    });
  };

  /**
   * 转发系统广播消息到 eventBus，供 HeaderOnlineIcon 组件消费
   */
  const handleSystemBroadcastForward = (event: Event) => {
    app.eventBus?.dispatchEvent(
      new CustomEvent('plugin:online_count:system_broadcast', { detail: (event as CustomEvent).detail }),
    );
  };

  /**
   * 转发系统广播同步消息到 eventBus，供 HeaderOnlineIcon 组件消费
   */
  const handleSystemBroadcastSyncForward = (event: Event) => {
    app.eventBus?.dispatchEvent(
      new CustomEvent('plugin:online_count:system_broadcast_sync', { detail: (event as CustomEvent).detail }),
    );
  };

  /**
   * 登出检测：观测当前登录用户 token，一旦从「已登录」变为「未登录」
   * （正常退出 / 强制下线 / 异地登录），立即通过仍在线的 WebSocket 通知
   * 服务器移除本会话，避免在线人数长时间不准确。
   *
   * 说明：NocoBase 核心在 WebSocket 断连时不会 emit ws:removeTag，且登出时
   * 连接常保持并重连心跳，仅靠 90s 的 stale 清理不可靠；主动上报是最及时的方案。
   * 注意：本监听器先于 HeaderOnlineIcon 中 app.ws.close() 注册执行，
   * 保证 LOGOUT_NOTIFY 报文在长连接销毁前发出。
   */
  const handleTokenChanged = (event: Event) => {
    // NocoBase Auth.setToken() 会通过 app.eventBus 派发 'auth:tokenChanged' 事件
    // （见 core/sdk/src/Auth.ts:128），detail = { token, authenticator }
    // 当 token 变为 falsy（null/空字符串）即为登出。
    const detail = (event as CustomEvent).detail;
    if (!detail?.token) {
      // token 被清空 → 用户登出：先通知服务器移除会话，再销毁 WS 长连接防止幽灵重连
      notifyLogout();
      try {
        app.ws?.close();
      } catch {
        // WS 已不可用则忽略
      }
    } else {
      // token 重新有值（登录 / 换 token）：
      // 必须主动救活长连接 —— 这是「新登录不更新在线数」的真正根因。
      //
      // 未登录时（如 /v/signin 页）WebSocketClient 不建立连接（无 token）；
      // SPA 登录是客户端路由跳转、不整页刷新，NocoBase 核心不会自动为「从无到有的 token」
      // 拉起 WS。若只依赖 HeaderOnlineIcon 里的 reconnect（它要等顶栏出现后才挂载），
      // 登录那一刻的 auth:tokenChanged 事件早已错过，reconnect() 永远不被调用 →
      // 服务端收不到 auth:token → 不 ws:setTag → 不广播 → 新登录用户在线数恒为 0/旧值，
      // 必须手动整页刷新（WS 在 bootstrap 阶段带 token 建连）才正确。
      //
      // 本监听器注册于插件 load()（永远早于顶栏挂载），因此一定能捕获登录事件并建连；
      // 建连后核心会重发 auth:token → 服务端 setTag → 节流广播 → 各端 handleOnlineUsers 纠正计数。
      // 若连接本就存活，reconnect() 内部有 readyState === OPEN 检查，是安全的 no-op。
      try {
        app.ws?.reconnect?.();
      } catch {
        // WS 不可用则忽略，focus / 连接事件自愈会兜底
      }
    }
  };

  // ===== 注册监听 =====
  if (app.eventBus) {
    app.eventBus.addEventListener('ws:message:ping', handlePing);
    app.eventBus.addEventListener('ws:message:FORCE_LOGOUT', handleForceLogout);
    app.eventBus.addEventListener('ws:message:LOGGED_IN_ELSEWHERE', handleLoggedInElsewhere);
    app.eventBus.addEventListener('ws:message:SERVER_RESTART', handleServerRestart);
    app.eventBus.addEventListener('ws:message:SYSTEM_BROADCAST', handleSystemBroadcastForward);
    app.eventBus.addEventListener('ws:message:SYSTEM_BROADCAST_SYNC', handleSystemBroadcastSyncForward);
    app.eventBus.addEventListener('auth:tokenChanged', handleTokenChanged);
  }

  // 设备指纹：连接建立时把 deviceId 发给后端。
  // 注册于插件 load()（早于顶栏挂载），与核心 auth:token 一样在 WS open 时发送；
  // 重连（reconnect）后同样会触发 open，故单设备互斥判定在每次建连后都有效。
  if (app.ws) {
    app.ws.on('open', sendDeviceId);
    // 若此时连接已就绪（热加载/HMR 场景），立即补发一次
    if (app.ws.connected) {
      sendDeviceId();
    }
  }

  // ===== 返回 dispose：移除全部监听 =====
  return () => {
    if (app.eventBus) {
      app.eventBus.removeEventListener('ws:message:ping', handlePing);
      app.eventBus.removeEventListener('ws:message:FORCE_LOGOUT', handleForceLogout);
      app.eventBus.removeEventListener('ws:message:LOGGED_IN_ELSEWHERE', handleLoggedInElsewhere);
      app.eventBus.removeEventListener('ws:message:SERVER_RESTART', handleServerRestart);
      app.eventBus.removeEventListener('ws:message:SYSTEM_BROADCAST', handleSystemBroadcastForward);
      app.eventBus.removeEventListener('ws:message:SYSTEM_BROADCAST_SYNC', handleSystemBroadcastSyncForward);
      app.eventBus.removeEventListener('auth:tokenChanged', handleTokenChanged);
    }
    try {
      app.ws?.off?.('open', sendDeviceId);
    } catch {
      // WS 不可用时忽略
    }
  };
}
