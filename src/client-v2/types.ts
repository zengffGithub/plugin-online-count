/**
 * 在线用户数据接口（共享类型）
 * 供 HeaderOnlineIcon、OnlineUsersPage 等组件共用。
 */
export interface OnlineUser {
  userId: string;
  nickname: string;
  clientCount: number;
  loginTime: number;
  duration: number;
  status: 'ACTIVE' | 'AWAY';
  ip: string;
  /** 用户角色名，root 角色不显示强制下线按钮 */
  roleName: string;
  /** 是否被管理员禁用（拉黑） */
  blacklisted: boolean;
}

/**
 * WebSocket 广播的在线用户数据载荷
 */
export interface OnlineUsersPayload {
  users: OnlineUser[];
  totalCount: number;
}

/**
 * 系统广播数据接口
 * 用于 SYSTEM_BROADCAST（单条实时）和 SYSTEM_BROADCAST_SYNC（批量同步）消息
 */
export interface SystemBroadcast {
  id: number;
  content: string;
  msgType: 'info' | 'warning' | 'error';
  sender: string;
  createdAt: string;
}
