import { HttpResponse, http } from 'msw'
import { DROPBOX_RPC_HOST } from '../hosts'

// The SDK refreshes the token before every rpc call, so answer it here.
const oauthToken = http.post(`${DROPBOX_RPC_HOST}/oauth2/token`, () =>
  HttpResponse.json({
    access_token: 'test-access-token',
    token_type: 'bearer',
    expires_in: 14400,
  }),
)

// Empty folder by default. Override with paginateDropboxListFolder / mockDropboxRpc.
const listFolder = http.post(`${DROPBOX_RPC_HOST}/2/files/list_folder`, () =>
  HttpResponse.json({ entries: [], cursor: 'end', has_more: false }),
)
const listFolderContinue = http.post(`${DROPBOX_RPC_HOST}/2/files/list_folder/continue`, () =>
  HttpResponse.json({ entries: [], cursor: 'end', has_more: false }),
)

export const dropboxBaseHandlers = [oauthToken, listFolder, listFolderContinue]
