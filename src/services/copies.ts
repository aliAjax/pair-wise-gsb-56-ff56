import type {
  ApprovalStep,
  ControlledCopy,
  ControlledFileSnapshot,
  MaterialFile,
  MaterialPackage,
  QuotaDeduction,
  WorkspaceState,
} from '@/types/domain'

export const now = () => new Date().toISOString()

/**
 * 发起审批时收拢受控副本：
 * 钉住资料包当前声明/事实、每个文件被引用版本的现行页与脱敏结论、
 * 以及发起瞬间的许可额度占用量。此后审批与核销只认副本，不认活动原件。
 */
export function captureControlledCopy(
  packageItem: MaterialPackage,
  files: MaterialFile[],
): ControlledCopy {
  const round = packageItem.currentRound
  return {
    id: `copy-${crypto.randomUUID()}`,
    packageId: packageItem.id,
    round,
    status: 'active',
    createdAt: now(),
    declarations: [...packageItem.declarations],
    recipient: packageItem.recipient,
    destination: packageItem.destination,
    endUse: packageItem.endUse,
    technologyTags: [...packageItem.technologyTags],
    personnelScopes: [...packageItem.personnelScopes],
    files: files
      .filter((file) => file.packageId === packageItem.id)
      .map((file) => snapshotFile(file, file.referencedVersionId)),
    quotaSnapshot: {
      used: packageItem.quotaUsed,
      limit: packageItem.quotaLimit,
      reserved: packageItem.quotaReserved,
    },
    deductions: [],
  }
}

function snapshotFile(file: MaterialFile, versionId: string): ControlledFileSnapshot {
  const version =
    file.versions.find((item) => item.id === versionId) ??
    file.versions.find((item) => item.id === file.activeVersionId) ??
    file.versions[0]
  return {
    fileId: file.id,
    fileName: file.name,
    versionId: version.id,
    versionLabel: version.label,
    versionHash: version.hash,
    pages: version.pages.map((page) => ({
      page: page.page,
      category: page.category,
      controlled: page.controlled,
      desensitized: page.desensitized,
      note: page.note,
      reviewer: page.reviewer,
      reviewedAt: page.reviewedAt,
    })),
  }
}

export function getActiveCopy(state: WorkspaceState, packageId: string): ControlledCopy | undefined {
  const packageItem = state.packages.find((item) => item.id === packageId)
  if (!packageItem?.activeCopyId) return undefined
  return state.controlledCopies.find((copy) => copy.id === packageItem.activeCopyId)
}

/** 声明或申报事实是否相对副本发生变化。 */
export function factsChanged(copy: ControlledCopy, packageItem: MaterialPackage): boolean {
  return (
    JSON.stringify([...copy.declarations].sort()) !==
      JSON.stringify([...packageItem.declarations].sort()) ||
    copy.recipient !== packageItem.recipient ||
    copy.destination !== packageItem.destination ||
    copy.endUse !== packageItem.endUse ||
    JSON.stringify([...copy.technologyTags].sort()) !==
      JSON.stringify([...packageItem.technologyTags].sort()) ||
    JSON.stringify([...copy.personnelScopes].sort()) !==
      JSON.stringify([...packageItem.personnelScopes].sort())
  )
}

/** 某个被钉住版本的现行页内容（分类/受控/脱敏/核对说明）是否被改动。 */
export function pagesChanged(file: MaterialFile, snapshot: ControlledFileSnapshot): boolean {
  if (file.activeVersionId !== snapshot.versionId) return true
  const version = file.versions.find((item) => item.id === snapshot.versionId)
  if (!version || version.pages.length !== snapshot.pages.length) return true
  return version.pages.some((page, index) => {
    const snap = snapshot.pages[index]
    return (
      page.page === snap.page &&
      (page.category !== snap.category ||
        page.controlled !== snap.controlled ||
        page.desensitized !== snap.desensitized ||
        page.note !== snap.note)
    )
  })
}

/** 收集某份活动副本相对当前原件的失效原因；无原因则仍有效。 */
export function invalidationReasons(
  copy: ControlledCopy,
  packageItem: MaterialPackage,
  files: MaterialFile[],
): string[] {
  if (copy.status !== 'active') return []
  const reasons: string[] = []
  if (factsChanged(copy, packageItem)) reasons.push('声明或申报事实已变更')
  copy.files.forEach((snapshot) => {
    const file = files.find((item) => item.id === snapshot.fileId)
    if (!file) {
      reasons.push(`${snapshot.fileName} 已被移除`)
      return
    }
    if (file.referencedVersionId !== snapshot.versionId) {
      reasons.push(`${file.name} 的引用版本已切换`)
    } else if (pagesChanged(file, snapshot)) {
      reasons.push(`${file.name} 现行页分类或脱敏结论已修改`)
    }
  })
  return reasons
}

/**
 * 原件发生修改后失效引用它的活动副本：
 * 仅失效进行中的副本；已落章（sealed）副本不可撤销，保持原结论可追溯。
 * 引用该副本的审批步骤转为 stale 待复核，资料包进入 rechecking。
 */
export function invalidateCopiesForPackage(
  state: WorkspaceState,
  packageId: string,
  fallbackReason: string,
  audit: (entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>) => void,
): ControlledCopy[] {
  const packageItem = state.packages.find((item) => item.id === packageId)
  // 只有审批中的原件修改才会让在途副本失效；草稿/退回后的补正改件属于正常修改。
  if (!packageItem || packageItem.status !== 'reviewing') return []
  const invalidated: ControlledCopy[] = []
  state.controlledCopies
    .filter((copy) => copy.packageId === packageId && copy.status === 'active')
    .forEach((copy) => {
      const reasons = invalidationReasons(copy, packageItem, state.files)
      if (!reasons.length) return
      const reason = reasons.join('；')
      copy.status = 'invalidated'
      copy.invalidatedAt = now()
      copy.invalidateReason = reason
      packageItem.approvalRoute.forEach((step) => {
        if (step.copyId === copy.id && (step.status === 'active' || step.status === 'approved')) {
          step.status = 'stale'
        }
      })
      packageItem.status = 'rechecking'
      invalidated.push(copy)
      audit({
        packageId,
        action: '受控副本失效',
        target: packageItem.code,
        operator: '系统',
        detail: `${fallbackReason}，审批引用副本 ${copy.id.slice(-6)} 失效并待复核。`,
      })
    })
  if (invalidated.length && packageItem.activeCopyId) {
    packageItem.activeCopyId = undefined
  }
  return invalidated
}

/** 复核通过后重新收拢副本：沿用审批路线，已失效步骤重置，重新钉住现行原件。 */
export function recaptureCopy(
  state: WorkspaceState,
  packageItem: MaterialPackage,
  audit: (entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>) => void,
): ControlledCopy {
  const copy = captureControlledCopy(packageItem, state.files)
  state.controlledCopies.push(copy)
  packageItem.activeCopyId = copy.id
  packageItem.status = 'reviewing'
  packageItem.approvalRoute = packageItem.approvalRoute.map((step) =>
    rebindStep(step, copy.id),
  )
  audit({
    packageId: packageItem.id,
    action: '复核重新收拢副本',
    target: packageItem.code,
    operator: '当前用户',
    detail: `按现行页、脱敏结论、声明与额度占用重新生成副本 ${copy.id.slice(-6)}，失效步骤重置待签。`,
  })
  return copy
}

function rebindStep(step: ApprovalStep, copyId: string): ApprovalStep {
  if (step.status === 'stale') {
    // 失效步骤一律重新签署：第一顺序步恢复为活动，其余等待前序。
    return {
      ...step,
      status: step.order === 1 ? 'active' : 'waiting',
      copyId,
      comment: step.comment,
    }
  }
  return { ...step, copyId }
}

/**
 * 许可核销（幂等）：
 * - 已存在同 requestId 账本：核销失败后的重试只推动同一笔预占落账，绝不二次扣额度；
 *   已 settled 的重复回放直接返回既有结果。
 * - 新请求：额度可用性按“发起副本”的占用快照叠加当前真实占用判定，
 *   通过则先预占（reserve），再模拟落账；失败不留预占、不扣额度。
 */
export function deductQuotaAgainstCopy(
  state: WorkspaceState,
  copy: ControlledCopy,
  requestId: string,
  amount: number,
  simulateFailure: boolean,
): { deduction: QuotaDeduction; replayed: boolean } {
  const packageItem = state.packages.find((item) => item.id === copy.packageId)
  if (!packageItem) throw new Error('资料包不存在')

  const existing = copy.deductions.find((item) => item.requestId === requestId)
  if (existing) {
    if (existing.status === 'settled') {
      return { deduction: existing, replayed: true }
    }
    // 核销失败后的重试：按原副本推动同一笔预占落账，不再新增占用。
    if (simulateFailure) {
      throw new Error('许可核销网关失败（重试模拟）：额度保持预占，未被扣减，可继续重试。')
    }
    existing.status = 'settled'
    existing.settledAt = now()
    existing.note = '原副本预占落账成功，重试未重复扣额度。'
    packageItem.quotaReserved -= existing.amount
    packageItem.quotaUsed += existing.amount
    copy.quotaSnapshot.reserved -= existing.amount
    copy.quotaSnapshot.used += existing.amount
    return { deduction: existing, replayed: false }
  }

  // 副本发起之后、核销之前的新增占用仍要计入，但副本自身这一笔不重复计算。
  const occupied = copy.quotaSnapshot.used + copy.quotaSnapshot.reserved
  const otherReservations = packageItem.quotaReserved - copy.quotaSnapshot.reserved
  if (occupied + otherReservations + amount > copy.quotaSnapshot.limit) {
    throw new Error('许可额度不足，已拒绝核销且未扣减额度')
  }

  // 先预占：核销在落账前失败，额度也不会丢失或被重复使用。
  packageItem.quotaReserved += amount
  copy.quotaSnapshot.reserved += amount
  const deduction: QuotaDeduction = {
    requestId,
    copyId: copy.id,
    amount,
    status: 'reserved',
    createdAt: now(),
    note: '已预占额度，等待许可核销落账。',
  }
  copy.deductions.push(deduction)

  if (simulateFailure) {
    throw new Error('许可核销网关失败（模拟）：额度已预占但未扣减，可按原副本重试。')
  }

  deduction.status = 'settled'
  deduction.settledAt = now()
  deduction.note = '核销成功：预占转扣减。'
  packageItem.quotaReserved -= amount
  packageItem.quotaUsed += amount
  copy.quotaSnapshot.reserved -= amount
  copy.quotaSnapshot.used += amount
  return { deduction, replayed: false }
}

export const copyStatusLabels: Record<ControlledCopy['status'], string> = {
  active: '有效',
  invalidated: '已失效待复核',
  sealed: '已落章',
}
