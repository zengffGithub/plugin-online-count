// 设备指纹互斥纯决策逻辑（与框架解耦，便于单元测试）。仅决定踢谁，不执行副作用。

export interface KickPlan {
  /** 需要被踢下线的 clientId 列表 */
  toKick: string[];
}

interface KickOnNewConnectionInput {
  /** 触发本次登录的新连接 clientId */
  newClientId: string;
  /** 新连接上报的设备指纹；undefined 表示尚未上报（legacy 客户端 / 消息乱序） */
  newDeviceId?: string;
  /** 该用户当前会话里已有的全部 clientId */
  existingClientIds: string[];
  /** clientId -> deviceId 指纹表 */
  clientDeviceId: Map<string, string>;
}

// 新连接踢人决策：newDeviceId 未知不踢；仅踢 deviceId 不同的旧连接；legacy 未上报的不踢
export function computeKickOnNewConnection(input: KickOnNewConnectionInput): KickPlan {
  const { newClientId, newDeviceId, existingClientIds, clientDeviceId } = input;
  if (!newDeviceId) return { toKick: [] };

  const toKick: string[] = [];
  for (const cid of existingClientIds) {
    if (cid === newClientId) continue;
    const dev = clientDeviceId.get(cid);
    if (dev && dev !== newDeviceId) {
      toKick.push(cid);
    }
  }
  return { toKick };
}

interface EnforceInput {
  existingClientIds: string[];
  clientDeviceId: Map<string, string>;
  clientPingTimes: Map<string, number>;
}

// 收敛决策：按 deviceId 分组保留最近登录设备，踢其余；<2 个已知设备不踢；收敛点，消息乱序也能收敛
export function computeEnforceSingleDevice(input: EnforceInput): KickPlan {
  const { existingClientIds, clientDeviceId, clientPingTimes } = input;

  const groups = new Map<string, string[]>();
  for (const cid of existingClientIds) {
    const dev = clientDeviceId.get(cid);
    if (!dev) continue;
    const arr = groups.get(dev);
    if (arr) arr.push(cid);
    else groups.set(dev, [cid]);
  }

  const knownDevices = Array.from(groups.keys());
  if (knownDevices.length < 2) return { toKick: [] };

  let winnerDevice = knownDevices[0];
  let winnerPing = -1;
  for (const dev of knownDevices) {
    for (const cid of groups.get(dev) ?? []) {
      const ping = clientPingTimes.get(cid) ?? 0;
      if (ping > winnerPing) {
        winnerPing = ping;
        winnerDevice = dev;
      }
    }
  }

  const toKick: string[] = [];
  for (const dev of knownDevices) {
    if (dev === winnerDevice) continue;
    toKick.push(...(groups.get(dev) ?? []));
  }
  return { toKick };
}
