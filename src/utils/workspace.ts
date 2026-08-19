import { CopilotAPI } from '@/lib/copilot/CopilotAPI'
import type { WorkspaceResponse } from '@/lib/copilot/types'
import { getAssemblyTokenPayload } from '@/lib/copilot/utils'

export const getWorkspaceLabel = (
  workspace: WorkspaceResponse,
  key: keyof NonNullable<WorkspaceResponse['labels']>,
) => {
  return {
    individualTerm: workspace.labels?.individualTerm?.toLowerCase() || 'client',
    individualTermPlural: workspace.labels?.individualTermPlural?.toLowerCase() || 'clients',
    groupTerm: workspace.labels?.groupTerm?.toLowerCase() || 'company',
    groupTermPlural: workspace.labels?.groupTermPlural?.toLowerCase() || 'companies',
  }[key]
}

export async function getWorkspace(token: string): Promise<WorkspaceResponse> {
  const tokenPayload = await getAssemblyTokenPayload(token)
  if (!tokenPayload) {
    throw new Error('Unable to decode Copilot token payload')
  }

  const copilot = new CopilotAPI(tokenPayload.workspaceId)
  return await copilot.getWorkspace()
}
