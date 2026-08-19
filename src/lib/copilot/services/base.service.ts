import { CopilotAPI } from '@/lib/copilot/CopilotAPI'
import type User from '@/lib/copilot/models/User.model'

class BaseService {
  protected readonly copilot: CopilotAPI
  constructor(protected readonly user: User) {
    this.copilot = new CopilotAPI(user.portalId)
  }
}

export default BaseService
