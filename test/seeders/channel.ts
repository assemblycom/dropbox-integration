import { eq, type InferSelectModel } from 'drizzle-orm'
import { Factory } from 'fishery'
import db from '@/db'
import { type ChannelSyncCreateType, channelSync } from '@/db/schema/channelSync.schema'
import { dropboxConnections } from '@/db/schema/dropboxConnections.schema'
import { nextSeq } from '../factories/sequence'
import { dropboxConnectionSeeder } from './connection'

type ChannelRow = InferSelectModel<typeof channelSync>

// portalId/dbxAccountId optional: omit them to mint/adopt a connection so the
// channel and its connection agree on account.
type ChannelSeed = Omit<ChannelSyncCreateType, 'portalId' | 'dbxAccountId'> & {
  portalId?: string
  dbxAccountId?: string
}

// Single source of the invariant: a channel's dbxAccountId must equal its portal
// connection's account, and that account must exist. Resolves the (portalId,
// dbxAccountId) pair or throws — never seeds a channel detached from its account.
async function resolveChannelAccount(
  portalId: string | undefined,
  dbxAccountId: string | undefined,
): Promise<{ portalId: string; dbxAccountId: string }> {
  // A dbxAccountId alone can't resolve which connection/portal it belongs to.
  if (dbxAccountId && !portalId) {
    throw new Error(
      'channelSeeder: supply portalId when specifying dbxAccountId (a dbxAccountId alone cannot resolve a connection)',
    )
  }

  // Neither given: mint a fresh connection and adopt its identity.
  if (!portalId) {
    const conn = await dropboxConnectionSeeder.create()
    if (!conn.accountId) throw new Error('channelSeeder: minted connection has no accountId')
    return { portalId: conn.portalId, dbxAccountId: conn.accountId }
  }

  // portalId known: its connection (portalId is globally unique) is the account
  // source of truth.
  const [existing] = await db
    .select({ accountId: dropboxConnections.accountId })
    .from(dropboxConnections)
    .where(eq(dropboxConnections.portalId, portalId))

  // portalId alone: adopt the connection's account (find-or-create); throw if none.
  if (!dbxAccountId) {
    const conn = existing ?? (await dropboxConnectionSeeder.create({ portalId }))
    if (!conn.accountId) {
      throw new Error(
        `channelSeeder: connection for portal ${portalId} has no accountId; set the connection's accountId or pass dbxAccountId explicitly`,
      )
    }
    return { portalId, dbxAccountId: conn.accountId }
  }

  // Both given: any existing connection's account must be set and equal. No
  // connection for the portal → accept the explicit pair as-is (mint nothing).
  if (existing && existing.accountId !== dbxAccountId) {
    throw new Error(
      existing.accountId
        ? `channelSeeder: dbxAccountId ${dbxAccountId} does not match the connection for portal ${portalId} (account ${existing.accountId})`
        : `channelSeeder: connection for portal ${portalId} has no accountId yet; set it before seeding a channel with an explicit dbxAccountId`,
    )
  }
  return { portalId, dbxAccountId }
}

export const channelSeeder = Factory.define<ChannelSeed, Record<string, never>, ChannelRow>(
  ({ onCreate }) => {
    const n = nextSeq()
    onCreate(async (values) => {
      const { portalId: pid, dbxAccountId: aid, ...rest } = values
      const { portalId, dbxAccountId } = await resolveChannelAccount(pid, aid)
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
