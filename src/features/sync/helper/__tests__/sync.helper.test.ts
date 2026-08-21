import { describe, expect, it } from 'vitest'
import { getCompanySelectorValue } from '@/features/sync/helper/sync.helper'
import type { SelectorClientsCompanies } from '@/features/sync/types'
import type { UserCompanySelectorInputValue } from '@/lib/copilot/types'

const company = { value: 'comp-1', label: 'Co', type: 'company' } as const
const client = { value: 'cli-1', label: 'Client', type: 'client', companyId: 'comp-1' } as const
const list: SelectorClientsCompanies = { companies: [company], clients: [client] }

const input = (v: Partial<UserCompanySelectorInputValue>) =>
  ({ id: '', companyId: '', object: 'company', ...v }) as UserCompanySelectorInputValue

describe('getCompanySelectorValue', () => {
  it('returns an empty array when there is no selected value', () => {
    expect(
      getCompanySelectorValue(list, undefined as unknown as UserCompanySelectorInputValue),
    ).toEqual([])
  })

  it('finds a company by id', () => {
    expect(getCompanySelectorValue(list, input({ id: 'comp-1', object: 'company' }))).toEqual([
      company,
    ])
  })

  it('returns an empty array when the company id is unknown', () => {
    expect(getCompanySelectorValue(list, input({ id: 'nope', object: 'company' }))).toEqual([])
  })

  it('finds a client by matching both id and companyId', () => {
    expect(
      getCompanySelectorValue(list, input({ id: 'cli-1', companyId: 'comp-1', object: 'client' })),
    ).toEqual([client])
  })

  it('returns an empty array when the client id matches but the companyId does not', () => {
    expect(
      getCompanySelectorValue(list, input({ id: 'cli-1', companyId: 'other', object: 'client' })),
    ).toEqual([])
  })
})
