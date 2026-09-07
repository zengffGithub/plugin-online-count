// 在线人数插件共享工具函数
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** 格式化时间戳为本地时间字符串 */
export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

/** 状态文本标签 */
export function statusLabel(status: string, t: (key: string) => string): string {
  return status === 'ACTIVE' ? t('Active') : t('Away');
}

/** 状态颜色 */
export function statusColor(status: string): string {
  return status === 'ACTIVE' ? '#52c41a' : '#faad14';
}

// 稳健解包 NocoBase API 响应：兼容 { data: payload } 和 { data: { data: payload } } 两种 wire 格式
export function unwrapPayload<T = unknown>(res: unknown): T {
  const body = (res as { data?: unknown })?.data;
  if (body && typeof body === 'object' && !Array.isArray(body) && (body as { data?: unknown }).data !== undefined) {
    const inner = (body as { data?: unknown }).data;
    if (inner !== null && typeof inner === 'object') {
      return inner as T;
    }
  }
  return (body ?? res) as T;
}
