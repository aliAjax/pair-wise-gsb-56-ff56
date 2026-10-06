import { Alert, Descriptions, Space, Table, Tag } from 'antd'
import type { TableColumnsType } from 'antd'
import type { ControlledCopy, ControlledFileSnapshot } from '@/types/domain'
import { controlledCopyStatusLabels } from '@/services/controlledCopy'

const statusColor: Record<ControlledCopy['status'], string> = {
  active: 'processing',
  invalid: 'warning',
  returned: 'error',
  signed: 'success',
  writeoff_failed: 'warning',
  licensed: 'green',
}

interface ControlledCopyPanelProps {
  copy?: ControlledCopy
}

export function ControlledCopyPanel({ copy }: ControlledCopyPanelProps) {
  if (!copy) {
    return <Alert type="info" showIcon message="尚未收拢受控副本，提交审批时才生成不可变签署对象。" />
  }

  const columns: TableColumnsType<ControlledFileSnapshot> = [
    { title: '文件', dataIndex: 'name' },
    {
      title: '固定版本',
      width: 150,
      render: (_, record) => `${record.label} · ${record.hash.slice(0, 8)}`,
    },
    {
      title: '页面',
      width: 100,
      render: (_, record) => {
        const controlled = record.pages.filter((page) => page.controlled).length
        const desensitized = record.pages.filter(
          (page) => page.controlled && page.desensitized,
        ).length
        return `${controlled}/${desensitized} 受控/脱敏`
      },
    },
  ]

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Alert
        showIcon
        type={
          copy.status === 'invalid' || copy.status === 'writeoff_failed'
            ? 'warning'
            : copy.status === 'returned'
              ? 'error'
              : 'success'
        }
        message={
          <Space wrap>
            <strong>受控副本 {copy.id.slice(0, 18)}</strong>
            <Tag color={statusColor[copy.status]}>{controlledCopyStatusLabels[copy.status]}</Tag>
            <span className="muted">第 {copy.round} 轮 · 签署 {copy.signatures.length} 次</span>
          </Space>
        }
        description={copy.invalidationReason ?? copy.writeoff?.failureReason}
      />
      <Descriptions column={2} bordered size="small">
        <Descriptions.Item label="许可占用量">
          发起时已占用 {copy.quota.used}，副本可用 {copy.quota.available}，上限 {copy.quota.limit}
        </Descriptions.Item>
        <Descriptions.Item label="核销状态">
          {copy.writeoff
            ? `${copy.writeoff.status === 'completed' ? '已完成' : copy.writeoff.status === 'failed' ? '外部失败，额度已预占' : '额度已预占'} · ${copy.writeoff.amount}`
            : '未核销'}
        </Descriptions.Item>
        <Descriptions.Item label="声明" span={2}>
          {copy.declarations.map((declaration) => (
            <Tag key={declaration} color="blue">
              {declaration}
            </Tag>
          ))}
        </Descriptions.Item>
      </Descriptions>
      <Table
        rowKey="fileId"
        size="small"
        columns={columns}
        dataSource={copy.files}
        pagination={false}
      />
    </Space>
  )
}
