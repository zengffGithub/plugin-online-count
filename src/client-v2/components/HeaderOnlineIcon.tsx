import { TeamOutlined, LoadingOutlined } from '@ant-design/icons';
import { css } from '@emotion/css';
import { useApp } from '@nocobase/client-v2';
import { Drawer, Tooltip, Typography, Spin, Button, Badge, Modal, message, notification, Input, Radio } from 'antd';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../locale';
import type { OnlineUser, OnlineUsersPayload, SystemBroadcast } from '../types';
import { formatDuration, formatTime, statusColor, statusLabel, unwrapPayload } from '../utils';

const { Text } = Typography;

/**
 * 与站内消息铃铛（plugin-notification-in-app-message 的 InboxTopbarActionModel）
 * 完全一致的视觉：
 * 1. 外层用 antd Button type="text"（与铃铛相同），悬停背景块由 NocoBase 主题
 *    统一提供，与铃铛等其它顶栏图标表现一致。
 * 2. 计数用 antd <Badge count size="small">，并复用铃铛的同款缩小规则
 *    （sup: 10/10/8px、icon 继承 initial 字号、badge 颜色 rgba(255,255,255,0.65)），
 *    呈现为角标处的小红点，而非盖在图标上的实心"遮罩层"。
 */
const onlineBadgeClassName = css`
  .ant-badge {
    color: rgba(255, 255, 255, 0.65);
    .anticon {
      display: inline-block;
      vertical-align: middle;
      line-height: 1em;
      font-size: initial;
    }
    > sup {
      height: 10px;
      line-height: 10px;
      font-size: 8px;
    }
  }
`;

/**
 * Header 在线人数图标挂件
 *
 * 功能：
 * 1. 实时显示在线人数（Badge 数字）
 * 2. Hover Tooltip 显示"当前 X 人在线，点击查看/管理"
 * 3. 弱网反馈：WebSocket 断开/重连时图标变为黄色 Loading 状态
 * 4. 点击弹出 Drawer 抽屉，展示在线用户列表
 */
export const HeaderOnlineIcon: React.FC = () => {
  const t = useT();
  const app = useApp();
  const [count, setCount] = useState(0);
  const [users, setUsers] = useState<OnlineUser[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** 当前用户是否为管理员 */
  const [isAdmin, setIsAdmin] = useState(false);
  /** 插件配置：是否对所有登录用户可见在线列表 */
  const [visibleToAll, setVisibleToAll] = useState<boolean | null>(null);
  /** 正在踢出中的用户 ID */
  const [kickingUserId, setKickingUserId] = useState<string | null>(null);

  /** 广播编辑 Modal */
  const [broadcastModalOpen, setBroadcastModalOpen] = useState(false);
  const [broadcastContent, setBroadcastContent] = useState('');
  const [broadcastMsgType, setBroadcastMsgType] = useState<'info' | 'warning' | 'error'>('info');
  const [broadcastSending, setBroadcastSending] = useState(false);

  /** 系统广播通知 key 队列，限制最多 3 个同时显示 */
  const broadcastKeysRef = useRef<string[]>([]);

  /**
   * 展示系统广播通知，限制最多 3 个同时显示，关闭时自动上报已读
   */
  const showNotification = useCallback(
    (broadcast: SystemBroadcast) => {
      // 限制最多 3 个通知同时显示：超过时移除最早的通知
      while (broadcastKeysRef.current.length >= 3) {
        const oldest = broadcastKeysRef.current.shift();
        if (oldest) notification.destroy(oldest);
      }

      const key = `broadcast-${broadcast.id}`;
      broadcastKeysRef.current.push(key);

      const notifFn =
        broadcast.msgType === 'error'
          ? notification.error
          : broadcast.msgType === 'warning'
            ? notification.warning
            : notification.info;

      notifFn({
        key,
        message: t('System Broadcast'),
        description: broadcast.content,
        duration: 10,
        onClose: () => {
          // 从队列中移除
          broadcastKeysRef.current = broadcastKeysRef.current.filter((k) => k !== key);
          // 静默标记已读（异步，失败忽略）
          app.apiClient
            .request({ url: 'online_users:read_broadcast', method: 'POST', data: { broadcastId: broadcast.id } })
            .catch(() => {});
        },
      });
    },
    [app, t],
  );

  /**
   * 拉取当前在线用户（权威基线）：组件挂载、WS 重连、窗口聚焦时都会调用。
   *
   * 为什么必须有这一步？
   * 前端此前只监听 WS 广播来更新 count，没有任何初始拉取。新登录用户自己的页面刚
   * 挂载时 count 初始为 0，完全依赖"自己登录那一刻"那条广播恰好被收到；若 WS 消息
   * 管线在该广播之前尚未就绪、或同 2000ms 节流窗口内被合并掉了 leading 那次 emit，
   * 这条广播就永远错过，之后只要无人再登录/登出就不会有第二条广播来纠正，count 永久
   * 停在 0/旧值 —— 表现为"新用户登录用户数未更新"。
   * 用 HTTP API 取一次真实快照作为基线，广播只负责后续实时增量，彻底消除竞态。
   */
  const fetchOnlineUsers = useCallback(async () => {
    try {
      const res = await app.apiClient.request({
        url: 'online_users:list',
        method: 'get',
      });
      const payload = (res?.data?.data ?? res?.data ?? {}) as Partial<OnlineUsersPayload> | OnlineUser[];
      const list = Array.isArray(payload) ? payload : payload.users;
      if (Array.isArray(list)) {
        setUsers(list);
        setCount(Array.isArray(payload) ? list.length : payload.totalCount ?? list.length);
      }
    } catch {
      // 拉取失败不影响主流程，下一次广播或聚焦会再纠正
    }
  }, [app]);

  /**
   * 主动拉取当前用户未读广播（online_users:list_broadcasts）。
   * 作为 WS 推送（SYSTEM_BROADCAST_SYNC）的兜底：登录后即便推送早于前端监听器就绪，
   * 这里也能稳定补收到历史未读广播，彻底解决「登录后收不到已发送广播」的竞态。
   */
  const fetchUnreadBroadcasts = useCallback(async () => {
    try {
      const res = await app.apiClient.request({ url: 'online_users:list_broadcasts', method: 'get' });
      const payload = unwrapPayload<{ broadcasts?: SystemBroadcast[] } | SystemBroadcast[]>(res);
      const broadcasts = (Array.isArray(payload) ? payload : payload?.broadcasts ?? []) as SystemBroadcast[];
      if (Array.isArray(broadcasts) && broadcasts.length) {
        broadcasts.forEach((b) => showNotification(b));
      }
    } catch {
      // 拉取失败忽略，下次鉴权/聚焦会重试
    }
  }, [app, showNotification]);

  /**
   * 加载配置，检查用户角色，并拉取一次在线用户基线。
   * 先获取 visibleToAll 配置，若为 false 且当前用户非管理员则隐藏图标（不调用 online_users:list）。
   */
  useEffect(() => {
    const role = app.apiClient.auth?.role;
    const admin = role === 'admin' || role === 'root';
    setIsAdmin(admin);

    // 先获取配置，再决定是否拉取在线用户列表
    const init = async () => {
      try {
        // 优先使用插件实例缓存的配置（避免重复请求），回退到直接 API 调用
        const plugin = app.pm?.get('@nocobase/plugin-online-count') as
          | { getConfig?: () => Promise<{ visibleToAll: boolean; singleSession: boolean }> }
          | undefined;
        const config = plugin?.getConfig
          ? await plugin.getConfig()
          : await app.apiClient.request({ url: 'online_count_config:get', method: 'get' }).then((res) => {
              const d = res?.data?.data ?? res?.data ?? {};
              return { visibleToAll: d.visibleToAll !== false, singleSession: d.singleSession === true };
            });
        const visible = config.visibleToAll !== false; // 默认 true
        setVisibleToAll(visible);

        if (visible || admin) {
          fetchOnlineUsers();
        }
      } catch {
        // 配置获取失败时降级：允许拉取（避免因配置 API 不可用导致图标消失）
        setVisibleToAll(true);
        fetchOnlineUsers();
      }
    };
    init();
  }, [app, fetchOnlineUsers]);

  /**
   * 监听 WebSocket 在线用户广播（实时增量，不替代上面的初始拉取）
   */
  useEffect(() => {
    const handleOnlineUsers = (event: Event) => {
      const payload = (event as CustomEvent).detail as OnlineUsersPayload;
      if (payload) {
        setCount(payload.totalCount || 0);
        setUsers(payload.users || []);
      }
    };

    app.eventBus?.addEventListener('ws:message:online_users', handleOnlineUsers);
    // 收到任何 WS 消息说明连接正常，同步状态
    const markConnected = () => setIsConnecting(false);
    app.eventBus?.addEventListener('ws:message:ping', markConnected);

    return () => {
      app.eventBus?.removeEventListener('ws:message:online_users', handleOnlineUsers);
      app.eventBus?.removeEventListener('ws:message:ping', markConnected);
    };
  }, [app]);

  /**
   * 监听系统广播事件（来自 plugin.tsx 的转发）
   * - plugin:online_count:system_broadcast：单条实时广播
   * - plugin:online_count:system_broadcast_sync：批量历史未读广播
   */
  useEffect(() => {
    const handleBroadcast = (event: Event) => {
      const payload = (event as CustomEvent).detail as SystemBroadcast;
      if (!payload?.id) return;
      showNotification(payload);
    };
    const handleSync = (event: Event) => {
      const { broadcasts } = (event as CustomEvent).detail as { broadcasts: SystemBroadcast[] };
      if (!Array.isArray(broadcasts) || !broadcasts.length) return;
      broadcasts.forEach((b) => showNotification(b));
    };

    app.eventBus?.addEventListener('plugin:online_count:system_broadcast', handleBroadcast);
    app.eventBus?.addEventListener('plugin:online_count:system_broadcast_sync', handleSync);

    return () => {
      app.eventBus?.removeEventListener('plugin:online_count:system_broadcast', handleBroadcast);
      app.eventBus?.removeEventListener('plugin:online_count:system_broadcast_sync', handleSync);
    };
  }, [app, showNotification]);

  useEffect(() => {
    const heal = () => {
      const token = app.apiClient.auth?.token;
      if (!token) return;
      if (app.ws && !app.ws.connected) {
        try {
          app.ws.reconnect?.();
        } catch {
          // 恢复失败则忽略，等待下次 focus 再试
        }
      }
      // 同步 WS 连接状态到 UI（connected 是非响应式属性，需手动同步）
      setIsConnecting(!app.ws?.connected);
      // 无论 WS 是否存活，聚焦时都校正一次计数（防止长时间后台导致显示滞后/错过广播）
      // 仅当 visibleToAll 为 true 或用户为管理员时才拉取
      if (visibleToAll === true || isAdmin) {
        fetchOnlineUsers();
      }
    };
    // 挂载时检查一次（覆盖服务重启后页面未刷新、重连已耗尽的场景）
    heal();
    window.addEventListener('focus', heal);
    return () => window.removeEventListener('focus', heal);
  }, [app, fetchOnlineUsers, isAdmin, visibleToAll]);

  /**
   * WS（重）连接成功且完成鉴权后拉取权威快照 —— 这是"新登录不更新在线数"的真正兜底。
   *
   * 根因：服务端在 ws:setTag（给本连接打 userId 标签）后会立即广播 online_users，
   * 但新客户端若在该广播到达前尚未挂好监听器（localhost 下 WS 握手极快，竞态明显），
   * 就会错过这条广播；之后只要无人再登录/登出就不会有第二条广播来纠正，count 永久
   * 停在挂载时的旧值 —— 表现为"新用户登录用户数未更新，只能刷新浏览器才正确"。
   *
   * 旧兜底的 bug：原先依赖 app.ws?.connected 变化触发 useEffect，但 connected 是
   * 普通属性、非响应式状态，WS 连上时组件不会重渲染，useEffect 不会重跑，兜底形同虚设。
   *
   * 修复：服务端每次成功鉴权（打完 userId 标签）都会单独向该客户端下发
   * { type: 'authorized' }，且必然晚于 ws:setTag 及其触发的广播。监听
   * ws:message:authorized 来拉取快照 —— 此刻本连接已被网关计入在线名单，取到的就是
   * 包含自己的最新权威计数，彻底消除竞态，无需任何魔法延时。
   */
  useEffect(() => {
    const onAuthorized = () => {
      if (visibleToAll === true || isAdmin) {
        fetchOnlineUsers();
      }
      // 登录鉴权成功后补收未读广播（与在线人数拉取同源的兜底）
      fetchUnreadBroadcasts();
    };
    app.eventBus?.addEventListener('ws:message:authorized', onAuthorized);
    return () => {
      app.eventBus?.removeEventListener('ws:message:authorized', onAuthorized);
    };
  }, [app, fetchOnlineUsers, fetchUnreadBroadcasts, isAdmin, visibleToAll]);

  // 挂载时（含刷新后）补收一次未读广播，覆盖服务重启/重连等场景
  useEffect(() => {
    if (app.apiClient.auth?.token) {
      fetchUnreadBroadcasts();
    }
  }, [app, fetchUnreadBroadcasts]);

  /**
   * 逻辑三·前端静默检测（防抖上报，杜绝广播风暴）：
   * - 监听全局键鼠事件，15 分钟无任何操作 → 发送 STATUS_AWAY
   * - 关键点：只有状态真正从 AWAY 变回 ACTIVE 的那一瞬间，且经过 500ms 防抖后，
   *   才发送一次 STATUS_ACTIVE；活跃状态下持续操作只重置空闲计时器，绝不重复上报。
   */
  useEffect(() => {
    const IDLE_TIMEOUT = 15 * 60 * 1000; // 15 分钟无操作视为离开
    const ACTIVE_DEBOUNCE = 500; // AWAY → ACTIVE 转变的防抖窗口

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let activeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    // 本地状态机：记录"已上报给服务端"的状态，避免重复发送
    let currentStatus: 'ACTIVE' | 'AWAY' = 'ACTIVE';

    const sendStatus = (status: 'STATUS_ACTIVE' | 'STATUS_AWAY') => {
      try {
        app.ws?.send(JSON.stringify({ type: status }));
      } catch {
        // WS 不可用则忽略
      }
    };

    const handleActivity = () => {
      // 任何活动都重置 15 分钟空闲计时器
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (currentStatus !== 'AWAY') {
          currentStatus = 'AWAY';
          sendStatus('STATUS_AWAY');
        }
      }, IDLE_TIMEOUT);

      // 仅在 AWAY → ACTIVE 转变时，经 500ms 防抖后上报一次；
      // 若已是 ACTIVE，什么都不发（只重置上面的空闲计时器）
      if (currentStatus === 'AWAY') {
        if (activeDebounceTimer) clearTimeout(activeDebounceTimer);
        activeDebounceTimer = setTimeout(() => {
          currentStatus = 'ACTIVE';
          sendStatus('STATUS_ACTIVE');
        }, ACTIVE_DEBOUNCE);
      }
    };

    const events = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart'];
    events.forEach((evt) => window.addEventListener(evt, handleActivity, { passive: true }));

    // 初始：15 分钟无任何操作 → AWAY
    idleTimer = setTimeout(() => {
      if (currentStatus !== 'AWAY') {
        currentStatus = 'AWAY';
        sendStatus('STATUS_AWAY');
      }
    }, IDLE_TIMEOUT);

    return () => {
      events.forEach((evt) => window.removeEventListener(evt, handleActivity));
      if (idleTimer) clearTimeout(idleTimer);
      if (activeDebounceTimer) clearTimeout(activeDebounceTimer);
    };
  }, [app]);

  /**
   * 弱网连接状态检测
   * 使用 useState 追踪 WS 连接状态（app.ws.connected 是普通属性，非响应式），
   * 在 WS 消息到达、窗口聚焦时同步最新状态，确保 UI 能正确反映连接断开/恢复。
   */
  const [isConnecting, setIsConnecting] = useState(() => !app.ws?.connected);

  const handleOpenDrawer = useCallback(() => {
    setDrawerOpen(true);
  }, []);

  const handleCloseDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, []);

  /**
   * 打开发布全局广播 Modal
   */
  const handleOpenBroadcastModal = useCallback(() => {
    setBroadcastModalOpen(true);
  }, []);

  /**
   * 关闭发布全局广播 Modal，重置表单状态
   */
  const handleCloseBroadcastModal = useCallback(() => {
    setBroadcastModalOpen(false);
    setBroadcastContent('');
    setBroadcastMsgType('info');
  }, []);

  /**
   * 发送全局广播：调用 online_users:broadcast API，成功后关闭 Modal 并提示
   */
  const handleSendBroadcast = useCallback(async () => {
    if (!broadcastContent.trim()) {
      message.warning(t('Please enter broadcast content'));
      return;
    }
    setBroadcastSending(true);
    try {
      await app.apiClient.request({
        url: 'online_users:broadcast',
        method: 'POST',
        data: {
          content: broadcastContent.trim(),
          msgType: broadcastMsgType,
        },
      });
      message.success(t('Broadcast sent successfully'));
      setBroadcastModalOpen(false);
      setBroadcastContent('');
      setBroadcastMsgType('info');
    } catch (error: unknown) {
      message.error((error as { message?: string })?.message || t('Failed to send broadcast'));
    } finally {
      setBroadcastSending(false);
    }
  }, [app, broadcastContent, broadcastMsgType, t]);

  /**
   * 强制下线用户
   */
  const handleKick = useCallback(
    (userId: string, nickname: string) => {
      Modal.confirm({
        title: t('Confirm Kick'),
        content: t('Are you sure you want to kick this user?').replace('{user}', nickname || userId),
        okText: t('Kick'),
        cancelText: t('Cancel'),
        okButtonProps: { danger: true },
        onOk: async () => {
          setKickingUserId(userId);
          try {
            const response = await app.apiClient.request({
              url: 'online_users:kick',
              method: 'POST',
              data: { userId },
            });
            const result = response?.data?.data ?? response?.data;
            if (result?.success) {
              message.success(t('User kicked successfully'));
            } else {
              message.error(result?.message || t('Failed to kick user'));
            }
          } catch (error: unknown) {
            message.error((error as { message?: string })?.message || t('Failed to kick user'));
          } finally {
            setKickingUserId(null);
          }
        },
      });
    },
    [app, t],
  );

  // 配置已加载且 visibleToAll 为 false 且用户非管理员：隐藏在线图标，不调用任何 API
  if (visibleToAll === false && !isAdmin) {
    return null;
  }

  return (
    <>
      {/* ===== Header 图标挂件 ===== */}
      {/* 与消息铃铛完全一致：antd Button type="text"（自带悬停背景块）+ Badge size="small" 角标 */}
      <Tooltip
        title={
          isConnecting
            ? t('Connection lost, reconnecting...')
            : t('{{count}} online, click to view/manage').replace('{{count}}', String(count))
        }
        // 修复 Tooltip 穿透：指定 popup 挂载到当前触发节点，防止浮到页面内容区
        getPopupContainer={(trigger) => trigger.parentElement || document.body}
        placement="bottom"
      >
        <Button
          type="text"
          onClick={handleOpenDrawer}
          data-testid="online-count-header-icon"
          className={onlineBadgeClassName}
          style={{ display: 'inline-flex', alignItems: 'center' }}
        >
          {/* 弱网时显示黄色 Loading 图标（无角标） */}
          {isConnecting ? (
            <Spin indicator={<LoadingOutlined style={{ fontSize: 16, color: '#faad14' }} spin />} size="small" />
          ) : (
            <Badge count={count} size="small">
              <TeamOutlined />
            </Badge>
          )}
        </Button>
      </Tooltip>

      {/* ===== Drawer 抽屉 ===== */}
      <Drawer
        title={t('Online Users & Session Management')}
        open={drawerOpen}
        onClose={handleCloseDrawer}
        width="56%"
        destroyOnClose
        styles={{
          body: { padding: 0 },
        }}
        extra={
          isAdmin && (
            <Button type="primary" onClick={handleOpenBroadcastModal}>
              {t('Publish Global Broadcast')}
            </Button>
          )
        }
      >
        <div
          id="online-users-management-drawer"
          data-schema-name="onlineUsersDrawer"
          style={{ padding: 24, minHeight: 200 }}
        >
          {/* 说明：此抽屉由插件直接渲染实时在线用户列表，无需通过 UI 设计器拖拽区块 */}
          <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
            {t('This drawer shows the real-time online users. Admins can force-logout any user directly here.')}
          </Text>

          {/* 在线用户实时列表 */}
          {users.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {users.map((user) => (
                <div
                  key={user.userId}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    background: '#fafafa',
                    borderRadius: 6,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                    {/* 状态指示点 */}
                    <span
                      style={{
                        display: 'inline-block',
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        backgroundColor: statusColor(user.status),
                      }}
                    />
                    <Text strong>{user.nickname}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {statusLabel(user.status, t)}
                    </Text>
                  </div>
                  <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {user.ip}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {t('Sessions')}: {user.clientCount}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {formatTime(user.loginTime)}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {formatDuration(user.duration)}
                    </Text>
                    {/* 管理员可见的强制下线按钮（root 用户不可被踢） */}
                    {isAdmin && user.roleName !== 'root' && (
                      <Button
                        type="link"
                        danger
                        size="small"
                        loading={kickingUserId === user.userId}
                        onClick={() => handleKick(user.userId, user.nickname)}
                      >
                        {t('Kick Out')}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Text type="secondary">{t('No users online')}</Text>
          )}
        </div>
      </Drawer>

      {/* ===== 发布全局广播 Modal ===== */}
      <Modal
        title={t('Publish Global Broadcast')}
        open={broadcastModalOpen}
        onCancel={handleCloseBroadcastModal}
        destroyOnClose
        footer={[
          <Button key="cancel" onClick={handleCloseBroadcastModal}>
            {t('Cancel')}
          </Button>,
          <Button key="send" type="primary" loading={broadcastSending} onClick={handleSendBroadcast}>
            {t('Send')}
          </Button>,
        ]}
      >
        <div style={{ marginBottom: 16 }}>
          <Text style={{ display: 'block', marginBottom: 8 }}>{t('Message Level')}</Text>
          <Radio.Group
            value={broadcastMsgType}
            onChange={(e) => setBroadcastMsgType(e.target.value as 'info' | 'warning' | 'error')}
          >
            <Radio.Button value="info">{t('Info')}</Radio.Button>
            <Radio.Button value="warning">{t('Warning')}</Radio.Button>
            <Radio.Button value="error">{t('Error')}</Radio.Button>
          </Radio.Group>
        </div>
        <Input.TextArea
          value={broadcastContent}
          onChange={(e) => setBroadcastContent(e.target.value)}
          placeholder={t('Enter broadcast content')}
          rows={4}
          maxLength={500}
        />
        {/* 字数显示单独放在 TextArea 下方，避免 antd showCount 与 Modal footer 按钮重叠 */}
        <div style={{ textAlign: 'right', color: 'rgba(0,0,0,0.45)', fontSize: 12, marginTop: 4 }}>
          {broadcastContent.length}/500
        </div>
      </Modal>
    </>
  );
};

export default HeaderOnlineIcon;
