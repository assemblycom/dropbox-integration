import z from 'zod'
import { CopilotFileRetrieveSchema } from '@/lib/copilot/types'

export enum DISPATCHABLE_HANDLEABLE_EVENT {
  FileCreated = 'file.created',
  FileUpdated = 'file.updated',
  FileDeleted = 'file.deleted',
  FolderCreated = 'folder.created',
  FolderUpdated = 'folder.updated',
  FolderDeleted = 'folder.deleted',
}

export const AssemblyWebhookSchema = z.object({
  eventType: z.string(),
  created: z.string().optional(),
  data: CopilotFileRetrieveSchema,
})

export type AssemblyWebhookEvent = z.infer<typeof AssemblyWebhookSchema>
