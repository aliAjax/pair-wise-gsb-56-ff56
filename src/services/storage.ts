import type { WorkspaceState } from '@/types/domain'
import { createInitialState } from './mockData'

const STORAGE_KEY = 'export-control-review-v2'

export function loadWorkspace(): WorkspaceState {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const initial = createInitialState()
    saveWorkspace(initial)
    return initial
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceState>
    // v2 引入受控副本、乐观版本号与幂等账本；旧数据直接重置，避免半结构状态。
    if (
      !Array.isArray(parsed.controlledCopies) ||
      typeof parsed.revision !== 'number' ||
      !Array.isArray(parsed.processedRequests)
    ) {
      const initial = createInitialState()
      saveWorkspace(initial)
      return initial
    }
    return parsed as WorkspaceState
  } catch {
    const initial = createInitialState()
    saveWorkspace(initial)
    return initial
  }
}

export function saveWorkspace(state: WorkspaceState): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function resetWorkspace(): WorkspaceState {
  const initial = createInitialState()
  saveWorkspace(initial)
  return initial
}
