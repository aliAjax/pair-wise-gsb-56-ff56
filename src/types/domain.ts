export type MaterialCategory = 'drawing' | 'technical' | 'software'
export type PackageStatus =
  | 'draft'
  | 'validating'
  | 'reviewing'
  | 'returned'
  | 'stale'
  | 'approved'
  | 'licensed'
  | 'locked'
export type ApprovalLevel = 'standard' | 'enhanced' | 'senior'
export type FindingLevel = 'high' | 'medium' | 'low'
export type FindingType =
  | 'missing-declaration'
  | 'escalation'
  | 'version-mismatch'
  | 'unclassified-page'
  | 'desensitization'
  | 'quota'

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

export type ApprovalStepStatus = 'waiting' | 'active' | 'approved' | 'returned' | 'invalid'

export interface ApprovalStep {
  id: string
  order: number
  role: string
  assignee: string
  level: ApprovalLevel
  status: ApprovalStepStatus
  comment: string
  decidedAt?: string
  copyId?: string
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

export interface ControlledFileSnapshot {
  fileId: string
  name: string
  kind: MaterialCategory
  versionId: string
  label: string
  hash: string
  uploadedAt: string
  sizeKb: number
  pages: PageReview[]
}

export interface ControlledPackageSnapshot {
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
}

export interface ControlledQuotaSnapshot {
  used: number
  limit: number
  available: number
}

export type ControlledCopyStatus =
  | 'active'
  | 'invalid'
  | 'returned'
  | 'signed'
  | 'writeoff_failed'
  | 'licensed'

export interface ControlledSignature {
  requestId: string
  stepId: string
  role: string
  signer: string
  decision: 'approve' | 'return'
  comment: string
  signedAt: string
}

export interface ControlledWriteoff {
  requestId: string
  amount: number
  status: 'reserved' | 'failed' | 'completed'
  reservedAt: string
  lastAttemptAt: string
  completedAt?: string
  failureReason?: string
}

export interface ControlledCopy {
  id: string
  packageId: string
  round: number
  ruleId: string
  status: ControlledCopyStatus
  createdBy: string
  createdAt: string
  invalidatedAt?: string
  invalidationReason?: string
  sourceFingerprint: string
  packageSnapshot: ControlledPackageSnapshot
  declarations: string[]
  files: ControlledFileSnapshot[]
  quota: ControlledQuotaSnapshot
  signatures: ControlledSignature[]
  writeoff?: ControlledWriteoff
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
  activeControlledCopyId?: string
  approvalRoute: ApprovalStep[]
  currentRound: number
  quotaUsed: number
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
  controlledCopies: ControlledCopy[]
  findings: ValidationFinding[]
  comments: ReviewComment[]
  audit: AuditEntry[]
}

export interface VersionDiff {
  id: string
  field: string
  before: string
  after: string
  kind: 'package' | 'file'
}
