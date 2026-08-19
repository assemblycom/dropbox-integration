import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CopilotAPI } from '@/lib/copilot/CopilotAPI'
import type { WorkspaceResponse } from '@/lib/copilot/types'
import { getAssemblyTokenPayload } from '@/lib/copilot/utils'
import { getWorkspace, getWorkspaceLabel } from '@/utils/workspace'

vi.mock('@/lib/copilot/CopilotAPI', () => {
  const workspace: WorkspaceResponse = {
    id: 'ws_1',
    brandName: 'Test',
    portalUrl: 'https://example.com',
    labels: {
      individualTerm: 'Patient',
      individualTermPlural: 'Patients',
      groupTerm: 'Org',
      groupTermPlural: 'Orgs',
    },
  }

  return {
    CopilotAPI: vi.fn(function Mock() {
      return { getWorkspace: vi.fn().mockResolvedValue(workspace) }
    }),
  }
})

// Mock the decode so the test never loads the real Assembly SDK.
vi.mock('@/lib/copilot/utils', () => ({
  getAssemblyTokenPayload: vi.fn().mockResolvedValue({ workspaceId: 'ws_1' }),
}))

function makeWorkspace(overrides?: Partial<WorkspaceResponse>): WorkspaceResponse {
  return { id: 'ws_1', portalUrl: '', ...overrides }
}

describe('getWorkspaceLabel', () => {
  const labels = {
    individualTerm: 'Patient',
    individualTermPlural: 'Patients',
    groupTerm: 'Org',
    groupTermPlural: 'Orgs',
  } as const

  it.each([
    { key: 'individualTerm', expected: 'patient' },
    { key: 'individualTermPlural', expected: 'patients' },
    { key: 'groupTerm', expected: 'org' },
    { key: 'groupTermPlural', expected: 'orgs' },
  ] as const)('lowercases $key', ({ key, expected }) => {
    expect(getWorkspaceLabel(makeWorkspace({ labels }), key)).toBe(expected)
  })

  it.each([
    { key: 'individualTerm', expected: 'client' },
    { key: 'individualTermPlural', expected: 'clients' },
    { key: 'groupTerm', expected: 'company' },
    { key: 'groupTermPlural', expected: 'companies' },
  ] as const)('falls back to "$expected" when $key is missing', ({ key, expected }) => {
    expect(getWorkspaceLabel(makeWorkspace(), key)).toBe(expected)
  })

  it('passes already-lowercase input through unchanged', () => {
    expect(
      getWorkspaceLabel(makeWorkspace({ labels: { groupTerm: 'company' } }), 'groupTerm'),
    ).toBe('company')
  })
})

describe('getWorkspace', () => {
  beforeEach(() => {
    vi.mocked(getAssemblyTokenPayload).mockResolvedValue({ workspaceId: 'ws_1' })
  })

  it('returns the result from copilot.getWorkspace()', async () => {
    const result = await getWorkspace('token-123')
    expect(result.id).toBe('ws_1')
    expect(result.brandName).toBe('Test')
    expect(result.portalUrl).toBe('https://example.com')
  })

  it('constructs CopilotAPI with the decoded workspaceId, not the raw token', async () => {
    await getWorkspace('token-xyz')
    expect(getAssemblyTokenPayload).toHaveBeenCalledWith('token-xyz')
    expect(CopilotAPI).toHaveBeenCalledWith('ws_1')
  })

  it('throws when the token payload cannot be decoded', async () => {
    vi.mocked(getAssemblyTokenPayload).mockResolvedValueOnce(null)
    await expect(getWorkspace('bad-token')).rejects.toThrow(
      'Unable to decode Copilot token payload',
    )
  })
})
