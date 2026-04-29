// import * as Sentry from '@sentry/nextjs'

import Sentry from '@sentry/nextjs'
import { DropboxResponseError } from 'dropbox'
import httpStatus from 'http-status'
import pRetry from 'p-retry'
import type { StatusableError } from '@/errors/BaseServerError'
import { sleep } from '@/utils/sleep'

const RETRYABLE_STATUS_CODES = new Set<number>([
  httpStatus.TOO_MANY_REQUESTS,
  httpStatus.INTERNAL_SERVER_ERROR,
  httpStatus.BAD_GATEWAY,
  httpStatus.SERVICE_UNAVAILABLE,
  httpStatus.GATEWAY_TIMEOUT,
])

export const withRetry = async <Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
  args: Args,
  opts?: {
    minTimeout: number
    maxTimeout: number
  },
): Promise<R> => {
  let isEventProcessorRegistered = false

  return await pRetry(
    async () => {
      try {
        return await fn(...args)
      } catch (error: unknown) {
        // dropbox specific error and retry handling
        if (error instanceof DropboxResponseError) {
          const retryTime = error.headers.get('retry-after')
          const retryAfter = retryTime ? parseInt(retryTime, 10) : undefined

          if (error.status === httpStatus.TOO_MANY_REQUESTS && retryAfter) {
            // If rate limit happens with retryAfter value from dropbox api. Wait
            const waitMs = retryAfter * 1000
            console.warn(`Rate limited. Waiting for ${retryAfter} seconds before retry...`)
            await sleep(waitMs)
          }
        }

        // Hopefully now sentry doesn't report retry errors as well. We have enough triage issues as it is
        Sentry.withScope((scope) => {
          if (isEventProcessorRegistered) return
          isEventProcessorRegistered = true
          scope.addEventProcessor((event) => {
            if (
              event.level === 'error' &&
              event.message &&
              event.message.includes('An error occurred during retry')
            ) {
              return null // Discard the event as it occured during retry
            }
            return event
          })
        })
        // Rethrow the error so pRetry can retry
        throw error
      }
    },

    {
      retries: 3,
      minTimeout: opts?.minTimeout ?? 500,
      maxTimeout: opts?.maxTimeout ?? 2000,
      factor: 2, // Exponential factor for timeout delay. Tweak this if issues still persist

      onFailedAttempt: (error: { error: unknown; attemptNumber: number; retriesLeft: number }) => {
        if (error.error instanceof DropboxResponseError) {
          if (!RETRYABLE_STATUS_CODES.has(error.error.status)) return
        } else if (!RETRYABLE_STATUS_CODES.has((error.error as StatusableError).status)) {
          return
        }
        console.warn(
          `CopilotAPI#withRetry | Attempt ${error.attemptNumber} failed. There are ${error.retriesLeft} retries left. Error:`,
          error,
        )
      },
      shouldRetry: (error: { error: unknown; attemptNumber: number; retriesLeft: number }) => {
        if (error.error instanceof DropboxResponseError) {
          return RETRYABLE_STATUS_CODES.has(error.error.status)
        }

        // Typecasting because Copilot doesn't export an error class
        return RETRYABLE_STATUS_CODES.has((error.error as StatusableError).status)
      },
    },
  )
}
