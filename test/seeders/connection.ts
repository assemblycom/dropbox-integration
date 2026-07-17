import type { InferSelectModel } from 'drizzle-orm'
import { Factory } from 'fishery'
import db from '@/db'
import {
  type DropboxConnectionInsertPayload,
  dropboxConnections,
} from '@/db/schema/dropboxConnections.schema'
import { nextSeq, seqUuid } from '../factories/sequence'

type ConnectionRow = InferSelectModel<typeof dropboxConnections>

export const dropboxConnectionSeeder = Factory.define<
  DropboxConnectionInsertPayload,
  Record<string, never>,
  ConnectionRow
>(({ onCreate }) => {
  const n = nextSeq()
  onCreate(async (values) => {
    const [row] = await db.insert(dropboxConnections).values(values).returning()
    return row
  })
  return {
    portalId: `portal-${n}`,
    accountId: `acc-${n}`,
    refreshToken: `rt-${n}`,
    rootNamespaceId: `ns-${n}`,
    initiatedBy: seqUuid(n),
    status: true,
  }
})
