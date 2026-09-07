import { Plugin, Application } from '@nocobase/client-v2';
import { setupOnlineCountRuntime } from './runtime';

// WebSocket 连接地址固定使用 '/ws'；网关已剥离 APP_PUBLIC_PATH，不需自行拼接子路径

export class PluginOnlineCountClientV2 extends Plugin<Record<string, unknown>, Application> {
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
    this.flowEngine.registerModelLoaders({
      HeaderOnlineTopbarActionModel: {
        extends: 'TopbarActionModel',
        loader: () => import('./models/HeaderOnlineTopbarActionModel'),
      },
    });

    // ===== 注册设置页面 =====
    this.pluginSettingsManager.addMenuItem({
      key: 'online-count',
      title: this.t('Online Count'),
      icon: 'TeamOutlined',
    });
    // 标签页顺序固定为：设置 → 在线 → 广播管理（sort 越小越靠前）
    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'online-count',
      key: 'index',
      title: this.t('Settings'),
      sort: 1,
      componentLoader: () => import('./pages/SettingsPage'),
    });
    // 在线用户管理（完整表格：含 Disable/Restore/Kick Out、IP、Account Status、时长等列）
    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'online-count',
      key: 'online-users',
      title: this.t('Online Users'),
      icon: 'TeamOutlined',
      sort: 2,
      componentLoader: () => import('./pages/OnlineUsersPage'),
    });
    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'online-count',
      key: 'broadcasts',
      title: this.t('Broadcast Management'),
      sort: 3,
      componentLoader: () => import('./pages/BroadcastsPage'),
    });

    // ===== 启动共享 WS 运行时（心跳/设备指纹/登出检测/强制下线/广播转发） =====
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

export default PluginOnlineCountClientV2;
