import crypto from 'node:crypto'
import * as Sentry from '@sentry/nextjs'
import status from 'http-status'
import { after, type NextRequest, NextResponse } from 'next/server'
import env from '@/config/server.env'
import { DropboxWebhook } from '@/features/webhook/dropbox/lib/webhook.service'
import { sleep } from '@/utils/sleep'

export const handleWebhookUrlVerification = (req: NextRequest) => {
  try {
    const challenge = req.nextUrl.searchParams.get('challenge')
    return new NextResponse(challenge, {
      status: status.OK,
      headers: {
        'Content-Type': 'text/plain',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error: unknown) {
    console.error('Webhook verification error:', error)
    return NextResponse.json(
      { error: 'Something went wrong' },
      { status: status.INTERNAL_SERVER_ERROR },
    )
  }
}

export const handleWebhookEvents = async (req: NextRequest) => {
  const signature = req.headers.get('X-Dropbox-Signature')
  if (!signature)
    return NextResponse.json({ error: 'Missing signature' }, { status: status.BAD_REQUEST })

  const body = await req.text()

  const computedSignature = crypto
    .createHmac('sha256', env.DROPBOX_APP_SECRET)
    .update(body)
    .digest('hex')

  // Validate webhook signature
  const valid = crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(computedSignature, 'hex'),
  )
  if (!valid) return NextResponse.json({ error: 'Invalid signature' }, { status: status.FORBIDDEN })

  const { list_folder } = JSON.parse(body)
  const accounts = list_folder?.accounts ?? []

  // Reply to Dropbox first, then process in the background so the check doesn't slow the reply.
  after(async () => {
    try {
      await sleep(800) // let our own writes settle first
      await new DropboxWebhook().handleDropboxEvents(accounts)
    } catch (error) {
      // Dropbox already got its 200, so it won't retry — report so this is visible.
      console.error('Dropbox webhook :: background processing failed', { accounts }, error)
      Sentry.captureException(error)
    }
  })

  // Dropbox expects a 200 OK with plain text body
  return new NextResponse('', {
    status: status.OK,
    headers: {
      'Content-Type': 'text/plain',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
