import { createApi } from '@reduxjs/toolkit/query/react'
import type { BaseQueryFn } from '@reduxjs/toolkit/query/react'
import type {
  ControlledCopy,
  MaterialFile,
  MaterialPackage,
  PageReview,
  ReviewComment,
  WorkspaceState,
} from '@/types/domain'
import { loadWorkspace, resetWorkspace, saveWorkspace } from '@/services/storage'
import { createApprovalRoute, findApplicableRule, validatePackage } from '@/services/rules'
import {
  captureControlledCopy,
  deductQuotaAgainstCopy,
  getActiveCopy,
  invalidateCopiesForPackage,
  recaptureCopy,
} from '@/services/copies'

type MockRequest = {
  url: string
  method: 'GET' | 'POST'
  body?: Record<string, unknown>
}

type MockError = { status: number; error: string }
type MockMeta = { replayed?: boolean }

const wait = (ms = 180) => new Promise((resolve) => window.setTimeout(resolve, ms))
const now = () => new Date().toISOString()

/**
 * 写入串行化：本地模拟也是共享状态，所有 POST 排队执行，
 * 使 expectedRevision 的乐观并发检查与真实后端一致——两人同时提交时后者撞 409。
 */
let writeChain: Promise<unknown> = Promise.resolve()
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task)
  writeChain = run.catch(() => undefined)
  return run
}

const CONFLICT_URLS = new Set(['/approval/decide', '/license/deduct'])

async function handle(request: MockRequest): Promise<{
  data: WorkspaceState
  meta?: MockMeta
}> {
  await wait()
  const state = loadWorkspace()
  const payload = request.body ?? {}
  const requestId = payload.requestId ? String(payload.requestId) : undefined
  let meta: MockMeta | undefined

  const audit = (entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>) => {
    state.audit.unshift({ ...entry, id: `audit-${crypto.randomUUID()}`, createdAt: now() })
  }

  // 幂等：同一 requestId 重复回放直接返回，不重复落章、不重复扣额度。
  if (requestId) {
    const processed = state.processedRequests.find((item) => item.requestId === requestId)
    if (processed) {
      processed.replayed += 1
      meta = { replayed: true }
      audit({
        action: '幂等回放拦截',
        target: processed.url,
        operator: '系统',
        detail: `重复请求 ${requestId.slice(-8)} 被识别，回放原结果，未重复执行。`,
      })
      saveWorkspace(state)
      return { data: state, meta }
    }
  }

  // 乐观并发控制：签署/核销携带加载时的 revision，期间有人改过则冲突。
  if (requestId && CONFLICT_URLS.has(request.url)) {
    const expected = Number(payload.expectedRevision)
    if (Number.isFinite(expected) && expected !== state.revision) {
      throw Object.assign(new Error('数据已被他人更新（版本冲突），请刷新后基于最新受控副本重试。'), {
        status: 409,
      })
    }
  }

  const invalidate = (packageId: string, reason: string) =>
    invalidateCopiesForPackage(state, packageId, reason, audit)

  if (request.url === '/workspace') return { data: state }

  if (request.url === '/package/save') {
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
      detail: '更新收件方、最终用途、声明或技术参数。',
    })
    invalidate(packageId, '资料包申报信息或声明被修改')
  } else if (request.url === '/package/create') {
    const draft = payload.package as Omit<
      MaterialPackage,
      | 'id'
      | 'approvalRoute'
      | 'versions'
      | 'currentRound'
      | 'quotaReserved'
      | 'createdAt'
      | 'updatedAt'
    >
    const rule = findApplicableRule(
      { ...draft, id: 'temp', approvalRoute: [], versions: [], currentRound: 0, quotaReserved: 0, createdAt: '', updatedAt: '' },
      state.rules,
    )
    const packageItem: MaterialPackage = {
      ...draft,
      quotaReserved: 0,
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
  } else if (request.url === '/file/save') {
    const file = payload.file as MaterialFile
    const index = state.files.findIndex((item) => item.id === file.id)
    if (index >= 0) state.files[index] = file
    else state.files.push(file)
  } else if (request.url === '/file/version/add') {
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
    invalidate(packageId, `文件 ${file.name} 出现新版本并成为现行版`)
  } else if (request.url === '/file/reference') {
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
    invalidate(file.packageId, `文件 ${file.name} 的审批引用版本被切换`)
  } else if (request.url === '/page/save') {
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
    invalidate(file.packageId, `文件 ${file.name} 现行页分类或脱敏结论被修改`)
  } else if (request.url === '/package/validate') {
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
  } else if (request.url === '/package/version') {
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
  } else if (request.url === '/approval/submit') {
    const packageId = String(payload.packageId)
    const packageItem = state.packages.find((item) => item.id === packageId)
    if (!packageItem) throw new Error('资料包不存在')
    const rule = findApplicableRule(packageItem, state.rules)
    if (!rule) throw new Error('未匹配到许可规则')

    // 发起即收拢：现行页、脱敏结论、声明、许可额度占用量全部钉进受控副本。
    const copy = captureControlledCopy(packageItem, state.files)
    state.controlledCopies.push(copy)
    packageItem.approvalRoute = createApprovalRoute(rule.approvalLevel).map((step) => ({
      ...step,
      copyId: copy.id,
    }))
    packageItem.matchedRuleId = rule.id
    packageItem.activeCopyId = copy.id
    packageItem.status = 'reviewing'
    packageItem.currentRound += 1
    audit({
      packageId,
      action: '提交审批',
      target: packageItem.code,
      operator: '当前用户',
      detail: `按 ${rule.name} 生成审批路线并收拢受控副本 ${copy.id.slice(-6)}（第 ${packageItem.currentRound} 轮），钉住 ${copy.files.length} 个文件现行页与额度占用 ${copy.quotaSnapshot.used}/${copy.quotaSnapshot.limit}。`,
    })
  } else if (request.url === '/approval/recapture') {
    const packageId = String(payload.packageId)
    const packageItem = state.packages.find((item) => item.id === packageId)
    if (!packageItem) throw new Error('资料包不存在')
    if (packageItem.status !== 'rechecking') throw new Error('仅失效待复核的审批可以重新收拢副本')
    recaptureCopy(state, packageItem, audit)
  } else if (request.url === '/approval/decide') {
    const packageId = String(payload.packageId)
    const packageItem = state.packages.find((item) => item.id === packageId)
    if (!packageItem) throw new Error('资料包不存在')
    const copy = getActiveCopy(state, packageId)
    if (!copy) throw new Error('没有有效的受控副本，需重新发起或复核收拢')
    if (copy.status === 'invalidated') {
      throw Object.assign(new Error('受控副本已随原件修改失效，本步骤待复核，不能继续签署。'), {
        status: 409,
      })
    }
    const step = packageItem.approvalRoute.find((item) => item.id === String(payload.stepId))
    if (!step || step.status !== 'active') throw new Error('当前步骤不可审批')
    if (step.copyId !== copy.id) throw new Error('该步骤绑定的副本已不是当前有效副本，请刷新后复核')

    const decision = String(payload.decision)
    step.comment = String(payload.comment ?? '')
    step.decidedAt = now()
    if (decision === 'return') {
      step.status = 'returned'
      packageItem.status = 'returned'
      packageItem.activeCopyId = undefined
      audit({
        packageId,
        action: '审批退回',
        target: `${packageItem.code} / ${step.role}`,
        operator: step.assignee,
        detail: `退回受控副本 ${copy.id.slice(-6)}：${step.comment || '无补充意见。'}`,
      })
    } else {
      step.status = 'approved'
      const next = packageItem.approvalRoute.find((item) => item.order === step.order + 1)
      if (next) {
        next.status = 'active'
        next.copyId = copy.id
        audit({
          packageId,
          action: '审批通过',
          target: `${packageItem.code} / ${step.role}`,
          operator: step.assignee,
          detail: `对受控副本 ${copy.id.slice(-6)} 落章：${step.comment || '无补充意见。'}`,
        })
      } else {
        // 最后一人签署：只对仍有效的那份副本落章。
        copy.status = 'sealed'
        copy.sealedAt = now()
        copy.sealedBy = step.assignee
        packageItem.status = 'approved'
        audit({
          packageId,
          action: '审批通过并落章',
          target: `${packageItem.code} / ${step.role}`,
          operator: step.assignee,
          detail: `受控副本 ${copy.id.slice(-6)} 完成签署并封存，后续核销只认该副本；意见：${step.comment || '无。'}`,
        })
      }
    }
  } else if (request.url === '/license/deduct') {
    const packageId = String(payload.packageId)
    const amount = Number(payload.amount)
    const packageItem = state.packages.find((item) => item.id === packageId)
    if (!packageItem) throw new Error('资料包不存在')
    const copy = state.controlledCopies.find(
      (item) => item.id === String(payload.copyId),
    )
    if (!copy || copy.packageId !== packageId) throw new Error('核销必须指定发起时的受控副本')
    if (copy.status !== 'sealed') throw new Error('只有已落章的受控副本才能核销许可')

    try {
      const { deduction, replayed } = deductQuotaAgainstCopy(
        state,
        copy,
        String(requestId ?? `deduct-${crypto.randomUUID()}`),
        amount,
        Boolean(payload.simulateFailure),
      )
      meta = replayed ? { replayed: true } : meta
      packageItem.status = 'licensed'
      audit({
        packageId,
        action: deduction.status === 'settled' && !replayed ? '许可核销落账' : '许可核销幂等回放',
        target: packageItem.code,
        operator: '当前用户',
        detail: replayed
          ? `重复回放核销请求 ${deduction.requestId.slice(-8)}，返回原落账结果，未重复扣额度。`
          : `按受控副本 ${copy.id.slice(-6)} 核销 ${deduction.amount}，剩余 ${copy.quotaSnapshot.limit - packageItem.quotaUsed}。`,
      })
    } catch (error) {
      // 核销失败：额度处于预占状态，保存状态后按原副本重试，不会再次扣额度。
      // 失败也推进版本并持久化，保证前端刷新后重试携带的是最新 revision。
      state.revision += 1
      saveWorkspace(state)
      throw error
    }
  } else if (request.url === '/comment/add') {
    state.comments.unshift({
      ...(payload.comment as Omit<ReviewComment, 'id' | 'createdAt'>),
      id: `comment-${crypto.randomUUID()}`,
      createdAt: now(),
    })
  } else if (request.url === '/audit/add') {
    audit(payload.entry as Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>)
  } else if (request.url === '/workspace/reset') {
    const reset = resetWorkspace()
    return { data: reset }
  } else {
    throw new Error(`未实现的本地接口：${request.url}`)
  }

  if (requestId) {
    state.processedRequests.unshift({
      requestId,
      url: request.url,
      replayed: 0,
      createdAt: now(),
    })
    state.processedRequests = state.processedRequests.slice(0, 100)
  }
  state.revision += 1
  saveWorkspace(state)
  return { data: state, meta }
}

const mockBaseQuery: BaseQueryFn<MockRequest, unknown, MockError, unknown, MockMeta> = async (
  request,
) => {
  try {
    if (request.method === 'GET') {
      const result = await handle(request)
      return { data: result.data, meta: result.meta }
    }
    const result = await serialize(() => handle(request))
    return { data: result.data, meta: result.meta }
  } catch (error) {
    const e = error as Error & { status?: number }
    return {
      error: {
        status: e.status ?? 400,
        error: e.message || '本地操作失败',
      },
    }
  }
}

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
          | 'id'
          | 'approvalRoute'
          | 'versions'
          | 'currentRound'
          | 'quotaReserved'
          | 'createdAt'
          | 'updatedAt'
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
    recaptureApproval: builder.mutation<WorkspaceState, { packageId: string }>({
      query: (body) => ({ url: '/approval/recapture', method: 'POST', body }),
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
        expectedRevision: number
      }
    >({
      query: (body) => ({ url: '/approval/decide', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    deductQuota: builder.mutation<
      WorkspaceState,
      {
        packageId: string
        copyId: string
        amount: number
        requestId: string
        expectedRevision: number
        simulateFailure?: boolean
      }
    >({
      query: (body) => ({ url: '/license/deduct', method: 'POST', body }),
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
  useRecaptureApprovalMutation,
  useDecideApprovalMutation,
  useDeductQuotaMutation,
  useAddCommentMutation,
  useAddAuditMutation,
  useResetWorkspaceMutation,
} = workspaceApi

export type { ControlledCopy }
