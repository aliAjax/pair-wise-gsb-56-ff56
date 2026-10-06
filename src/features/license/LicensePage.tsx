import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Descriptions,
  InputNumber,
  Progress,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  message,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { SafetyCertificateOutlined } from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import {
  useDeductQuotaMutation,
  useGetWorkspaceQuery,
  useValidatePackageMutation,
} from '@/app/api'
import type { LicenseRule, QuotaDeduction } from '@/types/domain'
import { approvalLevelLabels, findApplicableRule } from '@/services/rules'
import { copyStatusLabels } from '@/services/copies'

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error && 'data' in error) {
    return (error.data as { error?: string }).error ?? '额度扣减失败'
  }
  return '额度扣减失败'
}

export function LicensePage() {
  const [searchParams] = useSearchParams()
  const { data, isLoading, refetch } = useGetWorkspaceQuery()
  const [validatePackage] = useValidatePackageMutation()
  const [deductQuota, deductState] = useDeductQuotaMutation()
  const [selectedId, setSelectedId] = useState(searchParams.get('package') ?? '')
  const [amount, setAmount] = useState(5)
  const [simulateFailure, setSimulateFailure] = useState(true)
  // 一次核销尝试的令牌与目标副本：失败后重试沿用同一令牌和同一副本，绝不二次扣额度。
  const [pendingAttempt, setPendingAttempt] = useState<{ requestId: string; copyId: string }>()

  useEffect(() => {
    if (!selectedId && data?.packages[0]) setSelectedId(data.packages[0].id)
  }, [data, selectedId])

  const selected = useMemo(
    () => data?.packages.find((item) => item.id === selectedId),
    [data, selectedId],
  )
  const applicableRule = selected && data ? findApplicableRule(selected, data.rules) : undefined
  const currentRule = data?.rules.find((item) => item.id === selected?.matchedRuleId)
  const packageFindings = data?.findings.filter((item) => item.packageId === selectedId) ?? []
  const hasHighFindings = packageFindings.some((item) => item.level === 'high')

  const packageCopies = useMemo(
    () =>
      selected
        ? data?.controlledCopies
            .filter((copy) => copy.packageId === selected.id)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) ?? []
        : [],
    [data, selected],
  )
  const sealedCopy = packageCopies.find((copy) => copy.status === 'sealed')
  const deductions = sealedCopy?.deductions ?? []
  const reservedByCopy = deductions
    .filter((item) => item.status === 'reserved')
    .reduce((total, item) => total + item.amount, 0)

  const remaining = selected ? selected.quotaLimit - selected.quotaUsed - selected.quotaReserved : 0

  useEffect(() => {
    // 切换资料包后清空上一笔失败尝试。
    setPendingAttempt(undefined)
  }, [selectedId])

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
    {
      title: '规则额度',
      dataIndex: 'quotaLimit',
      width: 100,
    },
  ]

  const deductionColumns: TableColumnsType<QuotaDeduction> = [
    {
      title: '请求令牌',
      dataIndex: 'requestId',
      width: 180,
      render: (value: string) => <Tag>{value.slice(-12)}</Tag>,
    },
    { title: '金额', dataIndex: 'amount', width: 90 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: QuotaDeduction['status']) => (
        <Tag color={value === 'settled' ? 'green' : 'orange'}>
          {value === 'settled' ? '已落账' : '预占待落账'}
        </Tag>
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 180,
      render: (value: string) => new Date(value).toLocaleString('zh-CN'),
    },
    {
      title: '落账时间',
      dataIndex: 'settledAt',
      width: 180,
      render: (value?: string) => (value ? new Date(value).toLocaleString('zh-CN') : '—'),
    },
    { title: '说明', dataIndex: 'note' },
  ]

  async function refreshValidation() {
    if (!selected) return
    await validatePackage({ packageId: selected.id }).unwrap()
    message.success('规则匹配和缺失声明已重新校验')
  }

  async function deductOrRetry() {
    if (!selected || !sealedCopy || !data) return
    // 重试沿用同一 requestId 与同一受控副本；新核销才生成新令牌。
    const attempt = pendingAttempt ?? {
      requestId: `deduct-${crypto.randomUUID()}`,
      copyId: sealedCopy.id,
    }
    const expectedRevision = data.revision
    const wasRetry = Boolean(pendingAttempt)
    try {
      const result = await deductQuota({
        packageId: selected.id,
        copyId: attempt.copyId,
        amount,
        requestId: attempt.requestId,
        expectedRevision,
        simulateFailure,
      })
      const replayed = (result as { meta?: { replayed?: boolean } }).meta?.replayed === true
      message.success(
        replayed
          ? '重复核销请求被幂等拦截，未重复扣额度'
          : wasRetry
            ? '原副本预占已落账，重试成功且未二次扣额度'
            : `已按受控副本核销 ${amount} 个许可额度`,
      )
      setPendingAttempt(undefined)
      setSimulateFailure(false)
    } catch (error) {
      const detail = errorMessage(error)
      // 网关类失败：额度保持预占，按原副本重试；先刷新到最新版本号再重试。
      setPendingAttempt(attempt)
      await refetch()
      message.error(detail)
    }
  }

  return (
    <div>
      <PageHeader
        title="许可与额度"
        description="核销对象必须是已落章的受控副本；核销失败按原副本重试不二次扣额，重复回放不重复落账。"
        actions={
          selected ? (
            <Button loading={deductState.isLoading} onClick={refreshValidation}>
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
              <Descriptions.Item label="收件方">{selected.recipient}</Descriptions.Item>
              <Descriptions.Item label="最终用途">{selected.endUse}</Descriptions.Item>
              <Descriptions.Item label="审批状态">
                {selected.status === 'approved'
                  ? '已批准，待核销'
                  : selected.status === 'licensed'
                    ? '已核销'
                    : '尚未完成审批'}
              </Descriptions.Item>
              <Descriptions.Item label="当前额度">
                已扣 {selected.quotaUsed} · 预占 {selected.quotaReserved} · 上限{' '}
                {selected.quotaLimit}
              </Descriptions.Item>
            </Descriptions>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>核销依据：受控副本</h3>
            {sealedCopy ? (
              <Tag color="blue">{copyStatusLabels.sealed}</Tag>
            ) : (
              <Tag color="error">无已落章副本</Tag>
            )}
          </div>
          {sealedCopy ? (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Alert
                type="info"
                showIcon
                message={`副本 ${sealedCopy.id.slice(-6)} · 第 ${sealedCopy.round} 轮`}
                description={`落章人 ${sealedCopy.sealedBy ?? '—'}；钉住声明 ${sealedCopy.declarations.length} 项、${sealedCopy.files.length} 个文件现行页。核销只认该副本，不随原件后续修改变化。`}
              />
              <Descriptions column={1} bordered size="small">
                <Descriptions.Item label="发起时额度快照">
                  已用 {sealedCopy.quotaSnapshot.used} · 预占 {sealedCopy.quotaSnapshot.reserved} ·
                  上限 {sealedCopy.quotaSnapshot.limit}
                </Descriptions.Item>
                <Descriptions.Item label="副本预占待落账">{reservedByCopy}</Descriptions.Item>
                <Descriptions.Item label="钉住声明">
                  {sealedCopy.declarations.join('、') || '无'}
                </Descriptions.Item>
              </Descriptions>
            </Space>
          ) : (
            <Alert
              type="error"
              showIcon
              message="没有已落章的受控副本，不能核销。"
              description="审批全部通过并对仍有效的副本落章后，才会在这里出现可核销对象。"
            />
          )}
        </section>
      </div>

      <div className="two-column">
        <section className="panel">
          <div className="panel-title">
            <h3>缺失声明与升级要求</h3>
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
            {currentRule && applicableRule && currentRule.id !== applicableRule.id ? (
              <Alert
                type="warning"
                showIcon
                message="落章后匹配规则发生变化：核销仍按落章副本对应的规则与额度快照执行。"
              />
            ) : null}
          </Space>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>许可额度核销</h3>
            <SafetyCertificateOutlined />
          </div>
          {selected ? (
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <Progress
                percent={Math.round(
                  ((selected.quotaUsed + selected.quotaReserved) / selected.quotaLimit) * 100,
                )}
                status={
                  selected.quotaUsed + selected.quotaReserved >= selected.quotaLimit
                    ? 'exception'
                    : 'active'
                }
              />
              <div>
                已扣 {selected.quotaUsed}，预占 {selected.quotaReserved}，可用 {remaining}，上限{' '}
                {selected.quotaLimit}
              </div>
              <InputNumber
                min={1}
                max={Math.max(1, remaining + (pendingAttempt ? amount : 0))}
                value={amount}
                disabled={Boolean(pendingAttempt)}
                onChange={(value) => setAmount(value ?? 1)}
                addonAfter="额度单位"
                style={{ width: '100%' }}
              />
              <Space>
                <Switch checked={simulateFailure} onChange={setSimulateFailure} />
                <span>模拟核销网关失败（额度预占但不落账，用于演示按原副本重试）</span>
              </Space>
              {pendingAttempt ? (
                <Alert
                  type="warning"
                  showIcon
                  message={`上一笔核销 ${amount} 失败，额度已预占未扣减。`}
                  description={`将按原副本 ${pendingAttempt.copyId.slice(-6)} 与原令牌 ${pendingAttempt.requestId.slice(-8)} 重试，只推动该笔预占落账，不会再次扣额度。`}
                />
              ) : null}
              <Button
                type="primary"
                block
                disabled={
                  !sealedCopy ||
                  (!pendingAttempt &&
                    (hasHighFindings ||
                      selected.status === 'licensed' ||
                      amount > remaining ||
                      remaining <= 0))
                }
                loading={deductState.isLoading}
                onClick={deductOrRetry}
              >
                {pendingAttempt ? '按原副本重试核销（不二次扣额度）' : '确认核销并完成许可'}
              </Button>
              {!sealedCopy ? (
                <Alert type="warning" showIcon message="只有已落章的受控副本才允许核销。" />
              ) : null}
              {hasHighFindings ? (
                <Alert type="error" showIcon message="存在高风险核对项，系统拒绝核销。" />
              ) : null}
            </Space>
          ) : null}
        </section>
      </div>

      {sealedCopy ? (
        <section className="panel">
          <div className="panel-title">
            <h3>副本核销账本</h3>
            <span className="muted">同一令牌重复回放只返回原结果；失败重试推动原预占落账</span>
          </div>
          <Table
            rowKey="requestId"
            columns={deductionColumns}
            dataSource={deductions}
            pagination={false}
          />
        </section>
      ) : null}

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
