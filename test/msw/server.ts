import { setupServer } from 'msw/node'
import { copilotBaseHandlers } from './handlers/copilot'
import { dropboxBaseHandlers } from './handlers/dropbox'

export const server = setupServer(...dropboxBaseHandlers, ...copilotBaseHandlers)
