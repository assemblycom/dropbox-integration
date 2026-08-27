import {
  handleWebhookEvents,
  handleWebhookUrlVerification,
} from '@/features/webhook/dropbox/api/webhook.controller'
import { withErrorHandler } from '@/utils/withErrorHandler'

// Background processing runs in after(), which Vercel bounds by maxDuration.
export const maxDuration = 300

/**
 * not used withErrorHander() as this is a sync function and has included its separate try catch block
 */
export const GET = handleWebhookUrlVerification
export const POST = withErrorHandler(handleWebhookEvents)
