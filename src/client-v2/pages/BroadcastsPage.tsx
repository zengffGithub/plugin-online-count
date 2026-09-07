import React, { useEffect, useState, useCallback } from 'react';
import { Table, Tag, Button, Drawer, Typography, Space, message, Modal, Input, Radio, Popconfirm } from 'antd';
import { NotificationOutlined, EyeOutlined, SendOutlined, DeleteOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useT } from '../locale';
import { formatTime, unwrapPayload } from '../utils';

const { Title, Text } = Typography;

interface BroadcastItem {
  id: number;
  content: string;
  msgType: 'info' | 'warning' | 'error';
  sender: string;
  createdAt: string;
  expiresAt: string | null;
  readCount: number;
  totalUsers: number;
}

interface ReaderItem {
  userId: string;
  nickname: string;
  readAt: string;
}

const MSG_TYPE_COLOR: Record<string, string> = {
  info: 'blue',
  warning: 'orange',
  error: 'red',
};

function msgTypeLabel(msgType: string, t: (key: string) => string): string {
  if (msgType === 'info') return t('Info');
  if (msgType === 'warning') return t('Warning');
  if (msgType === 'error') return t('Error');
  return msgType;
}

export default function BroadcastsPage() {
  const t = useT();
  const app = useApp();
  const [broadcasts, setBroadcasts] = useState<BroadcastItem[]>([]);
  const [loading, setLoading] = useState(false);

  // 已读明细抽屉
  const [readDrawerOpen, setReadDrawerOpen] = useState(false);
  const [currentBroadcast, setCurrentBroadcast] = useState<BroadcastItem | null>(null);
  const [readers, setReaders] = useState<ReaderItem[]>([]);
  const [readersLoading, setReadersLoading] = useState(false);

  // 发布广播 Modal
  const [sendModalOpen, setSendModalOpen] = useState(false);
  const [sendContent, setSendContent] = useState('');
  const [sendMsgType, setSendMsgType] = useState<'info' | 'warning' | 'error'>('info');
  const [sendLoading, setSendLoading] = useState(false);

  // 多选 + 批量删除
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const fetchBroadcasts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await app.apiClient.request({ url: 'online_users:broadcasts', method: 'get' });
      const payload = unwrapPayload<{ broadcasts?: BroadcastItem[]; data?: BroadcastItem[] } | BroadcastItem[]>(res);
      const data = Array.isArray(payload) ? payload : payload?.broadcasts ?? payload?.data ?? [];
      setBroadcasts(Array.isArray(data) ? data : []);
    } catch {
      setBroadcasts([]);
    } finally {
      setLoading(false);
    }
  }, [app]);

  useEffect(() => {
    fetchBroadcasts();
  }, [fetchBroadcasts]);

  const handleOpenSendModal = useCallback(() => {
    setSendContent('');
    setSendMsgType('info');
    setSendModalOpen(true);
  }, []);

  const handleCloseSendModal = useCallback(() => {
    setSendModalOpen(false);
    setSendContent('');
    setSendMsgType('info');
  }, []);

  const handleSendBroadcast = useCallback(async () => {
    if (!sendContent.trim()) {
      message.warning(t('Please enter broadcast content'));
      return;
    }
    setSendLoading(true);
    try {
      await app.apiClient.request({
        url: 'online_users:broadcast',
        method: 'POST',
        data: { content: sendContent.trim(), msgType: sendMsgType },
      });
      message.success(t('Broadcast sent successfully'));
      handleCloseSendModal();
      fetchBroadcasts();
    } catch (error: unknown) {
      message.error((error as { message?: string })?.message || t('Failed to send broadcast'));
    } finally {
      setSendLoading(false);
    }
  }, [app, sendContent, sendMsgType, t, fetchBroadcasts, handleCloseSendModal]);

  /**
   * 删除广播（单条或批量）。服务端会级联删除对应的已读记录。
   * 已弹出过的通知无法撤回，删除后其他用户拉取未读时不再包含这些广播。
   */
  const handleDeleteBroadcasts = useCallback(
    async (ids: number[]) => {
      if (!ids.length) return;
      setDeleteLoading(true);
      try {
        await app.apiClient.request({
          url: 'online_users:broadcast_delete',
          method: 'POST',
          data: { ids },
        });
        message.success(t('Broadcast deleted successfully'));
        setSelectedRowKeys([]);
        fetchBroadcasts();
      } catch (error: unknown) {
        message.error((error as { message?: string })?.message || t('Failed to delete broadcast'));
      } finally {
        setDeleteLoading(false);
      }
    },
    [app, t, fetchBroadcasts],
  );

  const handleBatchDelete = useCallback(() => {
    handleDeleteBroadcasts(selectedRowKeys.map((k) => Number(k)));
  }, [handleDeleteBroadcasts, selectedRowKeys]);

  const openReadDrawer = useCallback(
    async (b: BroadcastItem) => {
      setCurrentBroadcast(b);
      setReadDrawerOpen(true);
      setReadersLoading(true);
      setReaders([]);
      try {
        const res = await app.apiClient.request({
          url: 'online_users:broadcast_reads',
          method: 'get',
          params: { broadcastId: b.id },
        });
        const data = (unwrapPayload(res) ?? { readers: [] }) as { readers?: ReaderItem[] };
        setReaders(Array.isArray(data.readers) ? data.readers : []);
      } catch (error: unknown) {
        message.error((error as { message?: string })?.message || t('Failed to load readers'));
      } finally {
        setReadersLoading(false);
      }
    },
    [app, t],
  );

  const columns = [
    {
      title: t('Content'),
      dataIndex: 'content',
      key: 'content',
      ellipsis: true,
      render: (text: string) => <Text>{text}</Text>,
    },
    {
      title: t('Message Level'),
      dataIndex: 'msgType',
      key: 'msgType',
      width: 100,
      render: (msgType: string) => <Tag color={MSG_TYPE_COLOR[msgType] || 'blue'}>{msgTypeLabel(msgType, t)}</Tag>,
    },
    {
      title: t('Sender'),
      dataIndex: 'sender',
      key: 'sender',
      width: 120,
    },
    {
      title: t('Created At'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (ts: string) => formatTime(ts ? new Date(ts).getTime() : 0),
    },
    {
      title: t('Expires At'),
      dataIndex: 'expiresAt',
      key: 'expiresAt',
      width: 180,
      render: (ts: string | null) => (ts ? formatTime(new Date(ts).getTime()) : t('Never')),
    },
    {
      title: t('Read Count'),
      key: 'readCount',
      width: 140,
      render: (_: unknown, record: BroadcastItem) => (
        <Text>
          {record.readCount} / {record.totalUsers}
        </Text>
      ),
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 180,
      render: (_: unknown, record: BroadcastItem) => (
        <Space>
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => openReadDrawer(record)}>
            {t('View Readers')}
          </Button>
          <Popconfirm
            title={t('Confirm Delete')}
            description={t('Are you sure you want to delete this broadcast?')}
            okText={t('Delete')}
            okButtonProps={{ danger: true }}
            cancelText={t('Cancel')}
            onConfirm={() => handleDeleteBroadcasts([record.id])}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              {t('Delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const readerColumns = [
    {
      title: t('User'),
      dataIndex: 'nickname',
      key: 'nickname',
      render: (text: string, record: ReaderItem) => (
        <Space>
          {text || `User ${record.userId}`}
          <Text type="secondary">#{record.userId}</Text>
        </Space>
      ),
    },
    {
      title: t('Read At'),
      dataIndex: 'readAt',
      key: 'readAt',
      render: (ts: string) => formatTime(ts ? new Date(ts).getTime() : 0),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>
          <NotificationOutlined style={{ marginRight: 8 }} />
          {t('Broadcast Management')}
        </Title>
        <Space>
          <Popconfirm
            title={t('Confirm Delete')}
            description={t('Are you sure you want to delete the selected broadcasts?', {
              count: selectedRowKeys.length,
            })}
            okText={t('Delete')}
            okButtonProps={{ danger: true }}
            cancelText={t('Cancel')}
            onConfirm={handleBatchDelete}
            disabled={!selectedRowKeys.length}
          >
            <Button danger icon={<DeleteOutlined />} disabled={!selectedRowKeys.length} loading={deleteLoading}>
              {t('Delete Selected')}
              {selectedRowKeys.length ? ` (${selectedRowKeys.length})` : ''}
            </Button>
          </Popconfirm>
          <Button type="primary" icon={<SendOutlined />} onClick={handleOpenSendModal}>
            {t('Send Broadcast')}
          </Button>
        </Space>
      </div>
      <Table
        dataSource={broadcasts}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={false}
        size="middle"
        rowSelection={{
          selectedRowKeys,
          onChange: (keys: React.Key[]) => setSelectedRowKeys(keys),
        }}
        locale={{ emptyText: t('No broadcasts yet, click "Send Broadcast" above') }}
      />

      <Drawer
        title={t('Readers of Broadcast')}
        width={520}
        open={readDrawerOpen}
        onClose={() => setReadDrawerOpen(false)}
      >
        {currentBroadcast && (
          <div style={{ marginBottom: 16 }}>
            <Text strong>{t('Content')}：</Text>
            <div style={{ margin: '8px 0', padding: 12, background: '#f5f5f5', borderRadius: 4 }}>
              {currentBroadcast.content}
            </div>
            <Text type="secondary">
              {t('Read Count')}：{currentBroadcast.readCount} / {currentBroadcast.totalUsers}
            </Text>
          </div>
        )}
        <Table
          dataSource={readers}
          columns={readerColumns}
          rowKey="userId"
          loading={readersLoading}
          pagination={{ pageSize: 10 }}
          size="small"
          locale={{ emptyText: t('No one has read yet') }}
        />
      </Drawer>

      {/* 发布广播 Modal */}
      <Modal
        title={t('Publish Global Broadcast')}
        open={sendModalOpen}
        onCancel={handleCloseSendModal}
        destroyOnClose
        footer={[
          <Button key="cancel" onClick={handleCloseSendModal}>
            {t('Cancel')}
          </Button>,
          <Button key="send" type="primary" loading={sendLoading} onClick={handleSendBroadcast}>
            {t('Send')}
          </Button>,
        ]}
      >
        <div style={{ marginBottom: 16 }}>
          <Text style={{ display: 'block', marginBottom: 8 }}>{t('Message Level')}</Text>
          <Radio.Group
            value={sendMsgType}
            onChange={(e) => setSendMsgType(e.target.value as 'info' | 'warning' | 'error')}
          >
            <Radio.Button value="info">{t('Info')}</Radio.Button>
            <Radio.Button value="warning">{t('Warning')}</Radio.Button>
            <Radio.Button value="error">{t('Error')}</Radio.Button>
          </Radio.Group>
        </div>
        <Input.TextArea
          value={sendContent}
          onChange={(e) => setSendContent(e.target.value)}
          placeholder={t('Enter broadcast content')}
          rows={4}
          maxLength={500}
        />
        {/* 字数显示单独放在 TextArea 下方，避免 antd showCount 与 Modal footer 按钮重叠 */}
        <div style={{ textAlign: 'right', color: 'rgba(0,0,0,0.45)', fontSize: 12, marginTop: 4 }}>
          {sendContent.length}/500
        </div>
      </Modal>
    </div>
  );
}
