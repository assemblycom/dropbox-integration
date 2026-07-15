import { HttpResponse, http } from 'msw'
import { COPILOT_HOST } from '../hosts'

// Empty page by default. Override with paginateCopilotListFiles / mockCopilot.
const listFiles = http.get(`${COPILOT_HOST}/v1/files`, () => HttpResponse.json({ data: [] }))

export const copilotBaseHandlers = [listFiles]
