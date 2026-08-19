import { z } from 'zod'
import { ObjectType } from '@/db/constants'

// Schema for hex color codes
export const HexColorSchema = z
  .string()
  .refine((val) => /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(val), {
    message: 'Invalid hex color code',
  })

// List arguments supported by Copilot API
export type CopilotListArgs = {
  limit?: number
  nextToken?: string
}

// Schema for decrypted Copilot tokens
export const TokenSchema = z.object({
  internalUserId: z.uuid().optional(),
  workspaceId: z.string().min(1),
})
export type Token = z.infer<typeof TokenSchema>

// Response schema for `/workspace` endpoint
export const WorkspaceResponseSchema = z.object({
  id: z.string(),
  brandName: z.string().optional(),
  labels: z
    .object({
      individualTerm: z.string().optional(),
      individualTermPlural: z.string().optional(),
      groupTerm: z.string().optional(),
      groupTermPlural: z.string().optional(),
    })
    .optional(),
  portalUrl: z.string(),
})
export type WorkspaceResponse = z.infer<typeof WorkspaceResponseSchema>

export const ClientResponseSchema = z.object({
  id: z.string(),
  givenName: z.string(),
  familyName: z.string(),
  email: z.string(),
  companyId: z.string(),
  companyIds: z.array(z.uuid()).optional(),
  status: z.string(),
  avatarImageUrl: z.string().nullable(),
  fallbackColor: z.string().nullish(),
  createdAt: z.iso.datetime(),
})
export type ClientResponse = z.infer<typeof ClientResponseSchema>

export const ClientsResponseSchema = z.object({
  data: z.array(ClientResponseSchema).nullable(),
})
export type ClientsResponse = z.infer<typeof ClientsResponseSchema>

export const CompanyResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  iconImageUrl: z.string().nullable(),
  fallbackColor: z.string().nullish(),
  isPlaceholder: z.boolean(),
  createdAt: z.iso.datetime(),
})
export type CompanyResponse = z.infer<typeof CompanyResponseSchema>

export const CompaniesResponseSchema = z.object({
  data: z.array(CompanyResponseSchema).nullable(),
})
export type CompaniesResponse = z.infer<typeof CompaniesResponseSchema>

// Request schema for `/company` endpoint
export const CompanyCreateRequestSchema = z.object({
  name: z.string(),
  iconImageUrl: z.string().optional(),
  fallbackColor: HexColorSchema.optional(),
})
export type CompanyCreateRequest = z.infer<typeof CompanyCreateRequestSchema>

export const ClientRequestSchema = z.object({
  givenName: z.string(),
  familyName: z.string(),
  email: z.email(),
  companyId: z.uuid().optional(),
})
export type ClientRequest = z.infer<typeof ClientRequestSchema>

export const InternalUserSchema = z.object({
  id: z.uuid(),
  givenName: z.string(),
  familyName: z.string(),
  email: z.union([z.email(), z.literal('')]), // Deleted IUs can be queried, but have no email
  avatarImageUrl: z.string().optional(),
  isClientAccessLimited: z.boolean().default(false),
  companyAccessList: z.array(z.string()).nullable(),
  fallbackColor: z.string().nullish(),
  createdAt: z.iso.datetime(),
})
export type InternalUser = z.infer<typeof InternalUserSchema>

export const InternalUsersResponseSchema = z.object({
  data: z.array(InternalUserSchema),
})
export type InternalUsersResponse = z.infer<typeof InternalUsersResponseSchema>

export const CopilotProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
})
export type CopilotProduct = z.infer<typeof CopilotProductSchema>

export const CopilotPriceSchema = z.object({
  id: z.string(),
  amount: z.number().nonnegative(),
  currency: z.string(),
  productId: z.string(),
})
export type CopilotPrice = z.infer<typeof CopilotPriceSchema>

export const CopilotFileCreateSchema = z.object({
  channelId: z.string(),
  id: z.string(),
  name: z.string(),
  object: z.string(),
  path: z.string(),
  status: z.string().optional(),
  uploadUrl: z.string().optional(),
})
export type CreateFileType = z.infer<typeof CopilotFileCreateSchema>

export const CopilotFileRetrieveSchema = z.object({
  id: z.uuid(),
  channelId: z.string(),
  name: z.string(),
  object: z.string(),
  path: z.string(),
  status: z.string().optional(),
  downloadUrl: z.string().optional(),
  previousAttributes: z
    .object({
      name: z.string().optional(),
    })
    .optional(),
  createdAt: z.string().optional(),
})
export type CopilotFileRetrieve = z.infer<typeof CopilotFileRetrieveSchema>

export const CopilotFileWithObjectSchema = CopilotFileRetrieveSchema.extend({
  object: z.enum(Object.values(ObjectType) as [ObjectType.FILE, ObjectType.FOLDER]),
})

export const CopilotFileListSchema = z.object({
  data: z.array(CopilotFileRetrieveSchema),
  nextToken: z.string().optional(),
})
export type CopilotFileList = z.infer<typeof CopilotFileListSchema>

export const UserCompanySelectorObject = {
  COMPANY: 'company',
  CLIENT: 'client',
  INTERNAL_USER: 'internalUser',
} as const

const UserCompanySelectorObjectSchema = z.enum(Object.values(UserCompanySelectorObject))
export type UserCompanySelectorObjectType = z.infer<typeof UserCompanySelectorObjectSchema>

export type UserCompanySelectorInputValue = {
  id: string
  companyId: string
  object: UserCompanySelectorObjectType
}

export enum FileChannelMembership {
  GROUP = 'group',
  INDIVIDUAL = 'individual',
  COMPANY = 'company',
}

const FileChannelMembershipTypeSchema = z.enum(Object.values(FileChannelMembership))
export type FileChannelMembershipType = z.infer<typeof FileChannelMembershipTypeSchema>

export const CopilotFileChannelRetrieveSchema = z.object({
  id: z.string(),
  membershipType: FileChannelMembershipTypeSchema,
  clientId: z.string().optional(),
  companyId: z.string().optional(),
  memberIds: z.array(z.string()).nullable(),
})
export type CopilotFileChannelRetrieve = z.infer<typeof CopilotFileChannelRetrieveSchema>

export const CopilotFileChannelListSchema = z.array(CopilotFileChannelRetrieveSchema)
export type CopilotFileChannelList = z.infer<typeof CopilotFileChannelListSchema>
