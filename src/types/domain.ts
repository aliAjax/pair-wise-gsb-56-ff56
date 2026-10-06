export type MaterialCategory = 'drawing' | 'technical' | 'software'
export type PackageStatus =
  | 'draft'
  | 'validating'
  | 'reviewing'
  | 'rechecking'
  | 'returned'
  | 'approved'
  | 'licensed'
  | 'locked'
export type ApprovalLevel = 'standard' | 'enhanced' | 'senior'
export type FindingLevel = 'high' | 'medium' | 'low'
export type FindingType = 'missing-declaration' | 'escalation' | 'version-mismatch' | 'unclassified-page' | 'quota'

export interface PageReview {
  id: string
  page: number
  category: MaterialCategory
  controlled: boolean
  desensitized: boolean
  note: string
  reviewer: string
  reviewedAt?: string
}

export interface FileVersion {
  id: string
  label: string
  uploadedAt: string
  hash: string
  sizeKb: number
  pages: PageReview[]
  changeSummary: string
}

export interface MaterialFile {
  id: string
  packageId: string
  name: string
  kind: MaterialCategory
  activeVersionId: string
  referencedVersionId: string
  versions: FileVersion[]
}

export interface ApprovalStep {
  id: string
  order: number
  role: string
  assignee: string
  level: ApprovalLevel
  status: 'waiting' | 'active' | 'approved' | 'returned' | 'stale'
  comment: string
  decidedAt?: string
  /** 本步骤落章所针对的受控副本；副本失效后步骤转为 stale，旧意见仍保留可追溯。 */
  copyId?: string
}

/** 受控副本中单个文件的页快照：收拢现行页、分类与脱敏结论。 */
export interface ControlledPageSnapshot {
  page: number
  category: MaterialCategory
  controlled: boolean
  desensitized: boolean
  note: string
  reviewer: string
  reviewedAt?: string
}

export interface ControlledFileSnapshot {
  fileId: string
  fileName: string
  versionId: string
  versionLabel: string
  versionHash: string
  pages: ControlledPageSnapshot[]
}

/** 许可核销结果，按 requestId 幂等落账。 */
export interface QuotaDeduction {
  requestId: string
  copyId: string
  amount: number
  status: 'reserved' | 'settled'
  createdAt: string
  settledAt?: string
  note: string
}

export type ControlledCopyStatus = 'active' | 'invalidated' | 'sealed'

export interface ControlledCopy {
  id: string
  packageId: string
  round: number
  status: ControlledCopyStatus
  createdAt: string
  invalidatedAt?: string
  invalidateReason?: string
  sealedAt?: string
  sealedBy?: string
  /** 发起时钉住的申报事实：声明、收件方、最终用途等。 */
  declarations: string[]
  recipient: string
  destination: string
  endUse: string
  technologyTags: string[]
  personnelScopes: string[]
  /** 发起时收拢的现行页与脱敏结论。 */
  files: ControlledFileSnapshot[]
  /** 发起时的许可额度占用量，核销始终按此副本计算。 */
  quotaSnapshot: {
    used: number
    limit: number
    reserved: number
  }
  /** 该副本上的许可核销账本；核销失败后按原副本重试，不重复扣额度。 */
  deductions: QuotaDeduction[]
}

/** 已成功处理过的幂等请求，重复回放直接回放原结果而不再次执行。 */
export interface ProcessedRequest {
  requestId: string
  url: string
  replayed: number
  createdAt: string
}

export interface PackageVersion {
  id: string
  label: string
  createdAt: string
  createdBy: string
  summary: string
  snapshot: {
    title: string
    category: MaterialCategory
    destination: string
    endUse: string
    technologyTags: string[]
    personnelScopes: string[]
    declarations: string[]
    activeFileVersions: Record<string, string>
  }
}

export interface ReviewComment {
  id: string
  packageId: string
  author: string
  content: string
  createdAt: string
  round: number
}

export interface MaterialPackage {
  id: string
  code: string
  title: string
  category: MaterialCategory
  applicant: string
  recipient: string
  destination: string
  endUse: string
  technologyTags: string[]
  personnelScopes: string[]
  declarations: string[]
  status: PackageStatus
  matchedRuleId?: string
  approvalRoute: ApprovalStep[]
  /** 当前生效的受控副本；原件失效后随副本进入待复核。 */
  activeCopyId?: string
  currentRound: number
  quotaUsed: number
  /** 已预占未落账的额度，计入占用但不重复扣减。 */
  quotaReserved: number
  quotaLimit: number
  createdAt: string
  updatedAt: string
  versions: PackageVersion[]
}

export interface LicenseRule {
  id: string
  name: string
  categories: MaterialCategory[]
  destinations: string[]
  technologyTags: string[]
  personnelScopes: string[]
  requiredDeclarations: string[]
  approvalLevel: ApprovalLevel
  quotaLimit: number
  explanation: string
}

export interface ValidationFinding {
  id: string
  packageId: string
  type: FindingType
  level: FindingLevel
  message: string
  action: string
  ruleId?: string
}

export interface AuditEntry {
  id: string
  packageId?: string
  action: string
  target: string
  operator: string
  detail: string
  createdAt: string
}

export interface WorkspaceState {
  packages: MaterialPackage[]
  files: MaterialFile[]
  rules: LicenseRule[]
  findings: ValidationFinding[]
  comments: ReviewComment[]
  audit: AuditEntry[]
  controlledCopies: ControlledCopy[]
  /** 乐观并发版本：每次提交自增，提交时携带期望值，不一致则 409。 */
  revision: number
  processedRequests: ProcessedRequest[]
}

export interface VersionDiff {
  id: string
  field: string
  before: string
  after: string
  kind: 'package' | 'file'
}
