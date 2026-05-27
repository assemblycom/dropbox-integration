import type { SQL } from 'drizzle-orm'
import z from 'zod'
import type { ObjectTypeValue } from '@/db/constants'
import type { DropboxConnectionTokens } from '@/db/schema/dropboxConnections.schema'
import type User from '@/lib/copilot/models/User.model'
import type { CopilotFileRetrieve, UserCompanySelectorInputValue } from '@/lib/copilot/types'

export type WhereClause = SQL<unknown>

export const DropboxFileListFolderSingleEntrySchema = z.object({
  '.tag': z.string(),
  name: z.string(),
  path_display: z.string(),
  id: z.string(),
  is_downloadable: z.boolean().optional(),
  content_hash: z.string().optional(),
})
export type DropboxFileListFolderSingleEntry = z.infer<
  typeof DropboxFileListFolderSingleEntrySchema
>

export const DropboxFileListFolderResultEntriesSchema = z.array(
  DropboxFileListFolderSingleEntrySchema,
)
export type DropboxFileListFolderResultEntries = z.infer<
  typeof DropboxFileListFolderResultEntriesSchema
>

export type AdditionalSyncPayload = {
  dbxRootPath: string
  assemblyChannelId: string
  channelSyncId: string
  user: User
  connectionToken: DropboxConnectionTokens
}

export type DropboxToAssemblySyncFilesPayload = {
  entry: DropboxFileListFolderSingleEntry
  opts: AdditionalSyncPayload
}

export type AssemblyToDropboxSyncFilesPayload = {
  file: CopilotFileRetrieve & { object: ObjectTypeValue }
  opts: AdditionalSyncPayload
}

export type UserChannelType = 'client' | 'company'

export const ClientSchema = z.object({
  id: z.string(),
  givenName: z.string(),
  familyName: z.string(),
  email: z.string(),
  companyId: z.string().optional(),
  status: z.string(),
  avatarImageUrl: z.string().optional(),
  fallbackColor: z.string(),
  companyIds: z.array(z.string()),
})
export const ClientsResponseSchema = z.array(ClientSchema)
export type Client = z.infer<typeof ClientSchema> & { type: UserChannelType }

export const CompanySchema = z.object({
  id: z.string(),
  name: z.string(),
  iconImageUrl: z.string().optional(),
  fallbackColor: z.string().optional(),
})
export const CompaniesResponseSchema = z.array(CompanySchema)
export type Company = z.infer<typeof CompanySchema> & { type: UserChannelType }

export type UserClientsCompanies = {
  clients?: Omit<Client, 'type'>[]
  companies?: Omit<Company, 'type'>[]
}

export type UserClientsCompaniesWithType = {
  clients?: Client[]
  companies?: Company[]
}

export type SelectorValue = {
  value: string | null
  label: string
  avatarSrc?: string
  avatarFallbackColor?: string
  companyId?: string
  type: UserChannelType
  fileChannelId?: string
}

export type SelectorClientsCompanies = {
  clients?: SelectorValue[]
  companies?: SelectorValue[]
}

export type Folder = {
  path: string
  label: string
  children?: Folder[]
}

export const FileSyncCreateRequestSchema = z.object({
  fileChannelId: z.string(),
  dbxRootPath: z.string(),
})
export type FileSyncCreateRequestType = z.infer<typeof FileSyncCreateRequestSchema>

export const DropdownFileChannelSchema = z.object({
  value: z.string(),
  label: z.string(),
  avatarSrc: z.string().nullable(),
  fallbackColor: z.string().nullish(),
  companyId: z.string().nullable(),
})
export type DropdownFileChannel = z.infer<typeof DropdownFileChannelSchema>

export type MapList = {
  id?: string
  fileChannelValue: UserCompanySelectorInputValue[]
  dbxRootPath: string
  status: boolean | null
  fileChannelId: string
  lastSyncedAt: Date | null
  resyncingAt: Date | null
  syncedPercentage: number
  tempId?: string
}

export const UpdateConnectionStatusSchema = z.object({
  status: z.boolean(),
  assemblyChannelId: z.string().min(1),
  dbxRootPath: z.string().min(1),
})

export const RemoveChannelSyncSchema = z.object({
  channelSyncId: z.string(),
})

export const ResyncChannelRequestSchema = z.object({
  channelSyncId: z.uuid(),
})

export const TotalFilesCountRequestSchema = z.object({
  assemblyChannelId: z.string().min(1),
  dbxRootPath: z.string().min(1),
  limit: z.string().min(1).optional(),
})
