import crypto from 'node:crypto'
import status from 'http-status'
import { type NextRequest, NextResponse } from 'next/server'
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
  await sleep(800) // prevent ping-pong case of webhooks

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

  const dropboxWebhook = new DropboxWebhook()
  await dropboxWebhook.handleDropboxEvents(accounts)

  // Dropbox expects a 200 OK with plain text body
  return new NextResponse('', {
    status: status.OK,
    headers: {
      'Content-Type': 'text/plain',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
