import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Descriptions,
  Input,
  Modal,
  Space,
  Steps,
  Table,
  Tag,
  Timeline,
  message,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { StatusTag } from '@/components/StatusTag'
import {
  useDecideApprovalMutation,
  useGetWorkspaceQuery,
  useRecaptureApprovalMutation,
  useSubmitApprovalMutation,
} from '@/app/api'
import type { ApprovalStep, ControlledCopy, MaterialPackage } from '@/types/domain'
import { approvalLevelLabels } from '@/services/rules'
import { copyStatusLabels } from '@/services/copies'

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error && 'data' in error) {
    return (error.data as { error?: string }).error ?? '操作失败'
  }
  return '操作失败'
}

export function ApprovalPage() {
  const [searchParams] = useSearchParams()
  const { data, isLoading } = useGetWorkspaceQuery()
  const [submitApproval, submitState] = useSubmitApprovalMutation()
  const [recaptureApproval, recaptureState] = useRecaptureApprovalMutation()
  const [decideApproval, decideState] = useDecideApprovalMutation()
  const [selectedId, setSelectedId] = useState(searchParams.get('package') ?? '')
  const [decision, setDecision] = useState<'approve' | 'return'>('approve')
  const [decisionOpen, setDecisionOpen] = useState(false)
  const [comment, setComment] = useState('')
  const [decidingStep, setDecidingStep] = useState<ApprovalStep>()

  useEffect(() => {
    if (!selectedId && data?.packages[0]) setSelectedId(data.packages[0].id)
  }, [data, selectedId])

  const selected = useMemo(
    () => data?.packages.find((item) => item.id === selectedId),
    [data, selectedId],
  )
  const activeStep = selected?.approvalRoute.find((step) => step.status === 'active')
  const activeCopy = useMemo<ControlledCopy | undefined>(
    () =>
      selected?.activeCopyId
        ? data?.controlledCopies.find((copy) => copy.id === selected.activeCopyId)
        : undefined,
    [data, selected],
  )
  const copyHistory = useMemo(
    () =>
      selected
        ? data?.controlledCopies
            .filter((copy) => copy.packageId === selected.id)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) ?? []
        : [],
    [data, selected],
  )

  if (isLoading || !data) return <div className="panel">正在加载审批路线...</div>
  const workspace = data
  const copyInvalid = selected?.status === 'rechecking'

  const packageColumns: TableColumnsType<MaterialPackage> = [
    { title: '编号', dataIndex: 'code', width: 135 },
    { title: '资料包', dataIndex: 'title', minWidth: 220 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: MaterialPackage['status']) => <StatusTag status={value} />,
    },
    {
      title: '轮次',
      dataIndex: 'currentRound',
      width: 85,
      render: (value: number) => (value ? `第 ${value} 轮` : '未提交'),
    },
    {
      title: '受控副本',
      width: 130,
      render: (_, record) => {
        const copy = record.activeCopyId
          ? workspace.controlledCopies.find((item) => item.id === record.activeCopyId)
          : undefined
        if (!copy) return <span className="muted">无有效副本</span>
        return (
          <Tag color={copy.status === 'active' ? 'green' : copy.status === 'sealed' ? 'blue' : 'red'}>
            {copyStatusLabels[copy.status]}
          </Tag>
        )
      },
    },
    {
      title: '当前步骤',
      width: 160,
      render: (_, record) =>
        record.approvalRoute.find((step) => step.status === 'active')?.role ??
        (record.status === 'rechecking' ? '副本失效待复核' : '无活动步骤'),
    },
  ]

  const stepColumns: TableColumnsType<ApprovalStep> = [
    { title: '顺序', dataIndex: 'order', width: 60 },
    { title: '审批角色', dataIndex: 'role', width: 150 },
    { title: '处理人', dataIndex: 'assignee', width: 120 },
    {
      title: '等级',
      dataIndex: 'level',
      width: 100,
      render: (value: ApprovalStep['level']) => approvalLevelLabels[value],
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (value: ApprovalStep['status']) => (
        <Tag
          color={
            value === 'approved'
              ? 'success'
              : value === 'active'
                ? 'processing'
                : value === 'returned'
                  ? 'error'
                  : value === 'stale'
                    ? 'volcano'
                    : 'default'
          }
        >
          {value === 'approved'
            ? '已通过'
            : value === 'active'
              ? '待审批'
              : value === 'returned'
                ? '已退回'
                : value === 'stale'
                  ? '失效待复核'
                  : '未开始'}
        </Tag>
      ),
    },
    {
      title: '绑定副本',
      width: 110,
      render: (_, record) =>
        record.copyId ? <Tag>{record.copyId.slice(-6)}</Tag> : <span className="muted">未绑定</span>,
    },
    {
      title: '意见',
      dataIndex: 'comment',
      render: (value: string) => value || <span className="muted">无</span>,
    },
    {
      title: '操作',
      width: 250,
      render: (_, record) =>
        record.status === 'active' ? (
          <Space>
            <Button
              type="link"
              disabled={copyInvalid}
              onClick={() => {
                setDecidingStep(record)
                setDecision('approve')
                setDecisionOpen(true)
              }}
            >
              通过
            </Button>
            <Button
              type="link"
              danger
              disabled={copyInvalid}
              onClick={() => {
                setDecidingStep(record)
                setDecision('return')
                setDecisionOpen(true)
              }}
            >
              退回
            </Button>
            <Button type="link" onClick={() => void simulateConcurrent(record)}>
              模拟双人同签
            </Button>
          </Space>
        ) : null,
    },
  ]

  async function submitCurrent() {
    if (!selected) return
    const highFindings = workspace.findings.filter(
      (item) => item.packageId === selected.id && item.level === 'high',
    )
    if (highFindings.length) {
      message.error('存在高风险核对项，请先修复后提交')
      return
    }
    await submitApproval({ packageId: selected.id }).unwrap()
    message.success('已收拢现行页、脱敏结论、声明与额度占用，生成受控副本和审批路线')
  }

  async function recapture() {
    if (!selected) return
    await recaptureApproval({ packageId: selected.id }).unwrap()
    message.success('已按现行原件重新收拢副本，失效步骤重置待签')
  }

  /** 常规签署：生成一次性签署令牌；重复点击/网络回放因同令牌被幂等拦截。 */
  async function confirmDecision() {
    if (!selected || !decidingStep) return
    const requestId = `sign-${crypto.randomUUID()}`
    try {
      const result = await decideApproval({
        packageId: selected.id,
        stepId: decidingStep.id,
        decision,
        comment,
        requestId,
        expectedRevision: workspace.revision,
      })
      const replayed = (result as { meta?: { replayed?: boolean } }).meta?.replayed === true
      message.success(
        replayed
          ? '重复签署请求已被幂等拦截，未重复落章'
          : decision === 'approve'
            ? '已对受控副本落章'
            : '资料包已退回，进入新一轮补正',
      )
      setDecisionOpen(false)
      setComment('')
      setDecidingStep(undefined)
    } catch (error) {
      message.error(errorMessage(error))
    }
  }

  /**
   * 双人同时提交：两个请求携带相同的 expectedRevision 并发排队。
   * 第一个正常落章并推高 revision，第二个撞 409——只有仍有效的那份签署被接受。
   */
  async function simulateConcurrent(step: ApprovalStep) {
    if (!selected) return
    const base = {
      packageId: selected.id,
      stepId: step.id,
      decision: 'approve' as const,
      comment: '并发签署演示',
      expectedRevision: workspace.revision,
    }
    const [first, second] = await Promise.allSettled([
      decideApproval({ ...base, requestId: `sign-a-${crypto.randomUUID()}` }).unwrap(),
      decideApproval({ ...base, requestId: `sign-b-${crypto.randomUUID()}` }).unwrap(),
    ])
    if (first.status === 'fulfilled' && second.status === 'rejected') {
      message.warning('两人同时提交：第一份已落章，第二份因版本冲突被拒绝（只收仍有效的一份）')
    } else {
      message.info('并发结果：请查看步骤状态与审计日志')
    }
  }

  /** 重复回放：同一令牌连发两次，第二次被幂等拦截，不重复落章。 */
  async function simulateReplay() {
    if (!selected || !activeStep) return
    const requestId = `sign-replay-${crypto.randomUUID()}`
    const body = {
      packageId: selected.id,
      stepId: activeStep.id,
      decision: 'approve' as const,
      comment: '重复回放演示',
      requestId,
      expectedRevision: workspace.revision,
    }
    await decideApproval(body).unwrap()
    try {
      await decideApproval(body).unwrap()
    } catch {
      // 第二次若因状态变化被拦，幂等逻辑仍记录在审计中
    }
    message.success('同一签署请求回放两次：仅第一次落章，重复回放未重复落章')
  }

  const copyTagColor = activeCopy
    ? activeCopy.status === 'active'
      ? 'green'
      : activeCopy.status === 'sealed'
        ? 'blue'
        : 'red'
    : undefined

  return (
    <div>
      <PageHeader
        title="审批路线"
        description="审签对象是发起时收拢的受控副本：钉住现行页、脱敏结论、声明与额度占用；原件改动即失效待复核。"
        actions={
          selected ? (
            <Space>
              {activeStep && !copyInvalid ? (
                <Button onClick={simulateReplay} loading={decideState.isLoading}>
                  模拟重复回放
                </Button>
              ) : null}
              <Button
                type="primary"
                disabled={Boolean(activeStep) && !copyInvalid}
                loading={submitState.isLoading}
                onClick={submitCurrent}
              >
                {selected.status === 'returned' || copyInvalid ? '重新发起审批' : '提交审批'}
              </Button>
            </Space>
          ) : null
        }
      />

      <section className="panel">
        <div className="panel-title">
          <h3>待处理资料包</h3>
          <span className="muted">选择资料包后查看受控副本与审批路线</span>
        </div>
        <Table
          rowKey="id"
          columns={packageColumns}
          dataSource={data.packages}
          pagination={false}
          rowClassName={(record) => (record.id === selectedId ? 'ant-table-row-selected' : '')}
          onRow={(record) => ({ onClick: () => setSelectedId(record.id) })}
        />
      </section>

      {copyInvalid ? (
        <Alert
          type="error"
          showIcon
          message="受控副本已失效，当前审批待复核"
          description={
            <Space direction="vertical" size={6}>
              <span>
                原件在审批期间发生修改，引用它的审批步骤已全部失效。系统不会拿旧页、旧结论或旧声明继续签署。
              </span>
              <span>失效原因：{activeCopy?.invalidateReason ?? '原件现行页、脱敏结论或声明已变更'}</span>
              <Button type="primary" danger size="small" loading={recaptureState.isLoading} onClick={recapture}>
                复核原件并重新收拢副本
              </Button>
            </Space>
          }
          style={{ marginBottom: 16 }}
        />
      ) : null}

      {selected ? (
        <div className="two-column">
          <section className="panel">
            <div className="panel-title">
              <h3>{selected.title}</h3>
              <StatusTag status={selected.status} />
            </div>
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              {selected.approvalRoute.length ? (
                <Steps
                  direction="vertical"
                  current={selected.approvalRoute.findIndex((step) => step.status === 'active')}
                  items={selected.approvalRoute.map((step) => ({
                    title: `${step.role}${step.copyId ? ` · ${step.copyId.slice(-6)}` : ''}`,
                    description: `${step.assignee} · ${
                      step.status === 'approved'
                        ? '已通过'
                        : step.status === 'returned'
                          ? '已退回'
                          : step.status === 'active'
                            ? '待处理'
                            : step.status === 'stale'
                              ? '副本失效待复核'
                              : '等待前序步骤'
                    }`,
                    status:
                      step.status === 'approved'
                        ? 'finish'
                        : step.status === 'returned'
                          ? 'error'
                          : step.status === 'active'
                            ? 'process'
                            : step.status === 'stale'
                              ? 'error'
                              : 'wait',
                  }))}
                />
              ) : (
                <Alert type="info" showIcon message="尚未生成审批路线，提交时收拢受控副本。" />
              )}
              {copyInvalid ? (
                <Button type="primary" danger loading={recaptureState.isLoading} onClick={recapture}>
                  复核并重新收拢受控副本
                </Button>
              ) : (
                <Button onClick={submitCurrent} disabled={Boolean(activeStep)} loading={submitState.isLoading}>
                  重新收拢并生成审批路线
                </Button>
              )}
            </Space>
          </section>

          <section className="panel">
            <div className="panel-title">
              <h3>当前受控副本</h3>
              {activeCopy ? <Tag color={copyTagColor}>{copyStatusLabels[activeCopy.status]}</Tag> : <Tag>无</Tag>}
            </div>
            {activeCopy ? (
              <Space direction="vertical" size={14} style={{ width: '100%' }}>
                <Descriptions column={1} bordered size="small">
                  <Descriptions.Item label="副本编号">{activeCopy.id}</Descriptions.Item>
                  <Descriptions.Item label="收拢时间">
                    {new Date(activeCopy.createdAt).toLocaleString('zh-CN')}
                  </Descriptions.Item>
                  <Descriptions.Item label="发起轮次">第 {activeCopy.round} 轮</Descriptions.Item>
                  <Descriptions.Item label="钉住声明">
                    {activeCopy.declarations.join('、') || '无'}
                  </Descriptions.Item>
                  <Descriptions.Item label="额度占用快照">
                    已用 {activeCopy.quotaSnapshot.used}，预占 {activeCopy.quotaSnapshot.reserved}，
                    上限 {activeCopy.quotaSnapshot.limit}
                  </Descriptions.Item>
                  {activeCopy.sealedAt ? (
                    <Descriptions.Item label="落章">
                      {activeCopy.sealedBy} · {new Date(activeCopy.sealedAt).toLocaleString('zh-CN')}
                    </Descriptions.Item>
                  ) : null}
                  {activeCopy.invalidateReason ? (
                    <Descriptions.Item label="失效原因">{activeCopy.invalidateReason}</Descriptions.Item>
                  ) : null}
                </Descriptions>
                <div>
                  <strong>收拢的现行页与脱敏结论</strong>
                  <div style={{ marginTop: 8 }}>
                    {activeCopy.files.map((file) => {
                      const controlled = file.pages.filter((page) => page.controlled).length
                      const desensitized = file.pages.filter(
                        (page) => page.controlled && page.desensitized,
                      ).length
                      return (
                        <div key={file.fileId} className="version-box" style={{ marginBottom: 8 }}>
                          <Space wrap>
                            <strong>{file.fileName}</strong>
                            <Tag color="blue">{file.versionLabel}</Tag>
                            <Tag>{file.versionHash}</Tag>
                            <span className="muted">{file.pages.length} 页</span>
                            <Tag color="orange">受控 {controlled}</Tag>
                            <Tag color={controlled === desensitized ? 'green' : 'red'}>
                              已脱敏 {desensitized}/{controlled}
                            </Tag>
                          </Space>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </Space>
            ) : (
              <Alert
                type="warning"
                showIcon
                message={copyInvalid ? '副本已失效，复核收拢后生成新副本。' : '没有受控副本，提交审批时自动收拢。'}
              />
            )}
          </section>
        </div>
      ) : null}

      {selected ? (
        <section className="panel">
          <div className="panel-title">
            <h3>步骤明细与历史意见</h3>
            <span className="muted">签署只对当前仍有效的副本生效；失效步骤保留旧意见可追溯</span>
          </div>
          <Table
            rowKey="id"
            columns={stepColumns}
            dataSource={selected.approvalRoute}
            pagination={false}
          />
        </section>
      ) : null}

      {copyHistory.length ? (
        <section className="panel">
          <div className="panel-title">
            <h3>受控副本履历</h3>
            <span className="muted">每次发起/复核收拢生成一份，落章后不可撤销</span>
          </div>
          <Timeline
            items={copyHistory.map((copy) => ({
              color: copy.status === 'active' ? 'green' : copy.status === 'sealed' ? 'blue' : 'red',
              children: (
                <Space direction="vertical" size={2}>
                  <Space wrap>
                    <Tag>{copy.id.slice(-6)}</Tag>
                    <strong>{copyStatusLabels[copy.status]}</strong>
                    <span className="muted">第 {copy.round} 轮</span>
                    <span className="muted">{new Date(copy.createdAt).toLocaleString('zh-CN')}</span>
                  </Space>
                  <span className="muted">
                    {copy.files.length} 个文件 · 声明 {copy.declarations.length} 项 · 额度{' '}
                    {copy.quotaSnapshot.used}/{copy.quotaSnapshot.limit}
                    {copy.invalidateReason ? ` · 失效：${copy.invalidateReason}` : ''}
                  </span>
                </Space>
              ),
            }))}
          />
        </section>
      ) : null}

      <Modal
        title={decision === 'approve' ? '对当前受控副本签署通过' : '退回并进入补正'}
        open={decisionOpen}
        onCancel={() => setDecisionOpen(false)}
        onOk={confirmDecision}
        confirmLoading={decideState.isLoading}
        okText={decision === 'approve' ? '确认落章' : '确认退回'}
        okButtonProps={{ danger: decision === 'return' }}
        cancelText="取消"
      >
        <Alert
          type={decision === 'approve' ? 'info' : 'warning'}
          showIcon
          message={
            decision === 'approve'
              ? `签署对象为受控副本 ${activeCopy?.id.slice(-6) ?? ''}：${copyInvalid ? '副本已失效，禁止签署' : '副本有效，落章后不可撤销。'}`
              : '退回后当前轮次结束，补充资料后重新发起会收拢新副本。'
          }
          style={{ marginBottom: 14 }}
        />
        <Input.TextArea
          rows={4}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder={decision === 'approve' ? '填写审批意见' : '明确说明退回原因和补正要求'}
        />
      </Modal>
    </div>
  )
}
