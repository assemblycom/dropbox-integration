import { DropboxResponseError } from 'dropbox'
import httpStatus from 'http-status'
import { type NextRequest, NextResponse } from 'next/server'
import z, { ZodError } from 'zod'
import APIError from '@/errors/APIError'
import type { StatusableError } from '@/errors/BaseServerError'
import logger from '@/lib/logger'

type RequestHandler = (req: NextRequest, params: unknown) => Promise<NextResponse>

/**
 * Reusable utility that wraps a given request handler with a global error handler to standardize response structure
 * in case of failures. Catches exceptions thrown from the handler, and returns a formatted error response.
 *
 * @param {RequestHandler} handler - The request handler to wrap.
 * @returns {RequestHandler} The new handler that includes error handling logic.
 * @example
 * const safeHandler = withErrorHandler(async (req: NextRequest) => {
 *   // your request handling logic
 *   if (errorCondition) {
 *     throw new Error("Oh no!")}
 *   return NextResponse.next();
 * });
 *
 * @throws {ZodError} Captures and handles validation errors and responds with status 400 and the issue detail.
 * @throws {APIError} Captures and handles APIError
 */
export const withErrorHandler = (handler: RequestHandler): RequestHandler => {
  return async (req: NextRequest, params: unknown) => {
    // Execute the handler wrapped in a try... catch block
    try {
      return await handler(req, params)
    } catch (error: unknown) {
      // Build error API response and log error
      let status: number = (error as StatusableError).status || httpStatus.INTERNAL_SERVER_ERROR
      let message = 'Something went wrong'

      // Build a proper response based on the type of Error encountered
      if (error instanceof ZodError) {
        status = httpStatus.UNPROCESSABLE_ENTITY
        message = z.prettifyError(error)
        logger.error('ZodError: ', z.prettifyError(error), '\n', error)
      } else if (error instanceof APIError) {
        status = error.status
        message = error.message || message
        if (status === httpStatus.OK) {
          logger.info('The API threw an OK short return:', error.error || error.message)
        } else {
          logger.error('APIError:', error.error || error.message)
        }
      } else if (error instanceof DropboxResponseError) {
        // Must precede the generic Error branch: DropboxResponseError extends Error
        // with a truthy message, so checking Error first would hide error_summary.
        message = error.error.error_summary || `DropboxResponseError: ${message}`
        status = error.status

        logger.error('DropboxResponseError:', error.error)
      } else if (error instanceof Error && error.message) {
        message = error.message
        logger.error('Error:', error)
      } else {
        message = 'Something went wrong'
        logger.error(error)
      }

      return NextResponse.json({ error: message }, { status })
    }
  }
}
