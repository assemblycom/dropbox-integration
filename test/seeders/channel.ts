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
        // portalId is globally unique, so find-or-create the connection for it,
        // then adopt ITS accountId — never invent one. A fabricated account
        // would match neither the connection nor the real Dropbox account OAuth
        // later records, so webhook/update paths filtered by dbxAccountId would
        // miss this channel. If the existing connection has no accountId yet
        // (pre-OAuth), fail loudly instead of seeding that drift.
        const [existing] = await db
          .select({ accountId: dropboxConnections.accountId })
          .from(dropboxConnections)
          .where(eq(dropboxConnections.portalId, portalId))
        const conn = existing ?? (await dropboxConnectionSeeder.create({ portalId }))
        if (!conn.accountId) {
          throw new Error(
            `channelSeeder: connection for portal ${portalId} has no accountId; set the connection's accountId or pass dbxAccountId explicitly`,
          )
        }
        dbxAccountId = conn.accountId
      } else {
        // Both portalId and dbxAccountId supplied: if a connection already exists
        // for this portal, the channel must use that connection's account. A
        // different explicit account detaches the channel from the real Dropbox
        // account, so account-filtered webhook/update reads would miss it. (No
        // connection for the portal → insert as-is, minting nothing.)
        const [existing] = await db
          .select({ accountId: dropboxConnections.accountId })
          .from(dropboxConnections)
          .where(eq(dropboxConnections.portalId, portalId))
        if (existing?.accountId && existing.accountId !== dbxAccountId) {
          throw new Error(
            `channelSeeder: dbxAccountId ${dbxAccountId} does not match the connection for portal ${portalId} (account ${existing.accountId})`,
          )
        }
      }
      if (!dbxAccountId) {
        // Reachable only if the neither-branch minted a connection whose
        // accountId was null; dropboxConnectionSeeder defaults it, so in
        // practice this never fires.
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
