# @nocobase/plugin-online-count

[中文](#功能特性) | [English](#features)

在线人数统计与在线用户管理插件。实时统计当前在线用户数量、展示在线用户列表，并提供单会话互斥登录（设备指纹）、强制下线、用户黑名单、系统广播、会话日志等功能。

## 功能特性

- **实时在线人数**：顶栏展示当前在线用户总数，所有登录用户可见（可在设置中限制为仅管理员可见）。
- **在线用户列表**：查看当前在线用户、登录设备、登录时间、状态（活跃 / 离开）。
- **单会话互斥登录（设备指纹）**：开启后同一账号仅允许「一台设备」在线。基于浏览器 `localStorage` 生成的稳定 `deviceId` 区分设备——**同一浏览器的多个标签页 / 窗口视为同一台设备，互不踢下线**；只有 `deviceId` 真正不同的设备登录时，才会把旧设备踢下线。
- **强制下线（kick）**：管理员 / root 可强制指定用户立即下线。
- **用户黑名单（blacklist）**：拉黑用户后，其再次登录将被服务端立即强制下线（注意：拉黑是「临时下线」，不会修改 `users.blacklisted` 之外的其他数据）。
- **系统广播**：管理员 / root 可向全站发送广播消息，用户可在顶栏接收并标记已读；广播默认 7 天后过期。
- **广播管理**：在「广播管理」标签页中发布系统广播、查看每条广播的已读情况，并支持单选 / 多选批量删除。
- **会话日志**：记录每次登录 / 登出 / 被踢的明细（登录时间、时长、IP、UA、登出原因等），保留 30 天后自动清理。

## 安装与启用

1. 作为 NocoBase 插件安装（置于 `packages/plugins/@nocobase/plugin-online-count`）。
2. 在「插件管理」中启用本插件。
3. 启用后插件会自动建表（见下方「数据库表结构」），无需手动迁移。

> 开发模式下插件直接读取 `src` 并支持热更新；生产部署执行 `yarn build @nocobase/plugin-online-count` 生成 `dist/`。

## 插件设置

路径：**插件设置 → Online Count**（或顶栏在线图标进入设置页）。该菜单下包含三个标签页，固定顺序为：

1. **设置（Settings）**：插件配置（`visibleToAll` / `singleSession`）。
2. **在线（Online Users）**：实时在线用户列表，支持强制下线、拉黑 / 解禁、查看已禁用用户。
3. **广播管理（Broadcast Management）**：系统广播的发布、查看已读情况、单选 / 多选批量删除。

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `visibleToAll` | boolean | `true` | 在线人数 / 在线用户列表是否对所有登录用户可见；关闭后仅管理员 / root 可见。 |
| `singleSession` | boolean | `false` | 是否启用单会话（同一账号仅允许一台设备在线）。开启后配合设备指纹实现「同浏览器多标签不互踢、异设备才踢」。 |

配置持久化在 `onlineCountConfig` 表中（单条记录，`key = 'config'`）。

## 架构概览

- **服务端**：监听 WebSocket 生命周期事件（`ws:setTag` / `ws:removeTag` / `ws:message:*`），在内存中维护 `userSessions`（按 `userId` 聚合的连接集合），并通过节流（2 秒，leading + trailing）向全网广播在线名单。
- **前端**：顶栏 `HeaderOnlineIcon` 组件订阅广播实时刷新计数；并在每次 WebSocket 建连（`open`）时上报 `deviceId`，用于服务端设备识别。
- **在线名单是「100% 网关驱动」**：列表直接读取网关层带有 `userId#<id>` 标签的 WS 连接并按 `userId` 聚合，与服务端内存状态解耦——一个用户从在线名单消失，当且仅当其 WS 连接在网关层被真正移除（关标签页 / 关浏览器 / 断网 / 被强制移除标签）。

## 数据库表结构

插件启用后会在数据库中创建 **4 张新表**，并 **扩展 1 张现有表（`users`）**。

### 新建表

#### 1. `onlineCountConfig` — 插件配置表（单条记录）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `key` | string（主键，`autoGenId: false`） | 固定为 `'config'` |
| `visibleToAll` | boolean（默认 `true`） | 在线人数是否对所有用户可见 |
| `singleSession` | boolean（默认 `false`） | 是否启用单会话互斥登录 |

#### 2. `sessionLogs` — 会话日志表

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | 自动主键 | — |
| `userId` | string（外键 → `users.id`，`belongsTo user`） | 用户 ID |
| `loginTime` | date | 登录时间 |
| `logoutTime` | date | 登出时间 |
| `duration` | integer | 在线时长（秒） |
| `logoutReason` | string | 登出原因：`normal` / `logged_in_elsewhere` / `blacklisted` 等 |
| `ip` | string | 登录 IP |
| `userAgent` | text | 客户端 User-Agent |
| `status` | string | 会话状态：`ACTIVE` / `AWAY` |

#### 3. `systemBroadcasts` — 系统广播消息表

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | 自动主键 | — |
| `content` | text | 广播内容 |
| `msgType` | string（默认 `'info'`） | 消息类型 |
| `sender` | string | 发送者标识 |
| `expiresAt` | date | 过期时间（默认创建时 +7 天） |

#### 4. `userBroadcastReads` — 用户广播已读记录表

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | 自动主键 | — |
| `userId` | string | 用户 ID |
| `broadcastId` | integer | 广播 ID |
| `readAt` | date | 标记已读时间 |

> 唯一索引：`(userId, broadcastId)`，防止重复标记已读。

### 扩展现有表

- **`users`**：新增字段 `blacklisted`（boolean，默认 `false`）—— 是否被列入黑名单。被拉黑用户登录时服务端立即下发 `FORCE_LOGOUT` 并断开连接。

## REST API

插件注册了两个资源（resource），并通过 ACL 控制权限：

### `online_users`

| Action | 权限 | 说明 |
| --- | --- | --- |
| `list` | 所有登录用户（`loggedIn`） | 获取当前在线用户列表（含总数、状态、设备信息等） |
| `kick` | 仅管理员 / root | 强制指定用户下线（临时下线，不写黑名单） |
| `blacklist` | 仅管理员 / root | 将指定用户加入黑名单（其再次登录将被立即强制下线） |
| `unblacklist` | 仅管理员 / root | 解除指定用户的黑名单 |
| `blacklisted_users` | 仅管理员 / root | 获取被拉黑用户列表（含其当前是否在线） |
| `broadcast` | 仅管理员 / root | 向全站发送系统广播 |
| `read_broadcast` | 所有登录用户（`loggedIn`） | 标记某条广播为已读 |
| `list_broadcasts` | 所有登录用户（`loggedIn`） | 获取当前用户未读广播列表 |
| `broadcasts` | 仅管理员 / root | 获取全部广播列表（用于广播管理页） |
| `broadcast_reads` | 仅管理员 / root | 获取某条广播的已读用户明细 |
| `broadcast_delete` | 仅管理员 / root | 批量删除广播（POST `{ ids: number[] }` 或 `{ id }`），级联删除已读记录 |

### `online_count_config`

| Action | 权限 | 说明 |
| --- | --- | --- |
| `get` | 所有登录用户（`loggedIn`） | 读取插件配置（`visibleToAll` / `singleSession`） |
| `set` | 仅管理员 / root | 更新插件配置 |

## WebSocket 事件

- **客户端 → 服务端**
  - `online_device`：`{ type:'online_device', payload:{ deviceId } }`，建连时上报设备指纹。
  - `pong`：响应服务端心跳 Ping。
  - `LOGOUT_NOTIFY`：客户端主动登出时通知服务端移除会话。
- **服务端 → 客户端**
  - `LOGGED_IN_ELSEWHERE`：账号在其他设备登录（单会话模式下被踢）。
  - `FORCE_LOGOUT`：被强制下线 / 被拉黑。
  - `SERVER_RESTART`：服务端重启通知。
  - `SYSTEM_BROADCAST` / `SYSTEM_BROADCAST_SYNC`：系统广播及其同步。
  - `online_users`：在线名单广播（节流，仅当名单变化时才下发）。

## 单会话与设备指纹（重要设计说明）

开启 `singleSession` 后，互斥登录的判定单位从「WebSocket 连接」改为「设备」：

- 前端在 `localStorage`（同域下所有标签页 / 窗口共享）生成稳定 `deviceId`，每次 WebSocket 建连时上报。
- 服务端把同一 `userId` 下的连接按 `deviceId` 分组：
  - **同一 `deviceId`（同一浏览器多标签）→ 彼此保留，不互踢。**
  - 仅当存在 ≥2 个不同已知 `deviceId` 时，才保留「最近登录」的设备，踢出其余设备。
  - 设备指纹未知（旧版客户端未上报 / 消息乱序）的连接保守不踢，待后续收敛判定。

> ⚠️ 绝对禁止恢复「无差别踢旧 clientId」的旧逻辑——那会导致同一浏览器多开窗口互相踢下线。

## 数据保留与清理策略

| 对象 | 策略 |
| --- | --- |
| `sessionLogs` 会话日志 | 保留 30 天，过期自动清理（每天执行一次）。 |
| 过期 WS 连接 | 超过 90 秒无心跳响应视为离线并清理（每 30 秒扫描一次），杜绝「幽灵在线」。 |
| 系统广播 | 默认 7 天过期，过期后不再下发。 |

## 前端组件

| 文件 | 说明 |
| --- | --- |
| `client-v2/components/HeaderOnlineIcon.tsx` | 顶栏在线人数图标，订阅广播实时刷新计数。 |
| `client-v2/pages/OnlineUsersPage.tsx` | 在线用户列表页（查看 / 强制下线 / 拉黑 / 解禁 / 已禁用用户）。 |
| `client-v2/pages/BroadcastsPage.tsx` | 广播管理页（发布 / 查看已读 / 单选 / 多选批量删除）。 |
| `client-v2/pages/SettingsPage.tsx` | 插件设置页（visibleToAll / singleSession）。 |
| `client-v2/models/HeaderOnlineTopbarActionModel.tsx` | 顶栏动作模型扩展。 |

## 构建

```bash
# 生产构建（生成 dist/）
yarn build @nocobase/plugin-online-count
# 或
node packages/core/build/bin/nocobase-build.js @nocobase/plugin-online-count --no-dts
```

> `--no-dts` 可跳过类型声明（`.d.ts`）生成阶段；该阶段因插件内 `this.t()` 的已知类型噪音会失败，但不影响 JS 产物。

## 许可

Apache-2.0

---

## Features

Real-time online user counting and online user management plugin. Tracks current online user count, displays online user lists, and provides single-session mutual-exclusion login (device fingerprint), forced logout, user blacklist, system broadcasts, and session logging.

### Feature Overview

- **Real-time online count**: Header badge shows current online user count, visible to all logged-in users (can be restricted to admins only in settings).
- **Online user list**: View currently online users, login device, login time, and status (Active / Away).
- **Single-session mutual-exclusion login (device fingerprint)**: When enabled, only one device per account is allowed online. Uses a stable `deviceId` from browser `localStorage` to distinguish devices — **multiple tabs/windows in the same browser count as one device and do not kick each other**; only devices with different `deviceId`s trigger a kick of the older session.
- **Forced logout (kick)**: Admins/root can force any user offline immediately.
- **User blacklist**: Blacklisted users are immediately forced offline on their next login (blacklist is a temporary measure that only sets `users.blacklisted`, no other data is modified).
- **System broadcasts**: Admins/root can send site-wide broadcast messages; users receive them via the header icon and can mark as read; broadcasts expire after 7 days by default.
- **Broadcast management**: Publish system broadcasts, view read status per broadcast, and batch-delete broadcasts (single or multi-select).
- **Session logging**: Records each login/logout/kick event (login time, duration, IP, User-Agent, logout reason, etc.), auto-cleaned after 30 days.

## Installation & Activation

1. Install as a NocoBase plugin (place under `packages/plugins/@nocobase/plugin-online-count`).
2. Enable the plugin in **Plugin Management**.
3. The plugin auto-creates database tables on activation (see [Database Tables](#database-tables)) — no manual migrations required.

> In development mode, the plugin reads directly from `src` with hot-reload support. For production, run `yarn build @nocobase/plugin-online-count` to generate `dist/`.

## Plugin Settings

Path: **Plugin Settings → Online Count** (or click the header online icon). Contains three tabs in fixed order:

1. **Settings**: Plugin configuration (`visibleToAll` / `singleSession`).
2. **Online Users**: Real-time online user list with kick, blacklist/unblacklist, and disabled user viewing.
3. **Broadcast Management**: Publish system broadcasts, view read status, and batch-delete.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `visibleToAll` | boolean | `true` | Whether online count/list is visible to all logged-in users; when off, only admins/root can see it. |
| `singleSession` | boolean | `false` | Enable single-session (one device per account). Uses device fingerprint to avoid kicking same-browser tabs. |

Configuration is persisted in the `onlineCountConfig` table (single record, `key = 'config'`).

## Architecture Overview

- **Server**: Listens to WebSocket lifecycle events (`ws:setTag` / `ws:removeTag` / `ws:message:*`), maintains `userSessions` in memory (aggregated by `userId`), and broadcasts the online list via throttled (2s, leading + trailing) WebSocket push.
- **Client**: The `HeaderOnlineIcon` component subscribes to broadcasts for real-time count; on each WebSocket `open`, it reports the `deviceId` for server-side device recognition.
- **Online list is 100% gateway-driven**: The list reads directly from gateway-level WS connections tagged with `userId#<id>` and aggregates by `userId`, decoupled from server memory state — a user disappears from the online list if and only if their WS connection is truly removed at the gateway (tab closed / browser closed / network lost / tag force-removed).

## Database Tables

The plugin creates **4 new tables** and **extends 1 existing table (`users`)**.

### New Tables

#### 1. `onlineCountConfig` — Plugin config table (single record)

| Field | Type | Description |
| --- | --- | --- |
| `key` | string (PK, `autoGenId: false`) | Fixed as `'config'` |
| `visibleToAll` | boolean (default `true`) | Whether online count is visible to all users |
| `singleSession` | boolean (default `false`) | Whether single-session mutual-exclusion is enabled |

#### 2. `sessionLogs` — Session log table

| Field | Type | Description |
| --- | --- | --- |
| `id` | auto PK | — |
| `userId` | string (FK → `users.id`, `belongsTo user`) | User ID |
| `loginTime` | date | Login time |
| `logoutTime` | date | Logout time |
| `duration` | integer | Online duration (seconds) |
| `logoutReason` | string | Logout reason: `normal` / `logged_in_elsewhere` / `blacklisted`, etc. |
| `ip` | string | Login IP |
| `userAgent` | text | Client User-Agent |
| `status` | string | Session status: `ACTIVE` / `AWAY` |

#### 3. `systemBroadcasts` — System broadcast message table

| Field | Type | Description |
| --- | --- | --- |
| `id` | auto PK | — |
| `content` | text | Broadcast content |
| `msgType` | string (default `'info'`) | Message type |
| `sender` | string | Sender identifier |
| `expiresAt` | date | Expiry time (default: creation + 7 days) |

#### 4. `userBroadcastReads` — User broadcast read-receipt table

| Field | Type | Description |
| --- | --- | --- |
| `id` | auto PK | — |
| `userId` | string | User ID |
| `broadcastId` | integer | Broadcast ID |
| `readAt` | date | Marked-read time |

> Unique index: `(userId, broadcastId)` — prevents duplicate read receipts.

### Extended Table

- **`users`**: Added field `blacklisted` (boolean, default `false`) — whether the user is blacklisted. Blacklisted users are immediately sent `FORCE_LOGOUT` and disconnected on login.

## REST API

Two resources are registered with ACL-controlled permissions:

### `online_users`

| Action | Permission | Description |
| --- | --- | --- |
| `list` | All logged-in users (`loggedIn`) | Get current online user list (with count, status, device info) |
| `kick` | Admin/root only | Force a user offline (temporary, does not set blacklist) |
| `blacklist` | Admin/root only | Add a user to the blacklist (next login will be immediately blocked) |
| `unblacklist` | Admin/root only | Remove a user from the blacklist |
| `blacklisted_users` | Admin/root only | Get blacklisted user list (with current online status) |
| `broadcast` | Admin/root only | Send a site-wide system broadcast |
| `read_broadcast` | All logged-in users (`loggedIn`) | Mark a broadcast as read |
| `list_broadcasts` | All logged-in users (`loggedIn`) | Get unread broadcasts for the current user |
| `broadcasts` | Admin/root only | Get all broadcasts (for broadcast management page) |
| `broadcast_reads` | Admin/root only | Get read-receipt details for a specific broadcast |
| `broadcast_delete` | Admin/root only | Batch-delete broadcasts (POST `{ ids: number[] }` or `{ id }`), cascades read records |

### `online_count_config`

| Action | Permission | Description |
| --- | --- | --- |
| `get` | All logged-in users (`loggedIn`) | Read plugin config (`visibleToAll` / `singleSession`) |
| `set` | Admin/root only | Update plugin config |

## WebSocket Events

- **Client → Server**
  - `online_device`: `{ type:'online_device', payload:{ deviceId } }` — reports device fingerprint on connect.
  - `pong`: Response to server heartbeat ping.
  - `LOGOUT_NOTIFY`: Notifies server to remove session on client-initiated logout.
- **Server → Client**
  - `LOGGED_IN_ELSEWHERE`: Account logged in on another device (kicked under single-session mode).
  - `FORCE_LOGOUT`: Forced offline / blacklisted.
  - `SERVER_RESTART`: Server restart notification.
  - `SYSTEM_BROADCAST` / `SYSTEM_BROADCAST_SYNC`: System broadcast and its sync.
  - `online_users`: Online list broadcast (throttled, only sent when the list changes).

## Single-Session & Device Fingerprint (Design Notes)

When `singleSession` is enabled, the mutual-exclusion unit changes from "WebSocket connection" to "device":

- The client generates a stable `deviceId` in `localStorage` (shared across all tabs/windows in the same domain) and reports it on each WebSocket connection.
- The server groups connections by `deviceId` under the same `userId`:
  - **Same `deviceId` (same browser, multiple tabs) → kept, no mutual kicking.**
  - Only when ≥2 different known `deviceId`s exist, the most recently logged-in device is kept and others are kicked.
  - Connections with unknown device fingerprint (legacy client / out-of-order messages) are conservatively not kicked, pending convergence resolution.

> ⚠️ Never revert to the old "indiscriminately kick old clientId" logic — that would cause same-browser tabs to kick each other.

## Data Retention & Cleanup

| Object | Strategy |
| --- | --- |
| `sessionLogs` | Retained 30 days, auto-cleaned daily. |
| Stale WS connections | No heartbeat for 90s → marked offline and cleaned (scanned every 30s). |
| System broadcasts | Default 7-day expiry; expired broadcasts are no longer pushed. |

## Client Components

| File | Description |
| --- | --- |
| `client-v2/components/HeaderOnlineIcon.tsx` | Header online count icon, subscribes to broadcasts for real-time refresh. |
| `client-v2/pages/OnlineUsersPage.tsx` | Online user list page (view / kick / blacklist / unblacklist / disabled users). |
| `client-v2/pages/BroadcastsPage.tsx` | Broadcast management page (publish / view reads / batch-delete). |
| `client-v2/pages/SettingsPage.tsx` | Plugin settings page (visibleToAll / singleSession). |
| `client-v2/models/HeaderOnlineTopbarActionModel.tsx` | Header topbar action model extension. |

## Build

```bash
# Production build (generates dist/)
yarn build @nocobase/plugin-online-count
# Or
node packages/core/build/bin/nocobase-build.js @nocobase/plugin-online-count --no-dts
```

> `--no-dts` skips the type declaration (`.d.ts`) generation step; this step may fail due to known type noise from `this.t()` but does not affect JS output.

## License

Apache-2.0
