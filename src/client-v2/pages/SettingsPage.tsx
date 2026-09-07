import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Card, Switch, Typography, Divider, message } from 'antd';
import { useApp } from '@nocobase/client-v2';
import { useT } from '../locale';

const { Text } = Typography;

/**
 * 在线人数插件设置页面
 *
 * 配置项：
 * 1. visibleToAll - 是否对所有登录用户可见在线用户列表
 * 2. singleSession - 单设备互斥登录开关
 */
export default function SettingsPage() {
  const t = useT();
  const app = useApp();
  const [visibleToAll, setVisibleToAll] = useState(true);
  const [singleSession, setSingleSession] = useState(false);
  const [loadingVisible, setLoadingVisible] = useState(false);
  const [loadingSingle, setLoadingSingle] = useState(false);

  // 使用 ref 追踪最新值，避免两个 Switch 独立发送请求时的竞态条件
  const visibleToAllRef = useRef(visibleToAll);
  const singleSessionRef = useRef(singleSession);
  useEffect(() => {
    visibleToAllRef.current = visibleToAll;
  }, [visibleToAll]);
  useEffect(() => {
    singleSessionRef.current = singleSession;
  }, [singleSession]);

  useEffect(() => {
    const fetchConfig = async () => {
      try {
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
        if (typeof config.visibleToAll === 'boolean') {
          setVisibleToAll(config.visibleToAll);
        }
        if (typeof config.singleSession === 'boolean') {
          setSingleSession(config.singleSession);
        }
      } catch {
        // ignore
      }
    };
    fetchConfig();
  }, [app]);

  /**
   * 统一配置更新方法：始终携带两个最新值，消除两个 Switch 独立发请求的竞态。
   */
  const handleToggleVisible = useCallback(
    async (checked: boolean) => {
      setLoadingVisible(true);
      try {
        await app.apiClient.request({
          url: 'online_count_config:set',
          method: 'POST',
          data: {
            visibleToAll: checked,
            singleSession: singleSessionRef.current,
          },
        });
        setVisibleToAll(checked);
        message.success(t('Settings saved'));
      } catch (error: unknown) {
        const err = error as { message?: string };
        message.error(err?.message || t('Failed to save settings'));
      } finally {
        setLoadingVisible(false);
      }
    },
    [app, t],
  );

  const handleToggleSingleSession = useCallback(
    async (checked: boolean) => {
      setLoadingSingle(true);
      try {
        await app.apiClient.request({
          url: 'online_count_config:set',
          method: 'POST',
          data: {
            visibleToAll: visibleToAllRef.current,
            singleSession: checked,
          },
        });
        setSingleSession(checked);
        message.success(t('Settings saved'));
      } catch (error: unknown) {
        const err = error as { message?: string };
        message.error(err?.message || t('Failed to save settings'));
      } finally {
        setLoadingSingle(false);
      }
    },
    [app, t],
  );

  return (
    <div style={{ padding: 24 }}>
      <Card title={t('Online Count Settings')}>
        {/* 在线用户列表可见性 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <Text strong>{t('Visible to all logged-in users')}</Text>
            <br />
            <Text type="secondary">
              {visibleToAll
                ? t('All logged-in users can see the online user list')
                : t('Only administrators can see the online user list')}
            </Text>
          </div>
          <Switch checked={visibleToAll} onChange={handleToggleVisible} loading={loadingVisible} />
        </div>

        <Divider />

        {/* 单设备互斥登录 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <Text strong>{t('Single Session (Mutual Exclusion)')}</Text>
            <br />
            <Text type="secondary">
              {t('When enabled, logging in on a new device will force logout on the old device')}
            </Text>
          </div>
          <Switch checked={singleSession} onChange={handleToggleSingleSession} loading={loadingSingle} />
        </div>
      </Card>
    </div>
  );
}
