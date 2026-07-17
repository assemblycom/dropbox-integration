import { eq, type InferSelectModel } from 'drizzle-orm'
import { Factory } from 'fishery'
import db from '@/db'
import { type ChannelSyncCreateType, channelSync } from '@/db/schema/channelSync.schema'
import { dropboxConnections } from '@/db/schema/dropboxConnections.schema'
import { nextSeq } from '../factories/sequence'
import { dropboxConnectionSeeder } from './connection'

type ChannelRow = InferSelectModel<typeof channelSync>

// portalId/dbxAccountId are optional at the seed layer: when omitted we mint a
// connection and inherit its identity, so the channel and connection agree.
type ChannelSeed = Omit<ChannelSyncCreateType, 'portalId' | 'dbxAccountId'> & {
  portalId?: string
  dbxAccountId?: string
}

export const channelSeeder = Factory.define<ChannelSeed, Record<string, never>, ChannelRow>(
  ({ onCreate }) => {
    const n = nextSeq()
    onCreate(async (values) => {
      const { portalId: pid, dbxAccountId: aid, ...rest } = values
      let portalId = pid
      let dbxAccountId = aid
      if (dbxAccountId && !portalId) {
        throw new Error(
          'channelSeeder: supply portalId when specifying dbxAccountId (a dbxAccountId alone cannot resolve a connection)',
        )
      } else if (!portalId) {
        const conn = await dropboxConnectionSeeder.create()
        portalId = conn.portalId
        dbxAccountId = conn.accountId ?? undefined
      } else if (!dbxAccountId) {
        // portalId is globally unique, so find-or-create the connection for it.
        const [existing] = await db
          .select({ accountId: dropboxConnections.accountId })
          .from(dropboxConnections)
          .where(eq(dropboxConnections.portalId, portalId))
        dbxAccountId = existing
          ? (existing.accountId ?? `acc-${n}`)
          : ((await dropboxConnectionSeeder.create({ portalId })).accountId ?? `acc-${n}`)
      }
      if (!dbxAccountId) {
        // Unreachable: dropboxConnectionSeeder always defaults accountId.
        throw new Error('channelSeeder: could not resolve dbxAccountId')
      }
      const [row] = await db
        .insert(channelSync)
        .values({ ...rest, portalId, dbxAccountId })
        .returning()
      return row
    })
    return {
      assemblyChannelId: `ch-${n}`,
      dbxRootPath: '/root',
      status: true,
    }
  },
)
