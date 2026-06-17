import { handleWebhookEvent } from '@/features/webhook/assembly/api/webhook.controller'
import { withErrorHandler } from '@/utils/withErrorHandler'

export const maxDuration = 300 // 5 mins

export const POST = withErrorHandler(handleWebhookEvent)
