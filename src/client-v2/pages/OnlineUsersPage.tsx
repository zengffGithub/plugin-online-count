import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Table, Tag, Button, Modal, message, Typography, Space, Badge, Tabs } from 'antd';
import { TeamOutlined, LogoutOutlined, StopOutlined, UndoOutlined, StopFilled } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useT } from '../locale';
import type { OnlineUser, OnlineUsersPayload } from '../types';
import { formatDuration, formatTime, unwrapPayload } from '../utils';

const { Title } = Typography;

/** 已禁用用户条目（来自 online_users:blacklisted_users，与在线列表无关） */
interface DisabledUser {
  userId: string;
  nickname: string;
  username?: string;
  online: boolean;
}

export default function OnlineUsersPage() {
  const t = useT();
  const app = useApp();
  const [users, setUsers] = useState<OnlineUser[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [kickingUserIds, setKickingUserIds] = useState<Set<string>>(new Set());
  /** 正在禁用/恢复中的用户 ID */
  const [togglingUserIds, setTogglingUserIds] = useState<Set<string>>(new Set());
  /** 插件配置是否允许当前用户查看在线列表 */
  const [canView, setCanView] = useState<boolean | null>(null);
  /** 已禁用（黑名单）用户列表 */
  const [disabledUsers, setDisabledUsers] = useState<DisabledUser[]>([]);
  const [disabledLoading, setDisabledLoading] = useState(false);

  /** 拉取已禁用用户列表（管理员视图；被禁用用户已下线，不会出现在在线列表，必须查库） */
  const fetchDisabledUsers = useCallback(async () => {
    setDisabledLoading(true);
    try {
      const res = await app.apiClient.request({ url: 'online_users:blacklisted_users' });
      const payload = unwrapPayload<{ users?: DisabledUser[]; data?: DisabledUser[] } | DisabledUser[]>(res);
      const data = Array.isArray(payload) ? payload : payload?.users ?? payload?.data ?? [];
      setDisabledUsers(Array.isArray(data) ? data : []);
    } catch {
      // 无权限或失败时静默（非管理员打开该页时不显示禁用 Tab 内容）
      setDisabledUsers([]);
    } finally {
      setDisabledLoading(false);
    }
  }, [app]);

  useEffect(() => {
    // 先获取配置，再决定是否拉取在线用户列表
    const init = async () => {
      try {
        const role = app.apiClient.auth?.role;
        const isAdmin = role === 'admin' || role === 'root';

        // 优先使用插件实例缓存的配置，回退到直接 API 调用
        const plugin = app.pm?.get('@nocobase/plugin-online-count') as
          | { getConfig?: () => Promise<{ visibleToAll: boolean; singleSession: boolean }> }
          | undefined;
        const config = plugin?.getConfig
          ? await plugin.getConfig()
          : await app.apiClient.request({ url: 'online_count_config:get' }).then((res) => {
              const d = res?.data?.data ?? res?.data ?? {};
              return { visibleToAll: d.visibleToAll !== false, singleSession: d.singleSession === true };
            });
        const visible = config.visibleToAll !== false;

        if (visible || isAdmin) {
          setCanView(true);
          // Fetch initial data
          const res = await app.apiClient.request({ url: 'online_users:list' });
          const payload = (res?.data?.data ?? res?.data ?? {}) as Partial<OnlineUsersPayload> | OnlineUser[];
          const list = Array.isArray(payload) ? payload : payload.users || [];
          setUsers(list);
          setTotalCount(Array.isArray(payload) ? list.length : payload.totalCount ?? list.length);
          if (isAdmin) {
            fetchDisabledUsers();
          }
        } else {
          setCanView(false);
        }
      } catch {
        setCanView(false);
      }
    };
    init();

    // Listen to WebSocket messages for online_users
    const handleOnlineUsers = (event: Event) => {
      const payload = (event as CustomEvent).detail as OnlineUsersPayload;
      if (payload) {
        setUsers(payload.users || []);
        setTotalCount(payload.totalCount || 0);
      }
    };

    app.eventBus?.addEventListener('ws:message:online_users', handleOnlineUsers);

    return () => {
      app.eventBus?.removeEventListener('ws:message:online_users', handleOnlineUsers);
    };
  }, [app, fetchDisabledUsers]);

  const handleKick = useCallback(
    (userId: string) => {
      Modal.confirm({
        title: t('Confirm Kick'),
        content: t('Are you sure you want to kick this user?'),
        okText: t('Kick'),
        cancelText: t('Cancel'),
        okButtonProps: { danger: true },
        onOk: async () => {
          setKickingUserIds((prev) => new Set(prev).add(userId));
          try {
            await app.apiClient.request({
              url: 'online_users:kick',
              method: 'POST',
              data: { userId },
            });
            message.success(t('User kicked successfully'));
          } catch (error: unknown) {
            message.error((error as { message?: string })?.message || t('Failed to kick user'));
          } finally {
            setKickingUserIds((prev) => {
              const next = new Set(prev);
              next.delete(userId);
              return next;
            });
          }
        },
      });
    },
    [app, t],
  );

  /** 重新拉取在线用户列表（禁用/恢复后刷新黑名状态与列表） */
  const refresh = useCallback(async () => {
    try {
      const res = await app.apiClient.request({ url: 'online_users:list' });
      const payload = (res?.data?.data ?? res?.data ?? {}) as Partial<OnlineUsersPayload> | OnlineUser[];
      const list = Array.isArray(payload) ? payload : payload.users || [];
      setUsers(list);
      setTotalCount(Array.isArray(payload) ? list.length : payload.totalCount ?? list.length);
    } catch {
      // 刷新失败忽略
    }
  }, [app]);

  const handleToggleBlacklist = useCallback(
    (userId: string, blacklisted: boolean) => {
      const action = blacklisted ? 'unblacklist' : 'blacklist';
      const confirmTitle = blacklisted ? t('Confirm Restore') : t('Confirm Disable');
      const confirmContent = blacklisted
        ? t('Are you sure you want to restore this user?')
        : t('Are you sure you want to disable this user? They will be forced offline immediately.');
      Modal.confirm({
        title: confirmTitle,
        content: confirmContent,
        okText: blacklisted ? t('Restore') : t('Disable'),
        cancelText: t('Cancel'),
        okButtonProps: { danger: !blacklisted },
        onOk: async () => {
          setTogglingUserIds((prev) => new Set(prev).add(userId));
          try {
            await app.apiClient.request({
              url: `online_users:${action}`,
              method: 'POST',
              data: { userId },
            });
            message.success(blacklisted ? t('User restored successfully') : t('User disabled successfully'));
            await refresh();
            await fetchDisabledUsers();
          } catch (error: unknown) {
            message.error((error as { message?: string })?.message || t('Operation failed'));
          } finally {
            setTogglingUserIds((prev) => {
              const next = new Set(prev);
              next.delete(userId);
              return next;
            });
          }
        },
      });
    },
    [app, t, refresh, fetchDisabledUsers],
  );

  const onlineColumns = useMemo(
    () => [
      {
        title: t('User'),
        dataIndex: 'nickname',
        key: 'nickname',
        render: (text: string, record: OnlineUser) => (
          <Space>
            <Badge status={record.status === 'ACTIVE' ? 'success' : 'warning'} />
            {text}
          </Space>
        ),
      },
      {
        title: t('Status'),
        dataIndex: 'status',
        key: 'status',
        render: (status: string) => (
          <Tag color={status === 'ACTIVE' ? 'green' : 'orange'}>{status === 'ACTIVE' ? t('Active') : t('Away')}</Tag>
        ),
      },
      {
        title: t('Sessions'),
        dataIndex: 'clientCount',
        key: 'clientCount',
      },
      {
        title: t('IP Address'),
        dataIndex: 'ip',
        key: 'ip',
      },
      {
        title: t('Account Status'),
        dataIndex: 'blacklisted',
        key: 'blacklisted',
        render: (blacklisted: boolean) =>
          blacklisted ? <Tag color="red">{t('Disabled')}</Tag> : <Tag color="default">{t('Normal')}</Tag>,
      },
      {
        title: t('Login Time'),
        dataIndex: 'loginTime',
        key: 'loginTime',
        render: (ts: number) => formatTime(ts),
      },
      {
        title: t('Duration'),
        dataIndex: 'duration',
        key: 'duration',
        render: (s: number) => formatDuration(s),
      },
      {
        title: t('Actions'),
        key: 'actions',
        render: (_: unknown, record: OnlineUser) => (
          <Space>
            <Button
              type="link"
              danger
              icon={<LogoutOutlined />}
              onClick={() => handleKick(record.userId)}
              loading={kickingUserIds.has(record.userId)}
              disabled={record.roleName === 'root'}
            >
              {t('Kick Out')}
            </Button>
            {record.roleName !== 'root' &&
              (record.blacklisted ? (
                <Button
                  type="link"
                  icon={<UndoOutlined />}
                  onClick={() => handleToggleBlacklist(record.userId, true)}
                  loading={togglingUserIds.has(record.userId)}
                >
                  {t('Restore')}
                </Button>
              ) : (
                <Button
                  type="link"
                  danger
                  icon={<StopOutlined />}
                  onClick={() => handleToggleBlacklist(record.userId, false)}
                  loading={togglingUserIds.has(record.userId)}
                >
                  {t('Disable')}
                </Button>
              ))}
          </Space>
        ),
      },
    ],
    [t, handleKick, kickingUserIds, handleToggleBlacklist, togglingUserIds],
  );

  const disabledColumns = useMemo(
    () => [
      {
        title: t('User'),
        dataIndex: 'nickname',
        key: 'nickname',
      },
      {
        title: t('Username'),
        dataIndex: 'username',
        key: 'username',
        render: (text: string) => text || '-',
      },
      {
        title: t('Account Status'),
        key: 'blacklisted',
        render: () => <Tag color="red">{t('Disabled')}</Tag>,
      },
      {
        title: t('Online'),
        dataIndex: 'online',
        key: 'online',
        render: (online: boolean) =>
          online ? <Tag color="green">{t('Online')}</Tag> : <Tag color="default">{t('Offline')}</Tag>,
      },
      {
        title: t('Actions'),
        key: 'actions',
        render: (_: unknown, record: DisabledUser) => (
          <Button
            type="link"
            icon={<UndoOutlined />}
            onClick={() => handleToggleBlacklist(record.userId, true)}
            loading={togglingUserIds.has(record.userId)}
          >
            {t('Restore')}
          </Button>
        ),
      },
    ],
    [t, handleToggleBlacklist, togglingUserIds],
  );

  if (canView === false) {
    return (
      <div style={{ padding: 24 }}>
        <Title level={4}>
          <TeamOutlined style={{ marginRight: 8 }} />
          {t('Online Users')}
        </Title>
        <Typography.Text type="secondary">{t('Access denied')}</Typography.Text>
      </div>
    );
  }

  // canView === null 时显示加载状态（配置尚未返回）
  if (canView === null) {
    return (
      <div style={{ padding: 24 }}>
        <Title level={4}>
          <TeamOutlined style={{ marginRight: 8 }} />
          {t('Online Users')}
        </Title>
        <Typography.Text type="secondary">{t('Loading...')}</Typography.Text>
      </div>
    );
  }

  const isAdmin = app.apiClient.auth?.role === 'admin' || app.apiClient.auth?.role === 'root';

  return (
    <div style={{ padding: 24 }}>
      <Title level={4}>
        <TeamOutlined style={{ marginRight: 8 }} />
        {t('Online Users')} ({totalCount})
      </Title>
      <Tabs
        defaultActiveKey="online"
        items={[
          {
            key: 'online',
            label: `${t('Online Users')} (${totalCount})`,
            children: (
              <Table dataSource={users} columns={onlineColumns} rowKey="userId" pagination={false} size="middle" />
            ),
          },
          ...(isAdmin
            ? [
                {
                  key: 'disabled',
                  label: (
                    <Space>
                      <StopFilled style={{ color: '#cf1322' }} />
                      {t('Disabled Users')} ({disabledUsers.length})
                    </Space>
                  ),
                  children: (
                    <Table
                      dataSource={disabledUsers}
                      columns={disabledColumns}
                      rowKey="userId"
                      loading={disabledLoading}
                      pagination={false}
                      size="middle"
                      locale={{ emptyText: t('No disabled users') }}
                    />
                  ),
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}
