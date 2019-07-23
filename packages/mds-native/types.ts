/*
    Copyright 2019 City of Los Angeles.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
 */

import { ApiRequest, ApiResponse } from '@mds/mds-api-server'
import { ApiAuthorizerClaims } from '@mds/mds-api-authorizer'
import { UUID, VehicleEvent, Recorded, Device } from '@mds/mds-types'
import { JsonApiLinks } from '@mds/mds-api-helpers'

// Allow adding type definitions for Express Request objects
export type NativeApiRequest = ApiRequest

// Allow adding type definitions for Express Response objects
export interface NativeApiResponse<T = {}> extends ApiResponse<T> {
  locals: {
    claims: ApiAuthorizerClaims
    provider_id: UUID
  }
}

export interface NativeApiGetEventsRequest extends NativeApiRequest {
  // Query string parameters always come in as strings
  query: Partial<
    {
      [P in 'skip' | 'take' | 'device_id' | 'provider_id' | 'start_time' | 'end_time']: string
    }
  >
}

interface NativeApiGetResponse<T> {
  version: string
  count: number
  data: T[]
  links?: JsonApiLinks
}

export type NativeApiGetEventsReponse = NativeApiResponse<
  NativeApiGetResponse<Omit<Recorded<VehicleEvent>, 'service_area_id'>>
>

export interface NativeApiGetDeviceRequest extends NativeApiRequest {
  params: { device_id: UUID }
}

export type NativeApiGetDeviceResponse = NativeApiResponse<NativeApiGetResponse<Recorded<Device>>>
