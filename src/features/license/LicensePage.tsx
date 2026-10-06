import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  InputNumber,
  Progress,
  Select,
  Space,
  Table,
  Tag,
  message,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { SafetyCertificateOutlined } from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { ControlledCopyPanel } from '@/components/ControlledCopyPanel'
import {
  useGetWorkspaceQuery,
  useValidatePackageMutation,
  useWriteoffLicenseMutation,
} from '@/app/api'
import type { LicenseRule } from '@/types/domain'
import { approvalLevelLabels } from '@/services/rules'

export function LicensePage() {
  const [searchParams] = useSearchParams()
  const { data, isLoading, refetch } = useGetWorkspaceQuery()
  const [validatePackage] = useValidatePackageMutation()
  const [writeoffLicense, writeoffState] = useWriteoffLicenseMutation()
  const [selectedId, setSelectedId] = useState(searchParams.get('package') ?? '')
  const [amount, setAmount] = useState(5)
  const [simulateFailure, setSimulateFailure] = useState(false)
  const [writeoffRequestId, setWriteoffRequestId] = useState('')

  useEffect(() => {
    if (!selectedId && data?.packages[0]) setSelectedId(data.packages[0].id)
  }, [data, selectedId])

  const selected = useMemo(
    () => data?.packages.find((item) => item.id === selectedId),
    [data, selectedId],
  )
  const targetCopy = useMemo(
    () =>
      data?.controlledCopies
        .filter(
          (copy) =>
            copy.packageId === selectedId &&
            ['signed', 'writeoff_failed', 'licensed'].includes(copy.status),
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0],
    [data, selectedId],
  )

  useEffect(() => {
    if (targetCopy?.writeoff) {
      setAmount(targetCopy.writeoff.amount)
      setWriteoffRequestId(targetCopy.writeoff.requestId)
      setSimulateFailure(false)
    } else {
      setAmount(5)
      setWriteoffRequestId(`writeoff-${crypto.randomUUID()}`)
      setSimulateFailure(false)
    }
  }, [selectedId, targetCopy?.id, targetCopy?.writeoff?.requestId, targetCopy?.writeoff?.amount])

  const snapshotRule = data?.rules.find((item) => item.id === targetCopy?.ruleId)
  const currentRule = data?.rules.find((item) => item.id === selected?.matchedRuleId)
  const applicableRule = snapshotRule ?? currentRule
  const packageFindings = data?.findings.filter((item) => item.packageId === selectedId) ?? []
  const hasHighFindings = packageFindings.some((item) => item.level === 'high')
  const remaining = selected ? selected.quotaLimit - selected.quotaUsed : 0
  const retryMode = targetCopy?.status === 'writeoff_failed'

  if (isLoading || !data) return <div className="panel">正在加载许可规则...</div>

  const ruleColumns: TableColumnsType<LicenseRule> = [
    { title: '规则名称', dataIndex: 'name', minWidth: 240 },
    {
      title: '国家或地区',
      dataIndex: 'destinations',
      width: 135,
      render: (values: string[]) => values.join('、'),
    },
    {
      title: '技术标签',
      dataIndex: 'technologyTags',
      width: 220,
      render: (values: string[]) => values.join('、') || '通用',
    },
    {
      title: '审批等级',
      dataIndex: 'approvalLevel',
      width: 110,
      render: (value: LicenseRule['approvalLevel']) => approvalLevelLabels[value],
    },
    { title: '规则额度', dataIndex: 'quotaLimit', width: 100 },
  ]

  async function refreshValidation() {
    if (!selected) return
    await validatePackage({ packageId: selected.id }).unwrap()
    message.success('规则匹配和缺失声明已重新校验')
  }

  async function writeoff() {
    if (!selected || !targetCopy) return
    const requestId = targetCopy.writeoff?.requestId ?? writeoffRequestId
    try {
      await writeoffLicense({
        packageId: selected.id,
        copyId: targetCopy.id,
        amount,
        requestId,
        simulateFailure,
      }).unwrap()
      message.success(retryMode ? '原副本核销重试成功，未再次扣减额度' : '许可核销完成')
    } catch (error) {
      const detail =
        typeof error === 'object' && error && 'data' in error
          ? (error.data as { error?: string }).error
          : undefined
      message.error(detail ?? '许可核销失败')
      refetch()
    }
  }

  const declarationSource = targetCopy?.declarations ?? selected?.declarations ?? []
  const writeoffDisabled =
    !targetCopy ||
    !['signed', 'writeoff_failed'].includes(targetCopy.status) ||
    (!retryMode && (amount <= 0 || amount > Math.max(remaining, 0)))

  return (
    <div>
      <PageHeader
        title="许可与额度"
        description="许可核销只引用审批发起时收拢的受控副本；失败后按原副本和原额度请求重试。"
        actions={
          selected ? (
            <Button loading={writeoffState.isLoading} onClick={refreshValidation}>
              重新校验
            </Button>
          ) : null
        }
      />

      <div className="two-column">
        <section className="panel">
          <div className="panel-title">
            <h3>选择资料包</h3>
            <Tag>{data.rules.length} 条规则</Tag>
          </div>
          <Select
            value={selectedId || undefined}
            style={{ width: '100%' }}
            onChange={setSelectedId}
            options={data.packages.map((item) => ({
              value: item.id,
              label: `${item.code} · ${item.title} · ${item.destination}`,
            }))}
          />
          {selected ? (
            <Descriptions column={1} bordered size="small" style={{ marginTop: 16 }}>
              <Descriptions.Item label="收件方">
                {targetCopy?.packageSnapshot.recipient ?? selected.recipient}
              </Descriptions.Item>
              <Descriptions.Item label="最终用途">
                {targetCopy?.packageSnapshot.endUse ?? selected.endUse}
              </Descriptions.Item>
              <Descriptions.Item label="技术参数">
                {(targetCopy?.packageSnapshot.technologyTags ?? selected.technologyTags).join('、')}
              </Descriptions.Item>
              <Descriptions.Item label="人员范围">
                {(targetCopy?.packageSnapshot.personnelScopes ?? selected.personnelScopes).join('、') ||
                  '无特别范围'}
              </Descriptions.Item>
              <Descriptions.Item label="审批状态">
                {selected.status === 'approved'
                  ? '已批准，可按受控副本核销'
                  : selected.status === 'licensed'
                    ? '已完成核销'
                    : '尚未完成签署'}
              </Descriptions.Item>
            </Descriptions>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>签署副本规则匹配</h3>
            <Tag color={applicableRule ? 'success' : 'error'}>
              {applicableRule ? '存在适用规则' : '无适用规则'}
            </Tag>
          </div>
          {applicableRule ? (
            <Space direction="vertical" size={14} style={{ width: '100%' }}>
              <Alert
                type="info"
                showIcon
                message={applicableRule.name}
                description={applicableRule.explanation}
              />
              <div>
                <strong>必要声明核对（以副本为准）</strong>
                <div style={{ marginTop: 8 }}>
                  {applicableRule.requiredDeclarations.map((declaration) => (
                    <Tag
                      key={declaration}
                      color={declarationSource.includes(declaration) ? 'success' : 'error'}
                    >
                      {declaration}
                    </Tag>
                  ))}
                </div>
              </div>
              <div>
                <strong>审批升级</strong>
                <div className="muted" style={{ marginTop: 5 }}>
                  签署副本规则：{snapshotRule?.name ?? '尚未生成签署副本'}；当前主系统规则：
                  {currentRule?.name ?? '未匹配'}。
                </div>
              </div>
            </Space>
          ) : (
            <Alert type="error" showIcon message="没有匹配到规则，必须执行人工判定。" />
          )}
        </section>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h3>签署受控副本</h3>
          <span className="muted">核销对象、声明、页结论和额度占用均不可随原件漂移</span>
        </div>
        {targetCopy ? <ControlledCopyPanel copy={targetCopy} /> : (
          <Alert type="warning" showIcon message="当前资料包尚未完成签署，不能进行许可核销。" />
        )}
      </section>

      <div className="two-column">
        <section className="panel">
          <div className="panel-title">
            <h3>当前核对项</h3>
            <Tag color={hasHighFindings ? 'error' : 'success'}>{packageFindings.length} 项</Tag>
          </div>
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            {packageFindings.map((finding) => (
              <Alert
                key={finding.id}
                type={finding.level === 'high' ? 'error' : finding.level === 'medium' ? 'warning' : 'info'}
                showIcon
                message={finding.message}
                description={finding.action}
              />
            ))}
            {!packageFindings.length ? (
              <Alert type="success" showIcon message="当前资料包没有许可核对缺口。" />
            ) : null}
            {targetCopy?.status === 'signed' && hasHighFindings ? (
              <Alert
                type="info"
                showIcon
                message="签署后的新核对项不会改变已签署副本；需要退回补正时应重新发起审批。"
              />
            ) : null}
          </Space>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>许可核销</h3>
            <SafetyCertificateOutlined />
          </div>
          {selected && targetCopy ? (
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <Progress
                percent={Math.min(100, Math.round((selected.quotaUsed / selected.quotaLimit) * 100))}
                status={selected.quotaUsed >= selected.quotaLimit ? 'exception' : 'active'}
              />
              <div>
                当前已使用 {selected.quotaUsed}，剩余 {remaining}；副本发起时占用 {targetCopy.quota.used}
                ，固定可用 {targetCopy.quota.available}，上限 {targetCopy.quota.limit}。
              </div>
              <InputNumber
                min={1}
                max={retryMode ? targetCopy.writeoff?.amount : Math.max(1, remaining)}
                value={amount}
                disabled={retryMode}
                onChange={(value) => setAmount(value ?? 1)}
                addonAfter="额度单位"
                style={{ width: '100%' }}
              />
              <Checkbox
                checked={simulateFailure}
                disabled={retryMode}
                onChange={(event) => setSimulateFailure(event.target.checked)}
              >
                演示：首次外部核销确认失败（额度先预占）
              </Checkbox>
              <Button
                type="primary"
                block
                disabled={writeoffDisabled}
                loading={writeoffState.isLoading}
                onClick={writeoff}
              >
                {retryMode ? `按原副本重试核销 ${amount}` : `确认核销 ${amount} 并预占额度`}
              </Button>
              {retryMode ? (
                <Alert
                  type="warning"
                  showIcon
                  message="上次外部核销失败，额度已在首次请求中预占。"
                  description="重试继续使用同一受控副本、金额和幂等编号，不会再次扣减额度。"
                />
              ) : targetCopy.status === 'licensed' ? (
                <Alert type="success" showIcon message="该受控副本已完成核销，重复回放只返回既有结果。" />
              ) : (
                <Alert type="info" showIcon message="只有全部签署完成的受控副本才允许核销。" />
              )}
              <div className="muted mono" style={{ fontSize: 12 }}>
                幂等编号：{(targetCopy.writeoff?.requestId ?? writeoffRequestId).slice(0, 28)}…
              </div>
            </Space>
          ) : (
            <Alert type="warning" showIcon message="请先完成审批签署并生成受控副本。" />
          )}
        </section>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h3>规则清单</h3>
          <span className="muted">规则用于解释匹配结果，不允许在审批页面直接修改</span>
        </div>
        <Table rowKey="id" columns={ruleColumns} dataSource={data.rules} pagination={false} />
      </section>
    </div>
  )
}
