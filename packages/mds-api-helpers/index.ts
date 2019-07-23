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

import urls from 'url'
import express from 'express'
import { isInsideBoundingBox } from '@mds/mds-utils'
import { VehicleEvent, Device, Telemetry, BoundingBox, EVENT_STATUS_MAP, VEHICLE_STATUSES } from '@mds/mds-types'
import log from '@mds/mds-logger'
import db from '@mds/mds-db'
import cache from '@mds/mds-cache'
import { CacheReadDeviceResult } from '@mds/mds-cache/types'

export async function getVehicles(
  skip: number,
  take: number,
  url: string,
  provider_id: string,
  reqQuery: { [x: string]: string },
  bbox?: BoundingBox
): Promise<{
  total: number
  links: { first: string; last: string; prev: string | null; next: string | null }
  vehicles: (Device & { updated?: number | null; telemetry?: Telemetry | null })[]
}> {
  function fmt(query: { skip: number; take: number }): string {
    const flat = Object.assign({}, reqQuery, query)
    let s = `${url}?`
    s += Object.keys(flat)
      .map(key => `${key}=${flat[key]}`)
      .join('&')
    return s
  }

  const rows = await db.readDeviceIds(provider_id)
  const total = rows.length
  log.info(`read ${total} deviceIds in /vehicles`)

  const events = await cache.readEvents(rows.map(record => record.device_id))
  const eventMap: { [s: string]: VehicleEvent } = {}
  events.map(event => {
    if (event) {
      eventMap[event.device_id] = event
    }
  })

  const deviceIdSuperset = bbox
    ? rows.filter(record => {
        return eventMap[record.device_id] ? isInsideBoundingBox(eventMap[record.device_id].telemetry, bbox) : true
      })
    : rows

  const deviceIdSubset = deviceIdSuperset.slice(skip, skip + take).map(record => record.device_id)
  const devices = (await cache.readDevices(deviceIdSubset)).reduce((acc: Device[], device: CacheReadDeviceResult) => {
    if (!device) {
      throw new Error('device in DB but not in cache')
    }
    const event = eventMap[device.device_id]
    const status = event ? EVENT_STATUS_MAP[event.event_type] : VEHICLE_STATUSES.removed
    const telemetry = event ? event.telemetry : null
    const updated = event ? event.timestamp : null
    return [...acc, { ...device, status, telemetry, updated }]
  }, [])

  const noNext = skip + take >= deviceIdSuperset.length
  const noPrev = skip === 0 || skip > deviceIdSuperset.length
  const lastSkip = take * Math.floor(deviceIdSuperset.length / take)

  return {
    total,
    links: {
      first: fmt({
        skip: 0,
        take
      }),
      last: fmt({
        skip: lastSkip,
        take
      }),
      prev: noPrev
        ? null
        : fmt({
            skip: skip - take,
            take
          }),
      next: noNext
        ? null
        : fmt({
            skip: skip + take,
            take
          })
    },
    vehicles: devices
  }
}

interface PagingParams {
  skip: number
  take: number
}

export const asPagingParams: <T extends Partial<{ [P in keyof PagingParams]: unknown }>>(
  params: T
) => T & PagingParams = params => {
  const [DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE] = [100, 1000]
  const [skip, take] = [params.skip, params.take].map(Number)
  return {
    ...params,
    skip: Number.isNaN(skip) || skip <= 0 ? 0 : skip,
    take: Number.isNaN(take) || take <= 0 ? DEFAULT_PAGE_SIZE : Math.min(take, MAX_PAGE_SIZE)
  }
}

const jsonApiLink = (req: express.Request, skip: number, take: number): string =>
  urls.format({
    protocol: req.get('x-forwarded-proto') || req.protocol,
    host: req.get('host'),
    pathname: req.path,
    query: { ...req.query, skip, take }
  })

export type JsonApiLinks = Partial<{ first: string; prev: string; next: string; last: string }> | undefined

export const asJsonApiLinks = (req: express.Request, skip: number, take: number, count: number): JsonApiLinks => {
  if (skip > 0 || take < count) {
    const first = skip > 0 ? jsonApiLink(req, 0, take) : undefined
    const prev = skip - take >= 0 && skip - take < count ? jsonApiLink(req, skip - take, take) : undefined
    const next = skip + take < count ? jsonApiLink(req, skip + take, take) : undefined
    const last = skip + take < count ? jsonApiLink(req, count - (count % take || take), take) : undefined
    return { first, prev, next, last }
  }
  return undefined
}
