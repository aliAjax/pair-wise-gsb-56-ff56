import type {
  ApprovalStep,
  ControlledCopy,
  ControlledCopyStatus,
  FileVersion,
  LicenseRule,
  MaterialFile,
  MaterialPackage,
} from '@/types/domain'

function stableClone<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

function simpleHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `fp-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

const fingerprintFields: (keyof MaterialPackage)[] = [
  'code',
  'title',
  'category',
  'applicant',
  'recipient',
  'destination',
  'endUse',
  'technologyTags',
  'personnelScopes',
  'declarations',
  'quotaUsed',
  'quotaLimit',
]

function resolveVersion(file: MaterialFile, preferredVersionId?: string): FileVersion | undefined {
  return (
    file.versions.find((version) => version.id === preferredVersionId) ??
    file.versions.find((version) => version.id === file.activeVersionId) ??
    file.versions.find((version) => version.id === file.referencedVersionId) ??
    file.versions[0]
  )
}

export function fingerprintSource(
  packageItem: MaterialPackage,
  files: MaterialFile[],
  preferredVersions: Record<string, string> = {},
): string {
  const source = {
    package: Object.fromEntries(
      fingerprintFields.map((field) => [field, stableClone(packageItem[field])]),
    ),
    files: files
      .filter((file) => file.packageId === packageItem.id)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((file) => {
        const version = resolveVersion(file, preferredVersions[file.id])
        return {
          fileId: file.id,
          name: file.name,
          kind: file.kind,
          versionId: version?.id,
          label: version?.label,
          hash: version?.hash,
          uploadedAt: version?.uploadedAt,
          sizeKb: version?.sizeKb,
          pages: version?.pages
            ?.map((page) => ({
              page: page.page,
              category: page.category,
              controlled: page.controlled,
              desensitized: page.desensitized,
              note: page.note,
              reviewer: page.reviewer,
              reviewedAt: page.reviewedAt,
            }))
            .sort((left, right) => left.page - right.page),
        }
      }),
  }
  return simpleHash(canonical(source))
}

interface CreateControlledCopyOptions {
  rule: LicenseRule
  createdBy?: string
  createdAt?: string
  id?: string
  status?: ControlledCopyStatus
  preferredVersions?: Record<string, string>
}

export function createControlledCopy(
  packageItem: MaterialPackage,
  files: MaterialFile[],
  options: CreateControlledCopyOptions,
): ControlledCopy {
  const createdAt = options.createdAt ?? new Date().toISOString()
  const packageFiles = files
    .filter((file) => file.packageId === packageItem.id)
    .sort((left, right) => left.name.localeCompare(right.name))

  if (!packageFiles.length) {
    throw new Error('至少拆解并核对一个资料文件后才能收拢受控副本')
  }

  const copyFiles = packageFiles.map((file) => {
    const version = resolveVersion(file, options.preferredVersions?.[file.id])
    if (!version) throw new Error(`${file.name} 缺少可引用的文件版本`)
    return {
      fileId: file.id,
      name: file.name,
      kind: file.kind,
      versionId: version.id,
      label: version.label,
      hash: version.hash,
      uploadedAt: version.uploadedAt,
      sizeKb: version.sizeKb,
      pages: stableClone(version.pages),
    }
  })

  const copyId = options.id ?? `copy-${crypto.randomUUID()}`

  return {
    id: copyId,
    packageId: packageItem.id,
    round: packageItem.currentRound,
    ruleId: options.rule.id,
    status: options.status ?? 'active',
    createdBy: options.createdBy ?? packageItem.applicant,
    createdAt,
    sourceFingerprint: fingerprintSource(packageItem, files, options.preferredVersions),
    packageSnapshot: {
      code: packageItem.code,
      title: packageItem.title,
      category: packageItem.category,
      applicant: packageItem.applicant,
      recipient: packageItem.recipient,
      destination: packageItem.destination,
      endUse: packageItem.endUse,
      technologyTags: stableClone(packageItem.technologyTags),
      personnelScopes: stableClone(packageItem.personnelScopes),
      declarations: stableClone(packageItem.declarations),
    },
    declarations: stableClone(packageItem.declarations),
    files: copyFiles,
    quota: {
      used: packageItem.quotaUsed,
      limit: options.rule.quotaLimit,
      available: options.rule.quotaLimit - packageItem.quotaUsed,
    },
    signatures: [],
  }
}

export function attachCopyToRoute(copy: ControlledCopy, route: ApprovalStep[]): ApprovalStep[] {
  return route.map((step) => ({ ...step, copyId: copy.id }))
}

export function invalidateActiveCopies(
  packageItem: MaterialPackage,
  copies: ControlledCopy[],
  files: MaterialFile[],
  reason: string,
  invalidatedAt = new Date().toISOString(),
): ControlledCopy[] {
  const currentFingerprint = fingerprintSource(packageItem, files)
  return copies.map((copy) => {
    if (copy.packageId !== packageItem.id || copy.status !== 'active') return copy
    if (copy.sourceFingerprint !== currentFingerprint) {
      return {
        ...copy,
        status: 'invalid',
        invalidatedAt,
        invalidationReason: reason,
      }
    }
    return copy
  })
}

export function isCopyCurrent(
  copy: ControlledCopy,
  packageItem: MaterialPackage,
  files: MaterialFile[],
): boolean {
  return copy.sourceFingerprint === fingerprintSource(packageItem, files)
}

export const controlledCopyStatusLabels: Record<ControlledCopyStatus, string> = {
  active: '有效',
  invalid: '已失效待复核',
  returned: '已退回',
  signed: '已签署',
  writeoff_failed: '核销失败待重试',
  licensed: '已核销',
}
