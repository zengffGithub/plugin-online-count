/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/client';
// V2 handles model registration via FlowEngine; V1 only needs runtime init
import { setupOnlineCountRuntime } from '../client-v2/runtime';

export class PluginOnlineCountClient extends Plugin {
  private disposeWsRuntime: (() => void) | null = null;

  /** 缓存的插件配置，避免多个组件重复请求 online_count_config:get */
  private cachedConfig: { visibleToAll: boolean; singleSession: boolean } | null = null;
  private configPromise: Promise<{ visibleToAll: boolean; singleSession: boolean }> | null = null;

  /**
   * 获取插件配置（带缓存）。首次调用时从服务端获取并缓存，后续调用直接返回缓存值。
   */
  async getConfig(): Promise<{ visibleToAll: boolean; singleSession: boolean }> {
    if (this.cachedConfig) return this.cachedConfig;

    if (!this.configPromise) {
      this.configPromise = this.app.apiClient
        .request({ url: 'online_count_config:get' })
        .then((res) => {
          const data = res?.data?.data ?? res?.data ?? {};
          this.cachedConfig = {
            visibleToAll: data.visibleToAll !== false,
            singleSession: data.singleSession === true,
          };
          return this.cachedConfig;
        })
        .catch(() => {
          this.configPromise = null;
          return { visibleToAll: true, singleSession: false };
        });
    }

    return this.configPromise;
  }

  async load() {
    // ===== 注册设置页面（dotted-key 协议，自动注册 /admin/settings/online-count/* 路由） =====
    this.pluginSettingsManager.add('online-count', {
      title: this.t('Online Count'),
      icon: 'TeamOutlined',
    });
    // 标签页顺序固定为：设置 → 在线 → 广播管理（sort 越小越靠前）
    this.pluginSettingsManager.add('online-count.index', {
      title: this.t('Settings'),
      sort: 1,
      componentLoader: () => import('../client-v2/pages/SettingsPage'),
    });
    // 在线用户管理（完整表格：含 Disable/Restore/Kick Out、IP、Account Status、时长等列）
    this.pluginSettingsManager.add('online-count.online-users', {
      title: this.t('Online Users'),
      icon: 'TeamOutlined',
      sort: 2,
      componentLoader: () => import('../client-v2/pages/OnlineUsersPage'),
    });
    this.pluginSettingsManager.add('online-count.broadcasts', {
      title: this.t('Broadcast Management'),
      sort: 3,
      componentLoader: () => import('../client-v2/pages/BroadcastsPage'),
    });

    // ===== 启动共享 WS 运行时（心跳/设备指纹/登出检测/强制下线/广播转发） =====
    // V1 与 V2 共用同一套 WebSocket 协议，保证双端在线状态一致。
    this.disposeWsRuntime = setupOnlineCountRuntime({
      app: this.app,
      t: (key) => String(this.t(key)),
    });
  }

  async afterDisable() {
    this.disposeWsRuntime?.();
    this.disposeWsRuntime = null;
  }
}

export default PluginOnlineCountClient;
