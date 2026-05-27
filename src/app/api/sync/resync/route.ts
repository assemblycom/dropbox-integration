import { resyncChannelMapping } from '@/features/sync/api/sync.controller'
import { withErrorHandler } from '@/utils/withErrorHandler'

export const POST = withErrorHandler(resyncChannelMapping)
