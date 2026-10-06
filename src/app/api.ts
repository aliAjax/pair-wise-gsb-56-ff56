import { createApi } from '@reduxjs/toolkit/query/react'
import type { BaseQueryFn } from '@reduxjs/toolkit/query/react'
import type {
  MaterialFile,
  MaterialPackage,
  PageReview,
  ReviewComment,
  WorkspaceState,
} from '@/types/domain'
import { loadWorkspace, resetWorkspace, saveWorkspace } from '@/services/storage'
import { createApprovalRoute, findApplicableRule, validatePackage } from '@/services/rules'
import {
  attachCopyToRoute,
  createControlledCopy,
  fingerprintSource,
  invalidateActiveCopies,
} from '@/services/controlledCopy'

type MockRequest = {
  url: string
  method: 'GET' | 'POST'
  body?: unknown
}

type MockError = { status: number; error: string }

const wait = (ms = 180) => new Promise((resolve) => window.setTimeout(resolve, ms))
const now = () => new Date().toISOString()

let requestChain: Promise<unknown> = Promise.resolve()
function enqueueRequest<T>(task: () => Promise<T>): Promise<T> {
  const result = requestChain.then(task, task)
  requestChain = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

async function handleMockRequest({ url, body }: MockRequest) {
  await wait()
  let state = loadWorkspace()
  state.controlledCopies ??= []
  const payload = (body ?? {}) as Record<string, unknown>
  const audit = (entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>) => {
    state.audit.unshift({ ...entry, id: `audit-${crypto.randomUUID()}`, createdAt: now() })
  }
  const invalidate = (packageItem: MaterialPackage, reason: string) => {
    let changed = false
    state.controlledCopies = state.controlledCopies.map((copy) => {
      if (copy.packageId !== packageItem.id || copy.status !== 'active') return copy
      const next = invalidateActiveCopies(packageItem, [copy], state.files, reason, now())[0]
      if (next !== copy && next.status === 'invalid') {
        changed = true
        return next
      }
      return copy
    })
    if (changed) {
      const activeCopy = state.controlledCopies.find(
        (copy) => copy.id === packageItem.activeControlledCopyId,
      )
      if (activeCopy?.status === 'invalid') {
        packageItem.status = 'stale'
        packageItem.approvalRoute = packageItem.approvalRoute.map((step) =>
          step.copyId === activeCopy.id && step.status !== 'returned'
            ? { ...step, status: 'invalid' }
            : step,
        )
      }
      audit({
        packageId: packageItem.id,
        action: '受控副本失效',
        target: packageItem.code,
        operator: '系统',
        detail: `${reason} 原审批步骤已转入待复核。`,
      })
    }
  }

  try {
    if (url === '/workspace') return { data: state }

    if (url === '/package/save') {
      const packageId = String(payload.packageId)
      const patch = payload.patch as Partial<MaterialPackage>
      const current = state.packages.find((item) => item.id === packageId)
      if (!current) throw new Error('资料包不存在')
      Object.assign(current, patch, { updatedAt: now() })
      current.matchedRuleId = findApplicableRule(current, state.rules)?.id
      audit({
        packageId,
        action: '更新资料包',
        target: current.code,
        operator: '当前用户',
        detail: '更新收件方、最终用途、声明、技术参数或许可额度占用。',
      })
      invalidate(current, '原件申报信息、声明或许可额度占用发生修改。')
    } else if (url === '/package/create') {
      const draft = payload.package as Omit<
        MaterialPackage,
        'id' | 'approvalRoute' | 'versions' | 'currentRound' | 'createdAt' | 'updatedAt'
      >
      const rule = findApplicableRule(
        { ...draft, id: 'temp', approvalRoute: [], versions: [], currentRound: 0, createdAt: '', updatedAt: '' },
        state.rules,
      )
      const packageItem: MaterialPackage = {
        ...draft,
        id: `pkg-${crypto.randomUUID()}`,
        matchedRuleId: rule?.id,
        approvalRoute: [],
        currentRound: 0,
        createdAt: now(),
        updatedAt: now(),
        versions: [],
      }
      packageItem.versions.push({
        id: `version-${crypto.randomUUID()}`,
        label: 'V1.0',
        createdAt: now(),
        createdBy: packageItem.applicant,
        summary: '创建资料包初始版本。',
        snapshot: {
          title: packageItem.title,
          category: packageItem.category,
          destination: packageItem.destination,
          endUse: packageItem.endUse,
          technologyTags: [...packageItem.technologyTags],
          personnelScopes: [...packageItem.personnelScopes],
          declarations: [...packageItem.declarations],
          activeFileVersions: {},
        },
      })
      state.packages.unshift(packageItem)
      audit({
        packageId: packageItem.id,
        action: '创建资料包',
        target: packageItem.code,
        operator: packageItem.applicant,
        detail: `目的地：${packageItem.destination}，资料类型：${packageItem.category}。`,
      })
    } else if (url === '/file/save') {
      const file = payload.file as MaterialFile
      const index = state.files.findIndex((item) => item.id === file.id)
      if (index >= 0) state.files[index] = file
      else state.files.push(file)
      const savedPackage = state.packages.find((item) => item.id === file.packageId)
      if (savedPackage) invalidate(savedPackage, '资料文件原件发生修改。')
    } else if (url === '/file/version/add') {
      const packageId = String(payload.packageId)
      const fileId = String(payload.fileId)
      const file = state.files.find((item) => item.id === fileId && item.packageId === packageId)
      if (!file) throw new Error('文件不存在')
      const pageCount = Number(payload.pageCount)
      const label = String(payload.label)
      const summary = String(payload.summary)
      const newVersion = {
        id: `file-version-${crypto.randomUUID()}`,
        label,
        uploadedAt: now(),
        hash: crypto.randomUUID().slice(0, 8).toUpperCase(),
        sizeKb: pageCount * 96 + 720,
        pages: Array.from({ length: pageCount }, (_, index) => ({
          id: `page-${crypto.randomUUID()}`,
          page: index + 1,
          category: file.kind,
          controlled: false,
          desensitized: false,
          note: '',
          reviewer: '',
        })),
        changeSummary: summary,
      }
      file.versions.push(newVersion)
      file.activeVersionId = newVersion.id
      audit({
        packageId,
        action: '上传文件版本',
        target: `${file.name} ${label}`,
        operator: '当前用户',
        detail: summary,
      })
      const versionPackage = state.packages.find((item) => item.id === packageId)
      if (versionPackage) invalidate(versionPackage, `文件 ${file.name} 现行版本已更新。`)
    } else if (url === '/file/reference') {
      const fileId = String(payload.fileId)
      const versionId = String(payload.versionId)
      const file = state.files.find((item) => item.id === fileId)
      if (!file) throw new Error('文件不存在')
      file.referencedVersionId = versionId
      audit({
        packageId: file.packageId,
        action: '选择引用版本',
        target: file.name,
        operator: '当前用户',
        detail: `引用版本调整为 ${file.versions.find((item) => item.id === versionId)?.label ?? versionId}。`,
      })
      const referencePackage = state.packages.find((item) => item.id === file.packageId)
      if (referencePackage) invalidate(referencePackage, `${file.name} 审批引用版本被切换。`)
    } else if (url === '/page/save') {
      const file = state.files.find((item) => item.id === String(payload.fileId))
      const version = file?.versions.find((item) => item.id === String(payload.versionId))
      if (!file || !version) throw new Error('文件版本不存在')
      const page = payload.page as PageReview
      const index = version.pages.findIndex((item) => item.id === page.id)
      if (index >= 0) version.pages[index] = page
      else version.pages.push(page)
      audit({
        packageId: file.packageId,
        action: '逐页分类核对',
        target: `${file.name} 第 ${page.page} 页`,
        operator: page.reviewer || '当前用户',
        detail: page.controlled ? `标记受控，脱敏状态：${page.desensitized ? '已脱敏' : '待脱敏'}` : '标记为一般资料',
      })
      const pagePackage = state.packages.find((item) => item.id === file.packageId)
      if (pagePackage) invalidate(pagePackage, `${file.name} 第 ${page.page} 页核对结论发生修改。`)
    } else if (url === '/package/validate') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      state.findings = [
        ...state.findings.filter((item) => item.packageId !== packageId),
        ...validatePackage(packageItem, state.files, state.rules),
      ]
      audit({
        packageId,
        action: '执行许可校验',
        target: packageItem.code,
        operator: '当前用户',
        detail: `生成 ${state.findings.filter((item) => item.packageId === packageId).length} 条核对结果。`,
      })
    } else if (url === '/package/version') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      const summary = String(payload.summary)
      const label = String(payload.label)
      packageItem.versions.push({
        id: `package-version-${crypto.randomUUID()}`,
        label,
        createdAt: now(),
        createdBy: '当前用户',
        summary,
        snapshot: {
          title: packageItem.title,
          category: packageItem.category,
          destination: packageItem.destination,
          endUse: packageItem.endUse,
          technologyTags: [...packageItem.technologyTags],
          personnelScopes: [...packageItem.personnelScopes],
          declarations: [...packageItem.declarations],
          activeFileVersions: Object.fromEntries(
            state.files
              .filter((file) => file.packageId === packageId)
              .map((file) => [file.id, file.activeVersionId]),
          ),
        },
      })
      audit({
        packageId,
        action: '创建资料包版本',
        target: `${packageItem.code} ${label}`,
        operator: '当前用户',
        detail: summary,
      })
    } else if (url === '/approval/submit') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      if (!['draft', 'validating', 'returned', 'stale'].includes(packageItem.status)) {
        throw new Error('当前资料包状态不能重新发起审批')
      }
      const rule = findApplicableRule(packageItem, state.rules)
      if (!rule) throw new Error('未匹配到许可规则')
      packageItem.quotaLimit = rule.quotaLimit
      const findings = validatePackage(packageItem, state.files, state.rules)
      const hasVersionMismatch = state.files
        .filter((file) => file.packageId === packageId)
        .some((file) => file.activeVersionId !== file.referencedVersionId)
      state.findings = [
        ...state.findings.filter((item) => item.packageId !== packageId),
        ...findings,
      ]
      if (hasVersionMismatch || findings.some((item) => item.level === 'high')) {
        saveWorkspace(state)
        throw new Error('仍存在高风险核对项，不能收拢受控副本并提交审批')
      }
      const route = createApprovalRoute(rule.approvalLevel)
      const copy = createControlledCopy(packageItem, state.files, {
        rule,
        createdBy: String(payload.operator ?? packageItem.applicant),
      })
      state.controlledCopies.push(copy)
      copy.round = packageItem.currentRound + 1
      packageItem.approvalRoute = attachCopyToRoute(copy, route)
      packageItem.activeControlledCopyId = copy.id
      packageItem.matchedRuleId = rule.id
      packageItem.status = 'reviewing'
      packageItem.currentRound = copy.round
      packageItem.updatedAt = now()
      audit({
        packageId,
        action: '收拢受控副本',
        target: packageItem.code,
        operator: copy.createdBy,
        detail: `副本 ${copy.id} 已固化现行页、脱敏结论、声明和许可占用 ${copy.quota.used}/${copy.quota.limit}。`,
      })
      audit({
        packageId,
        action: '提交审批',
        target: packageItem.code,
        operator: copy.createdBy,
        detail: `按 ${rule.name} 生成审批路线，第 ${copy.round} 轮。`,
      })
    } else if (url === '/approval/decide') {
      const packageId = String(payload.packageId)
      const stepId = String(payload.stepId)
      const requestId = String(payload.requestId ?? '')
      if (!requestId) throw new Error('签署请求缺少幂等编号')
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      const step = packageItem.approvalRoute.find((item) => item.id === stepId)
      if (!step) throw new Error('审批步骤不存在')
      const copy = state.controlledCopies.find((item) => item.id === step.copyId)
      if (!copy) throw new Error('审批步骤未绑定受控副本')

      const replayedSignature = copy.signatures.find((signature) => signature.requestId === requestId)
      if (replayedSignature) {
        if (replayedSignature.stepId !== stepId) throw new Error('幂等编号已用于其他审批步骤')
        return { data: state }
      }
      if (copy.status !== 'active') throw new Error('受控副本已失效、已退回或已完成，不能继续签署')
      if (copy.sourceFingerprint !== fingerprintSource(packageItem, state.files)) {
        state.controlledCopies = state.controlledCopies.map((item) =>
          item.id === copy.id
            ? {
                ...item,
                status: 'invalid',
                invalidatedAt: now(),
                invalidationReason: '签署时检测到原件已发生变化。',
              }
            : item,
        )
        packageItem.status = 'stale'
        packageItem.approvalRoute = packageItem.approvalRoute.map((item) =>
          item.copyId === copy.id && item.status !== 'returned'
            ? { ...item, status: 'invalid' }
            : item,
        )
        audit({
          packageId,
          action: '受控副本失效',
          target: packageItem.code,
          operator: '系统',
          detail: '签署前一致性检查发现原件变化，本次签署被拒绝。',
        })
        saveWorkspace(state)
        throw new Error('原件已变化，当前受控副本失效并转入待复核')
      }
      if (step.status !== 'active') throw new Error('当前步骤已被处理或不可审批')

      const decision = String(payload.decision) === 'return' ? 'return' : 'approve'
      const comment = String(payload.comment ?? '')
      const signer = String(payload.signer ?? step.assignee)
      const signedAt = now()
      step.comment = comment
      step.decidedAt = signedAt
      copy.signatures.push({
        requestId,
        stepId,
        role: step.role,
        signer,
        decision,
        comment,
        signedAt,
      })

      if (decision === 'return') {
        step.status = 'returned'
        copy.status = 'returned'
        packageItem.status = 'returned'
      } else {
        step.status = 'approved'
        const next = packageItem.approvalRoute.find((item) => item.order === step.order + 1)
        if (next) next.status = 'active'
        else {
          packageItem.status = 'approved'
          copy.status = 'signed'
        }
      }
      packageItem.updatedAt = signedAt
      audit({
        packageId,
        action: decision === 'return' ? '审批退回' : '审批通过',
        target: `${packageItem.code} / ${step.role}`,
        operator: signer,
        detail: `副本 ${copy.id}：${comment || '无补充意见'}`,
      })
    } else if (url === '/license/writeoff') {
      const packageId = String(payload.packageId)
      const copyId = String(payload.copyId)
      const requestId = String(payload.requestId ?? '')
      if (!requestId) throw new Error('核销请求缺少幂等编号')
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      const copy = state.controlledCopies.find(
        (item) => item.id === copyId && item.packageId === packageId,
      )
      if (!copy) throw new Error('许可核销必须引用已签署的受控副本')
      if (copy.writeoff?.requestId && copy.writeoff.requestId !== requestId) {
        throw new Error('该受控副本已有核销请求，请使用原请求按原副本重试')
      }
      if (copy.writeoff?.status === 'completed') return { data: state }
      if (!['signed', 'writeoff_failed'].includes(copy.status)) {
        throw new Error('只有已签署或核销失败待重试的受控副本允许核销')
      }

      let amount = Number(payload.amount)
      if (copy.writeoff) amount = copy.writeoff.amount
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('核销额度必须大于 0')

      if (!copy.writeoff) {
        if (packageItem.quotaUsed + amount > copy.quota.limit) {
          throw new Error(`许可额度不足，原副本可核销余额 ${copy.quota.available}`)
        }
        packageItem.quotaUsed += amount
        packageItem.status = 'approved'
        copy.status = 'writeoff_failed'
        copy.writeoff = {
          requestId,
          amount,
          status: 'reserved',
          reservedAt: now(),
          lastAttemptAt: now(),
        }
        audit({
          packageId,
          action: '预占许可额度',
          target: packageItem.code,
          operator: '当前用户',
          detail: `按受控副本 ${copy.id} 预占 ${amount}，重试不会再次扣减。`,
        })
      }

      const simulateFailure = Boolean(payload.simulateFailure)
      if (simulateFailure) {
        copy.status = 'writeoff_failed'
        copy.writeoff = {
          ...copy.writeoff!,
          status: 'failed',
          lastAttemptAt: now(),
          failureReason: '模拟外部许可系统确认失败',
        }
        packageItem.status = 'approved'
        audit({
          packageId,
          action: '许可核销失败',
          target: packageItem.code,
          operator: '当前用户',
          detail: `副本 ${copy.id} 的 ${amount} 个额度已预占，等待按原副本重试。`,
        })
        saveWorkspace(state)
        throw new Error('外部许可核销失败；额度已预占，请按原副本重试，不会再次扣减')
      }

      copy.status = 'licensed'
      copy.writeoff = {
        ...copy.writeoff!,
        status: 'completed',
        lastAttemptAt: now(),
        completedAt: now(),
        failureReason: undefined,
      }
      packageItem.status = 'licensed'
      packageItem.updatedAt = now()
      audit({
        packageId,
        action: '许可核销完成',
        target: packageItem.code,
        operator: '当前用户',
        detail: `按受控副本 ${copy.id} 确认核销 ${amount} 个额度。`,
      })
    } else if (url === '/comment/add') {
      state.comments.unshift({
        ...(payload.comment as Omit<ReviewComment, 'id' | 'createdAt'>),
        id: `comment-${crypto.randomUUID()}`,
        createdAt: now(),
      })
    } else if (url === '/audit/add') {
      audit(payload.entry as Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>)
    } else if (url === '/workspace/reset') {
      state = resetWorkspace()
      return { data: state }
    } else {
      throw new Error(`未实现的本地接口：${url}`)
    }

    saveWorkspace(state)
    return { data: state }
  } catch (error) {
    return {
      error: {
        status: 400,
        error: error instanceof Error ? error.message : '本地操作失败',
      },
    }
  }
}

const mockBaseQuery: BaseQueryFn<MockRequest, unknown, MockError> = (request) =>
  enqueueRequest(() => handleMockRequest(request))

export const workspaceApi = createApi({
  reducerPath: 'workspaceApi',
  baseQuery: mockBaseQuery,
  tagTypes: ['Workspace'],
  endpoints: (builder) => ({
    getWorkspace: builder.query<WorkspaceState, void>({
      query: () => ({ url: '/workspace', method: 'GET' }),
      providesTags: ['Workspace'],
    }),
    savePackage: builder.mutation<
      WorkspaceState,
      { packageId: string; patch: Partial<MaterialPackage> }
    >({
      query: (body) => ({ url: '/package/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    createPackage: builder.mutation<
      WorkspaceState,
      {
        package: Omit<
          MaterialPackage,
          'id' | 'approvalRoute' | 'versions' | 'currentRound' | 'createdAt' | 'updatedAt'
        >
      }
    >({
      query: (body) => ({ url: '/package/create', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    saveFile: builder.mutation<WorkspaceState, { file: MaterialFile }>({
      query: (body) => ({ url: '/file/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addFileVersion: builder.mutation<
      WorkspaceState,
      { packageId: string; fileId: string; label: string; pageCount: number; summary: string }
    >({
      query: (body) => ({ url: '/file/version/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    setReferenceVersion: builder.mutation<
      WorkspaceState,
      { fileId: string; versionId: string }
    >({
      query: (body) => ({ url: '/file/reference', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    savePageReview: builder.mutation<
      WorkspaceState,
      { fileId: string; versionId: string; page: PageReview }
    >({
      query: (body) => ({ url: '/page/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    validatePackage: builder.mutation<WorkspaceState, { packageId: string }>({
      query: (body) => ({ url: '/package/validate', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    createPackageVersion: builder.mutation<
      WorkspaceState,
      { packageId: string; label: string; summary: string }
    >({
      query: (body) => ({ url: '/package/version', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    submitApproval: builder.mutation<WorkspaceState, { packageId: string }>({
      query: (body) => ({ url: '/approval/submit', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    decideApproval: builder.mutation<
      WorkspaceState,
      {
        packageId: string
        stepId: string
        decision: 'approve' | 'return'
        comment: string
        requestId: string
        signer?: string
      }
    >({
      query: (body) => ({ url: '/approval/decide', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    writeoffLicense: builder.mutation<
      WorkspaceState,
      {
        packageId: string
        copyId: string
        amount: number
        requestId: string
        simulateFailure?: boolean
      }
    >({
      query: (body) => ({ url: '/license/writeoff', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addComment: builder.mutation<
      WorkspaceState,
      { comment: Omit<ReviewComment, 'id' | 'createdAt'> }
    >({
      query: (body) => ({ url: '/comment/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addAudit: builder.mutation<
      WorkspaceState,
      { entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'> }
    >({
      query: (body) => ({ url: '/audit/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    resetWorkspace: builder.mutation<WorkspaceState, void>({
      query: () => ({ url: '/workspace/reset', method: 'POST' }),
      invalidatesTags: ['Workspace'],
    }),
  }),
})

export const {
  useGetWorkspaceQuery,
  useSavePackageMutation,
  useCreatePackageMutation,
  useSaveFileMutation,
  useAddFileVersionMutation,
  useSetReferenceVersionMutation,
  useSavePageReviewMutation,
  useValidatePackageMutation,
  useCreatePackageVersionMutation,
  useSubmitApprovalMutation,
  useDecideApprovalMutation,
  useWriteoffLicenseMutation,
  useAddCommentMutation,
  useAddAuditMutation,
  useResetWorkspaceMutation,
} = workspaceApi
