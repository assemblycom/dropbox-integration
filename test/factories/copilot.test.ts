import { beforeEach, describe, expect, it } from 'vitest'
import { CopilotFileListSchema, CopilotFileRetrieveSchema } from '@/lib/copilot/types'
import {
  copilotDownloadableFactory,
  copilotFileFactory,
  copilotFolderFactory,
  copilotListPage,
  copilotPendingFactory,
  copilotRenamedFactory,
} from './copilot'
import { resetFactories } from './index'

beforeEach(() => resetFactories())

describe('copilotFileFactory', () => {
  it('produces a schema-valid file with a sequential uuid', () => {
    const file = copilotFileFactory.build()
    expect(CopilotFileRetrieveSchema.parse(file)).toEqual(file)
    expect(file.id).toBe('00000000-0000-4000-8000-000000000001')
    expect(file.object).toBe('file')
  })

  it('folder trait sets object=folder', () => {
    expect(copilotFolderFactory.build().object).toBe('folder')
  })

  it('pending trait sets status=pending', () => {
    expect(copilotPendingFactory.build().status).toBe('pending')
  })

  it('downloadable trait sets a downloadUrl', () => {
    expect(copilotDownloadableFactory.build().downloadUrl).toBeDefined()
  })

  // test required for update event from Assembly. update event has to have previousAttributes field in the payload body
  it('renamed trait sets previousAttributes.name', () => {
    expect(copilotRenamedFactory.build().previousAttributes?.name).toBeDefined()
  })
})

describe('copilotListPage', () => {
  it('builds a schema-valid page without a nextToken', () => {
    const page = copilotListPage([copilotFileFactory.build()])
    expect(CopilotFileListSchema.parse(page)).toEqual(page)
    expect(page.nextToken).toBeUndefined()
  })

  it('includes a nextToken when given one', () => {
    const page = copilotListPage([], { nextToken: 'token:1' })
    expect(page.nextToken).toBe('token:1')
  })
})
