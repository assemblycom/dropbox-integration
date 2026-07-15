import { type HttpResponseResolver, http } from 'msw'
import { COPILOT_HOST, DROPBOX_CONTENT_HOST, DROPBOX_RPC_HOST } from './hosts'
import { server } from './server'

// Per-test overrides on the right host. They win over base handlers and are
// cleared by resetHandlers() in afterEach.
export function mockDropboxRpc(path: string, resolver: HttpResponseResolver): void {
  server.use(http.post(`${DROPBOX_RPC_HOST}${path}`, resolver))
}

export function mockDropboxContent(path: string, resolver: HttpResponseResolver): void {
  // Content endpoints (download/upload) POST via node-fetch.
  server.use(http.post(`${DROPBOX_CONTENT_HOST}${path}`, resolver))
}

// Any msw HTTP verb — Copilot uses GET, DELETE, and PATCH/PUT.
type HttpMethod = keyof typeof http

export function mockCopilot(
  path: string,
  resolver: HttpResponseResolver,
  method: HttpMethod = 'get',
): void {
  server.use(http[method](`${COPILOT_HOST}${path}`, resolver))
}
