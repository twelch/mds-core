import { ApiRequest, ApiResponse } from '@mds/mds-api-server'
import { ApiAuthorizerClaims } from '@mds/mds-api-authorizer'
import { UUID } from '@mds/mds-types'

export type ComplianceApiRequest = ApiRequest
export interface ComplianceApiResponse extends ApiResponse {
  locals: {
    claims: ApiAuthorizerClaims
    provider_id: UUID
  }
}
