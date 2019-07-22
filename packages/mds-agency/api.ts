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

import express from 'express'
import urls from 'url'

import { getVehicles } from 'mds-api-helpers'
import log from 'mds-logger'
import db from 'mds-db'
import cache from 'mds-cache'
import stream from 'mds-stream'
import { providerName, isProviderId } from 'mds-providers'
import areas from 'ladot-service-areas'
import {
  UUID,
  Recorded,
  Device,
  VehicleEvent,
  Telemetry,
  ErrorObject,
  Timestamp,
  CountMap,
  TripsStats,
  DeviceID
} from 'mds'
import {
  isEnum,
  VEHICLE_EVENTS,
  VEHICLE_TYPES,
  VEHICLE_STATUSES,
  VEHICLE_REASONS,
  PROPULSION_TYPES,
  EVENT_STATUS_MAP,
  VEHICLE_STATUS,
  VEHICLE_EVENT
} from 'mds-enums'
import {
  isUUID,
  isPct,
  isTimestamp,
  isFloat,
  pointInShape,
  now,
  days,
  inc,
  pathsFor,
  head,
  tail,
  isStateTransitionValid,
  ServerError
} from 'mds-utils'
import { AgencyApiRequest, AgencyApiResponse } from 'mds-agency/types'

function api(app: express.Express): express.Express {
  /**
   * Agency-specific middleware to extract provider_id into locals, do some logging, etc.
   */
  app.use(async (req: AgencyApiRequest, res: AgencyApiResponse, next) => {
    try {
      // verify presence of provider_id
      if (!(req.path.includes('/health') || req.path === '/')) {
        if (res.locals.claims) {
          const { provider_id, scope } = res.locals.claims

          // no test access without auth
          if (req.path.includes('/test/')) {
            if (!scope || !scope.includes('test:all')) {
              return res.status(403).send({
                result: `no test access without test:all scope (${scope})`
              })
            }
          }

          // no admin access without auth
          if (req.path.includes('/admin/')) {
            if (!scope || !scope.includes('admin:all')) {
              return res.status(403).send({
                result: `no admin access without admin:all scope (${scope})`
              })
            }
          }

          if (provider_id) {
            if (!isUUID(provider_id)) {
              await log.warn(req.originalUrl, 'bogus provider_id', provider_id)
              return res.status(400).send({
                result: `invalid provider_id ${provider_id} is not a UUID`
              })
            }

            if (!isProviderId(provider_id)) {
              return res.status(400).send({
                result: `invalid provider_id ${provider_id} is not a known provider`
              })
            }
          }

          // stash provider_id
          res.locals.provider_id = provider_id

          // log.info(providerName(provider_id), req.method, req.originalUrl)
        } else {
          return res.status(401).send('Unauthorized')
        }
      }
    } catch (err) {
      /* istanbul ignore next */
      await log.error(req.originalUrl, 'request validation fail:', err.stack)
    }
    next()
  })

  /**
   * for some functions we will want to validate the :device_id param
   */
  async function validateDeviceId(req: express.Request, res: express.Response, next: Function) {
    const { device_id } = req.params

    /* istanbul ignore if This is never called with no device_id parameter */
    if (!device_id) {
      await log.warn('agency: missing device_id', req.originalUrl)
      res.status(400).send({
        error: 'missing_param',
        error_description: 'missing device_id'
      })
      return
    }
    if (device_id && !isUUID(device_id)) {
      await log.warn('agency: bogus device_id', device_id, req.originalUrl)
      res.status(400).send({
        error: 'bad_param',
        error_description: `invalid device_id ${device_id} is not a UUID`
      })
      return
    }
    next()
  }

  const usBounds = {
    latMax: 49.45,
    latMin: 24.74,
    lonMax: -66.94,
    lonMin: -124.79
  }

  // / ////////// gets ////////////////

  /**
   * Get all service areas
   * See {@link https://github.com/CityOfLosAngeles/mobility-data-specification/tree/dev/agency#service_areas Service Areas}
   */
  app.get(pathsFor('/service_areas'), async (req: AgencyApiRequest, res: AgencyApiResponse) => {
    try {
      const serviceAreas = await areas.readServiceAreas()
      await log.info('readServiceAreas (all)', serviceAreas.length)
      return res.status(200).send({
        service_areas: serviceAreas
      })
    } catch (err) {
      /* istanbul ignore next */
      await log.error('failed to read service areas', err)
      return res.status(404).send({
        result: 'not found'
      })
    }
  })

  /**
   * Get a particular service area
   * See {@link https://github.com/CityOfLosAngeles/mobility-data-specification/tree/dev/agency#service_areas Service Areas}
   */
  app.get(pathsFor('/service_areas/:service_area_id'), async (req: AgencyApiRequest, res: AgencyApiResponse) => {
    const { service_area_id } = req.params

    if (!isUUID(service_area_id)) {
      return res.status(400).send({
        result: `invalid service_area_id ${service_area_id} is not a UUID`
      })
    }

    try {
      const serviceAreas = await areas.readServiceAreas(undefined, service_area_id)

      if (serviceAreas && serviceAreas.length > 0) {
        await log.info('readServiceAreas (one)')
        return res.status(200).send({
          service_areas: serviceAreas
        })
      }
    } catch {
      return res.status(404).send({
        result: `${service_area_id} not found`
      })
    }

    return res.status(404).send({
      result: `${service_area_id} not found`
    })
  })

  function badDevice(device: Device): Partial<{ error: string; error_description: string }> | boolean {
    if (!device.device_id) {
      return {
        error: 'missing_param',
        error_description: 'missing device_id'
      }
    }
    if (!isUUID(device.device_id)) {
      return {
        error: 'bad_param',
        error_description: `device_id ${device.device_id} is not a UUID`
      }
    }
    // propulsion is a list
    if (!Array.isArray(device.propulsion)) {
      return {
        error: 'missing_param',
        error_description: 'missing propulsion types'
      }
    }
    for (const prop of device.propulsion) {
      if (!isEnum(PROPULSION_TYPES, prop)) {
        return {
          error: 'bad_param',
          error_description: `invalid propulsion type ${prop}`
        }
      }
    }
    // if (device.year === undefined) {
    //     return {
    //         error: 'missing_param',
    //         error_description: 'missing integer field "year"'
    //     }
    // }
    if (device.year !== null && device.year !== undefined) {
      if (!Number.isInteger(device.year)) {
        return {
          error: 'bad_param',
          error_description: `invalid device year ${device.year} is not an integer`
        }
      }
      if (device.year < 1980 || device.year > 2020) {
        return {
          error: 'bad_param',
          error_description: `invalid device year ${device.year} is out of range`
        }
      }
    }
    if (device.type === undefined) {
      return {
        error: 'missing_param',
        error_description: 'missing enum field "type"'
      }
    }
    if (!isEnum(VEHICLE_TYPES, device.type)) {
      return {
        error: 'bad_param',
        error_description: `invalid device type ${device.type}`
      }
    }
    // if (device.mfgr === undefined) {
    //     return {
    //         error: 'missing_param',
    //         error_description: 'missing string field "mfgr"'
    //     }
    // }
    // if (device.model === undefined) {
    //     return {
    //         error: 'missing_param',
    //         error_description: 'missing string field "model"'
    //     }
    // }
    return false
  }

  /**
   * Endpoint to register vehicles
   * See {@link https://github.com/CityOfLosAngeles/mobility-data-specification/tree/dev/agency#vehicle---register Register}
   */
  app.post(pathsFor('/vehicles'), async (req: AgencyApiRequest, res: AgencyApiResponse) => {
    const { body } = req
    const recorded = now()
    const device: Device = {
      provider_id: res.locals.provider_id,
      device_id: body.device_id,
      vehicle_id: body.vehicle_id,
      type: body.type,
      propulsion: body.propulsion,
      year: parseInt(body.year) || body.year,
      mfgr: body.mfgr,
      model: body.model,
      recorded,
      status: VEHICLE_STATUSES.removed
    }

    const failure = badDevice(device)
    if (failure) {
      return res.status(400).send(failure)
    }

    async function writeRegisterEvent() {
      const event: VehicleEvent = {
        device_id: device.device_id,
        provider_id: device.provider_id,
        event_type: VEHICLE_EVENTS.register,
        event_type_reason: null,
        telemetry: null,
        timestamp: recorded,
        trip_id: null,
        recorded,
        telemetry_timestamp: undefined,
        service_area_id: null
      }
      try {
        await db.writeEvent(event)
        try {
          // writing to cache and stream is not fatal
          await Promise.all([cache.writeEvent(event), stream.writeEvent(event)])
        } catch (err) {
          await log.warn('/event exception cache/stream', err)
        }
      } catch (err) {
        await log.error('writeRegisterEvent failure', err)
        throw new Error('writeEvent exception db')
      }
    }

    // writing to the DB is the crucial part.  other failures should be noted as bugs but tolerated
    // and fixed later.
    try {
      await db.writeDevice(device)
      try {
        await Promise.all([cache.writeDevice(device), stream.writeDevice(device)])
      } catch (err) {
        await log.error('failed to write device stream/cache', err)
      }
      await log.info('new', providerName(res.locals.provider_id), 'vehicle added', JSON.stringify(device))
      try {
        await writeRegisterEvent()
      } catch (err) {
        await log.error('writeRegisterEvent failure', err)
      }
      res.status(201).send({ result: 'register device success', recorded, device })
    } catch (err) {
      if (String(err).includes('duplicate')) {
        res.status(409).send({
          error: 'already_registered',
          error_description: 'A vehicle with this device_id is already registered'
        })
      } else if (String(err).includes('db')) {
        await log.error(providerName(res.locals.provider_id), 'register vehicle failed:', err)
        res.status(500).send(new ServerError())
      } else {
        await log.error(providerName(res.locals.provider_id), 'register vehicle failed:', err)
        res.status(500).send(new ServerError())
      }
    }
  })

  /**
   * Read back a vehicle.
   */
  app.get(pathsFor('/vehicles/:device_id'), validateDeviceId, async (req: AgencyApiRequest, res: AgencyApiResponse) => {
    const { device_id } = req.params

    const { cached } = req.query

    const { provider_id } = res.locals

    function finish(device: Device, event?: VehicleEvent, telemetry?: Recorded<Telemetry> | Telemetry): void {
      if (device.provider_id !== provider_id) {
        res.status(404).send({
          error: 'not_found'
        })
        return
      }
      const composite: Partial<
        Device & { prev_event?: string; updated?: Timestamp; gps?: Recorded<Telemetry>['gps'] }
      > = {
        ...device
      }

      if (event) {
        composite.prev_event = event.event_type
        composite.updated = event.timestamp
        composite.status = (EVENT_STATUS_MAP[event.event_type as VEHICLE_EVENT] || 'unknown') as VEHICLE_STATUS
      } else {
        composite.status = VEHICLE_STATUSES.removed
      }
      if (telemetry) {
        if (telemetry.gps) {
          composite.gps = telemetry.gps
        }
      }
      res.send(composite)
    }

    log.info(`/vehicles/${device_id}`, cached)
    if (cached) {
      try {
        const device = await cache.readDevice(device_id)
        const event = await cache.readEvent(device_id).catch(async err => {
          await log.warn(err)
          return undefined
        })
        const telemetry = await cache.readTelemetry(device_id).catch(async err => {
          await log.warn(err)
          return undefined
        })
        if (device) return finish(device, event, telemetry)
      } catch (err) {
        await log.warn(providerName(res.locals.provider_id), `fail GET /vehicles/${device_id}`)
        await log.error(err)
        res.status(404).send({
          error: 'not_found'
        })
      }
    } else {
      try {
        const device = await db.readDevice(device_id).catch(async err => {
          await log.error(err)
          res.status(404).send({
            error: 'not_found'
          })
        })
        const event = await db.readEvent(device_id).catch(async err => {
          await log.warn(err)
          return undefined
        })
        const telemetry = await db.readTelemetry(device_id)
        if (device) return finish(device, event, telemetry[0])
      } catch (err) {
        await log.error(err)
        res.status(500).send(new ServerError())
      }
    }
  })

  /**
   * Read back all the vehicles for this provider_id, with pagination
   */
  app.get(pathsFor('/vehicles'), async (req: AgencyApiRequest, res: AgencyApiResponse) => {
    let { skip, take } = req.query
    const PAGE_SIZE = 1000

    skip = parseInt(skip) || 0
    take = parseInt(take) || PAGE_SIZE

    const url = urls.format({
      protocol: req.get('x-forwarded-proto') || req.protocol,
      host: req.get('host'),
      pathname: req.path
    })

    const { provider_id } = res.locals

    try {
      const response = await getVehicles(skip, take, url, provider_id, req.query)
      return res.status(200).send(response)
    } catch (err) {
      await log.error('readDeviceIds fail', err)
      res.status(500).send(new ServerError())
    }
  })

  // update the vehicle_id
  app.put(pathsFor('/vehicles/:device_id'), validateDeviceId, async (req: AgencyApiRequest, res: AgencyApiResponse) => {
    const { device_id } = req.params

    const { vehicle_id } = req.body

    const update = {
      vehicle_id
    }

    const { provider_id } = res.locals

    async function fail(err: Error | string) {
      /* istanbul ignore else cannot easily test server failure */
      if (String(err).includes('not found')) {
        res.status(404).send({
          error: 'not_found'
        })
      } else if (String(err).includes('invalid')) {
        res.status(400).send({
          error: 'invalid_data'
        })
      } else if (!provider_id) {
        res.status(404).send({
          error: 'not_found'
        })
      } else {
        await log.error(providerName(provider_id), `fail PUT /vehicles/${device_id}`, JSON.stringify(req.body), err)
        res.status(500).send(new ServerError())
      }
    }

    try {
      const tempDevice = await db.readDevice(device_id, provider_id)
      if (tempDevice.provider_id !== provider_id) {
        await fail('not found')
      } else {
        const device = await db.updateDevice(device_id, provider_id, update)
        await Promise.all([cache.writeDevice(device), stream.writeDevice(device)])
        return res.status(201).send({
          result: 'success',
          vehicle: device
        })
      }
    } catch (err) {
      await fail(err)
    }
  })

  function badTelemetry(telemetry: Telemetry | null | undefined): ErrorObject | null {
    if (!telemetry) {
      return {
        error: 'missing_param',
        error_description: 'invalid missing telemetry'
      }
    }

    const { device_id, timestamp, gps, charge } = telemetry

    if (typeof gps !== 'object') {
      return {
        error: 'missing_param',
        error_description: 'invalid missing gps'
      }
    }

    const { altitude, accuracy, speed, satellites } = gps
    const { lat, lng } = gps

    // validate all parameters
    if (!isUUID(device_id)) {
      return {
        error: 'missing_param',
        error_description: 'no device_id included in telemetry'
      }
    }
    if (typeof lat !== 'number' || Number.isNaN(lat) || lat < usBounds.latMin || lat > usBounds.latMax) {
      return {
        error: 'bad_param',
        error_description: `invalid lat ${lat}`
      }
    }
    if (typeof lng !== 'number' || Number.isNaN(lng) || lng < usBounds.lonMin || lng > usBounds.lonMax) {
      return {
        error: 'bad_param',
        error_description: `invalid lng ${lng}`
      }
    }
    if (altitude !== undefined && !isFloat(altitude)) {
      return {
        error: 'bad_param',
        error_description: `invalid altitude ${altitude}`
      }
    }
    if (accuracy !== undefined && !isFloat(accuracy)) {
      return {
        error: 'bad_param',
        error_description: `invalid accuracy ${accuracy}`
      }
    }
    if (speed !== undefined && !isFloat(speed)) {
      return {
        error: 'bad_param',
        error_description: `invalid speed ${speed}`
      }
    }
    if (satellites !== undefined && satellites !== null && !Number.isInteger(satellites)) {
      return {
        error: 'bad_param',
        error_description: `invalid satellites ${satellites}`
      }
    }
    if (charge !== undefined && !isPct(charge)) {
      return {
        error: 'bad_param',
        error_description: `invalid charge ${charge}`
      }
    }
    if (!isTimestamp(timestamp)) {
      return {
        error: 'bad_param',
        error_description: `invalid timestamp ${timestamp} (note: should be in milliseconds)`
      }
    }
    return null
  }

  // TODO Joi
  async function badEvent(event: VehicleEvent) {
    if (event.timestamp === undefined) {
      return {
        error: 'missing_param',
        error_description: 'missing enum field "event_type"'
      }
    }
    if (!isTimestamp(event.timestamp)) {
      return {
        error: 'bad_param',
        error_description: `invalid timestamp ${event.timestamp}`
      }
    }
    if (event.event_type === undefined) {
      return {
        error: 'missing_param',
        error_description: 'missing enum field "event_type"'
      }
    }

    if (!isEnum(VEHICLE_EVENTS, event.event_type)) {
      return {
        error: 'bad_param',
        error_description: `invalid event_type ${event.event_type}`
      }
    }

    if (event.event_type_reason && !isEnum(VEHICLE_REASONS, event.event_type_reason)) {
      return {
        error: 'bad_param',
        error_description: `invalid event_type_reason ${event.event_type_reason}`
      }
    }

    if (event.trip_id === '') {
      /* eslint-reason TODO remove eventually -- Lime is spraying empty-string values */
      /* eslint-disable-next-line no-param-reassign */
      event.trip_id = null
    }

    const { trip_id } = event
    if (trip_id !== null && trip_id !== undefined && !isUUID(event.trip_id)) {
      return {
        error: 'bad_param',
        error_description: `invalid trip_id ${event.trip_id} is not a UUID`
      }
    }

    function missingTripId(): ErrorObject | null {
      if (!trip_id) {
        return {
          error: 'missing_param',
          error_description: 'missing trip_id'
        }
      }
      return null
    }

    // event-specific checking goes last
    switch (event.event_type) {
      case VEHICLE_EVENTS.trip_start:
        return badTelemetry(event.telemetry) || missingTripId()
      case VEHICLE_EVENTS.trip_end:
        return badTelemetry(event.telemetry) || missingTripId()
      case VEHICLE_EVENTS.trip_enter:
        return badTelemetry(event.telemetry) || missingTripId()
      case VEHICLE_EVENTS.trip_leave:
        return badTelemetry(event.telemetry) || missingTripId()
      case VEHICLE_EVENTS.service_start:
      case VEHICLE_EVENTS.service_end:
      case VEHICLE_EVENTS.provider_pick_up:
      case VEHICLE_EVENTS.provider_drop_off:
        return badTelemetry(event.telemetry)
      case VEHICLE_EVENTS.register:
      case VEHICLE_EVENTS.deregister:
      case VEHICLE_EVENTS.reserve:
      case VEHICLE_EVENTS.cancel_reservation:
        return null
      default:
        await log.warn(`unsure how to validate mystery event_type ${event.event_type}`)
        break
    }
    return null // we good
  }

  function lower(s: string): string {
    if (typeof s === 'string') {
      return s.toLowerCase()
    }
    return s
  }

  /**
   * set the service area on an event based on its gps
   */
  function getServiceArea(event: VehicleEvent): UUID | null {
    const tel = event.telemetry
    if (tel) {
      // TODO: filter service areas by effective date and not having a replacement
      const serviceAreaKeys = Object.keys(areas.serviceAreaMap).reverse()
      const status = EVENT_STATUS_MAP[event.event_type]
      switch (status) {
        case VEHICLE_STATUSES.available:
        case VEHICLE_STATUSES.unavailable:
        case VEHICLE_STATUSES.reserved:
        case VEHICLE_STATUSES.trip:
          for (const key of serviceAreaKeys) {
            const serviceArea = areas.serviceAreaMap[key]
            if (pointInShape(tel.gps, serviceArea.area)) {
              return key
            }
          }
          break
        default:
          break
      }
    }
    return null
  }

  async function writeTelemetry(telemetry: Telemetry | Telemetry[]) {
    if (!Array.isArray(telemetry)) {
      const promises: [Promise<number>, Promise<void>, Promise<void[] | undefined>] = [
        db.writeTelemetry([telemetry]),
        cache.writeTelemetry([telemetry]),
        stream.writeTelemetry([telemetry])
      ]
      return Promise.all(promises)
    }
    const promises: [Promise<number>, Promise<void>, Promise<void[] | undefined>] = [
      db.writeTelemetry(telemetry),
      cache.writeTelemetry(telemetry),
      stream.writeTelemetry(telemetry)
    ]
    return Promise.all(promises)
  }
  /**
   * Endpoint to submit vehicle events
   * See {@link https://github.com/CityOfLosAngeles/mobility-data-specification/tree/dev/agency#vehicle---event Events}
   */
  app.post(
    pathsFor('/vehicles/:device_id/event'),
    validateDeviceId,
    async (req: AgencyApiRequest, res: AgencyApiResponse) => {
      const { device_id } = req.params

      const { provider_id } = res.locals
      const name = providerName(provider_id || 'unknown')

      const recorded = now()

      const event: VehicleEvent = {
        device_id: req.params.device_id,
        provider_id: res.locals.provider_id,
        event_type: lower(req.body.event_type) as VEHICLE_EVENT,
        event_type_reason: lower(req.body.event_type_reason),
        telemetry: req.body.telemetry ? { ...req.body.telemetry, provider_id: res.locals.provider_id } : null,
        timestamp: req.body.timestamp,
        trip_id: req.body.trip_id,
        recorded,
        telemetry_timestamp: undefined, // added for diagnostic purposes
        service_area_id: null // added for diagnostic purposes
      }

      if (event.telemetry) {
        event.telemetry_timestamp = event.telemetry.timestamp
      }

      async function success() {
        function fin() {
          res.status(201).send({
            result: 'success',
            recorded,
            device_id,
            status: EVENT_STATUS_MAP[event.event_type]
          })
        }
        const delta = now() - recorded

        if (delta > 100) {
          await log.info(name, 'post event took', delta, 'ms')
          fin()
        } else {
          fin()
        }
      }

      /* istanbul ignore next */
      async function fail(err: Error | Partial<{ message: string }>): Promise<void> {
        const message = err.message || String(err)
        if (message.includes('duplicate')) {
          await log.info(name, 'duplicate event', event.event_type)
          res.status(409).send({
            error: 'duplicate_event',
            error_description: 'an event with this device_id and timestamp has already been received'
          })
        } else if (message.includes('not found') || message.includes('unregistered')) {
          await log.info(name, 'event for unregistered', event.device_id, event.event_type)
          res.status(400).send({
            error: 'unregistered',
            error_description: 'the specified device_id has not been registered'
          })
        } else {
          await log.error('post event fail:', JSON.stringify(event), message)
          res.status(500).send(new ServerError())
        }
      }

      async function finish() {
        if (event.telemetry) {
          event.telemetry.recorded = recorded
          await writeTelemetry(event.telemetry)
          await success()
        } else {
          await success()
        }
      }

      // TODO switch to cache for speed?
      try {
        await db.readDevice(event.device_id, provider_id)
        if (event.telemetry) {
          event.telemetry.device_id = event.device_id
        }
        const failure = (await badEvent(event)) || (event.telemetry ? badTelemetry(event.telemetry) : null)
        // TODO unify with fail() above
        if (failure) {
          await log.error(
            providerName(res.locals.provider_id),
            'event failure',
            JSON.stringify(failure),
            JSON.stringify(event)
          )
          return res.status(400).send(failure)
        }

        // make a note of the service area
        event.service_area_id = getServiceArea(event)

        // database write is crucial; failures of cache/stream should be noted and repaired
        await db.writeEvent(event)
        try {
          await Promise.all([cache.writeEvent(event), stream.writeEvent(event)])
          await finish()
        } catch (err) {
          await log.warn('/event exception cache/stream', err)
          await finish()
        }
      } catch (err) {
        await fail(err)
      }
    }
  )

  /**
   * Endpoint to submit telemetry
   * See {@link https://github.com/CityOfLosAngeles/mobility-data-specification/tree/dev/agency#vehicles---update-telemetry Telemetry}
   */
  app.post(pathsFor('/vehicles/telemetry'), async (req: AgencyApiRequest, res: AgencyApiResponse) => {
    const start = Date.now()

    const { data } = req.body
    const { provider_id } = res.locals
    if (!provider_id) {
      res.status(400).send({
        error: 'bad_param',
        error_description: 'bad or missing provider_id'
      })
      return
    }
    const name = providerName(provider_id)
    const failures: string[] = []
    const valid: Telemetry[] = []

    const recorded = now()
    const p: Promise<Device | DeviceID[]> =
      data.length === 1 && isUUID(data[0].device_id)
        ? db.readDevice(data[0].device_id, provider_id)
        : db.readDeviceIds(provider_id)
    try {
      const deviceOrDeviceIds = await p
      const deviceIds = Array.isArray(deviceOrDeviceIds) ? deviceOrDeviceIds : [deviceOrDeviceIds]
      for (const item of data) {
        // make sure the device exists
        const { gps } = item
        const telemetry: Telemetry = {
          device_id: item.device_id,
          provider_id,
          timestamp: item.timestamp,
          charge: item.charge,
          gps: {
            lat: gps.lat,
            lng: gps.lng,
            altitude: gps.altitude,
            heading: gps.heading,
            speed: gps.speed,
            accuracy: gps.hdop,
            satellites: gps.satellites
          },
          recorded
        }

        const bad_telemetry: ErrorObject | null = badTelemetry(telemetry)
        if (bad_telemetry) {
          const msg = `bad telemetry for device_id ${telemetry.device_id}: ${bad_telemetry.error_description}`
          // append to failure
          failures.push(msg)
        } else if (!deviceIds.some(item2 => item2.device_id === telemetry.device_id)) {
          const msg = `device_id ${telemetry.device_id}: not found`
          failures.push(msg)
        } else {
          valid.push(telemetry)
        }
      }

      if (valid.length) {
        const counts = await writeTelemetry(valid)
        const delta = Date.now() - start
        if (delta > 300) {
          log.info(
            name,
            'writeTelemetry',
            valid.length,
            `(${counts[0]} unique)`,
            'took',
            delta,
            `ms (${Math.round((1000 * valid.length) / delta)}/s)`
          )
        }
        if (counts[0]) {
          res.status(201).send({
            result: `telemetry success for ${valid.length} of ${data.length}`,
            recorded: now(),
            unique: counts[0],
            failures
          })
        } else {
          await log.info(name, 'no unique telemetry in', data.length, 'items')
          res.status(400).send({
            error: 'invalid_data',
            error_description: 'none of the provided data was unique',
            result: 'no new valid telemetry submitted',
            unique: 0
          })
        }
      } else {
        const body = `${JSON.stringify(req.body).substring(0, 128)} ...`
        const fails = `${JSON.stringify(failures).substring(0, 128)} ...`
        log.info(name, 'no valid telemetry in', data.length, 'items:', body, 'failures:', fails)
        res.status(400).send({
          error: 'invalid_data',
          error_description: 'none of the provided data was valid',
          result: 'no valid telemetry submitted',
          failures
        })
      }
    } catch (err) {
      res.status(400).send({
        error: 'invalid_data',
        error_description: 'none of the provided data was valid',
        result: 'no valid telemetry submitted',
        failures: [`device_id ${data[0].device_id}: not found`]
      })
    }
  })

  // ///////////////////// begin Agency candidate endpoints ///////////////////////

  /**
   * Not currently in Agency spec.  Ability to read back all vehicle IDs.
   */
  app.get(pathsFor('/admin/vehicle_ids'), async (req: AgencyApiRequest, res: AgencyApiResponse) => {
    // read all the devices
    const query_provider_id = req.query.provider_id

    if (query_provider_id && !isUUID(query_provider_id)) {
      return res.status(400).send({
        error: 'bad_param',
        error_description: `invalid provider_id ${query_provider_id} is not a UUID`
      })
    }

    await log.info(query_provider_id ? providerName(query_provider_id) : null, 'get /vehicles')

    const items = await db.readDeviceIds(query_provider_id)
    const data: { [s: string]: string[] } = {}
    const summary: { [s: string]: number } = {}
    items.map(item => {
      const { device_id, provider_id } = item
      if (data[provider_id]) {
        data[provider_id].push(device_id)
        summary[providerName(provider_id)] += 1
      } else {
        data[provider_id] = [device_id]
        summary[providerName(provider_id)] = 1
      }
    })

    res.send({
      result: 'success',
      summary,
      data
    })
  })

  const RIGHT_OF_WAY_STATUSES: string[] = [
    VEHICLE_STATUSES.available,
    VEHICLE_STATUSES.unavailable,
    VEHICLE_STATUSES.reserved,
    VEHICLE_STATUSES.trip
  ]

  function asInt(n: string | number | undefined): number | undefined {
    if (n === undefined) {
      return undefined
    }
    if (typeof n === 'number') {
      return n
    }
    if (typeof n === 'string') {
      return parseInt(n)
    }
  }

  // TODO move to utils?
  function startAndEnd(
    params: Partial<{ start_time: number | string | undefined; end_time: number | string | undefined }>
  ): Partial<{ start_time: number | undefined; end_time: number | undefined }> {
    const { start_time, end_time } = params

    const start_time_out: number | undefined = asInt(start_time)
    const end_time_out: number | undefined = asInt(end_time)

    if (start_time_out !== undefined) {
      if (Number.isNaN(start_time_out) || !isTimestamp(start_time_out)) {
        throw new Error(`invalid start_time ${start_time}`)
      }
    }
    if (end_time_out !== undefined) {
      if (Number.isNaN(end_time_out) || !isTimestamp(end_time_out)) {
        throw new Error(`invalid end_time ${end_time}`)
      }
    }

    if (start_time_out !== undefined && end_time_out === undefined) {
      if (now() - start_time_out > days(7)) {
        throw new Error('queries over 1 week not supported')
      }
    }
    if (start_time_out !== undefined && end_time_out !== undefined) {
      if (end_time_out - start_time_out > days(7)) {
        throw new Error('queries over 1 week not supported')
      }
    }
    return {
      start_time: start_time_out,
      end_time: end_time_out
    }
  }

  app.get(pathsFor('/admin/vehicle_counts'), async (req: AgencyApiRequest, res: AgencyApiResponse) => {
    async function fail(err: Error | string) {
      await log.error('/admin/vehicle_counts fail', err)
      res.status(500).send({
        error: err
      })
    }

    async function getMaps(): Promise<{
      eventMap: { [s: string]: VehicleEvent }
      telemetryMap: { [s: string]: Telemetry }
    }> {
      const telemetry: Telemetry[] = await cache.readAllTelemetry()
      const events: VehicleEvent[] = await cache.readAllEvents()
      const eventSeed: { [s: string]: VehicleEvent } = {}
      const eventMap: { [s: string]: VehicleEvent } = events.reduce((map, event) => {
        return Object.assign(map, { [event.device_id]: event })
      }, eventSeed)
      const telemetrySeed: { [s: string]: Telemetry } = {}
      const telemetryMap = telemetry.reduce((map, t) => {
        return Object.assign(map, { [t.device_id]: t })
      }, telemetrySeed)
      return Promise.resolve({
        telemetryMap,
        eventMap
      })
    }
    try {
      const rows = await db.getVehicleCountsPerProvider()
      const stats: {
        provider_id: UUID
        provider: string
        count: number
        status: { [s: string]: number }
        event_type: { [s: string]: number }
        areas: { [s: string]: number }
      }[] = rows.map(row => {
        const { provider_id, count } = row
        return {
          provider_id,
          provider: providerName(provider_id),
          count,
          status: {},
          event_type: {},
          areas: {}
        }
      })
      await log.warn('/admin/vehicle_counts', JSON.stringify(stats))

      const maps = await getMaps()
      const { eventMap } = maps
      await Promise.all(
        stats.map(async stat => {
          const items = await db.readDeviceIds(stat.provider_id)
          return items.map(item => {
            const event = eventMap[item.device_id]
            const event_type = event ? event.event_type : 'default'
            inc(stat.event_type, event_type)
            const status = EVENT_STATUS_MAP[event_type]
            inc(stat.status, status)
            // TODO latest-state should remove service_area_id if it's null
            if (event && RIGHT_OF_WAY_STATUSES.includes(status) && event.service_area_id) {
              const serviceArea = areas.serviceAreaMap[event.service_area_id]
              if (serviceArea) {
                inc(stat.areas, serviceArea.description)
              }
            }
          })
        })
      )
      res.status(200).send(stats)
    } catch (err) {
      await fail(err)
    }
  })

  // read all the latest events out of the cache
  app.get(pathsFor('/admin/events'), async (req: AgencyApiRequest, res: AgencyApiResponse) => {
    const events = await cache.readAllEvents()
    res.status(200).send({
      events
    })
  })

  // NOTE: experimental code while we learn how to interpret trip data
  function categorizeTrips(perTripId: {
    [s: string]: { provider_id: UUID; trip_id: UUID; eventTypes: { [n: number]: string } }
  }): { [s: string]: TripsStats } {
    const perProvider: { [s: string]: TripsStats } = {}
    Object.keys(perTripId).map((trip_id: UUID) => {
      const trip = perTripId[trip_id]
      const pid: UUID = trip.provider_id
      perProvider[pid] = perProvider[pid] || {}
      const counts: CountMap = {}
      const events: string[] = Object.keys(trip.eventTypes)
        .sort()
        .map((key: string) => trip.eventTypes[parseInt(key)])
      if (events.length === 1) {
        inc(counts, 'single') // single: one-off
        perProvider[pid].singles = perProvider[pid].singles || {}
        inc(perProvider[pid].singles, head(events))
      } else if (head(events) === VEHICLE_EVENTS.trip_start && tail(events) === VEHICLE_EVENTS.trip_end) {
        inc(counts, 'simple') // simple: starts with start, ends with end
      } else if (head(events) === VEHICLE_EVENTS.trip_start) {
        if (tail(events) === VEHICLE_EVENTS.trip_leave) {
          inc(counts, 'left') // left: started with start, ends with leave
        } else {
          inc(counts, 'noEnd') // noEnd: started with start, did not end with end or leave
        }
      } else if (tail(events) === VEHICLE_EVENTS.trip_end) {
        if (head(events) === VEHICLE_EVENTS.trip_enter) {
          inc(counts, 'entered') // entered: started with enter, ends with end
        } else {
          inc(counts, 'noStart') // noStart: weird start, ends with end
        }
      } else if (head(events) === VEHICLE_EVENTS.trip_enter && tail(events) === VEHICLE_EVENTS.trip_leave) {
        inc(counts, 'flyby') // flyby: starts with enter, ends with leave
      } else {
        inc(counts, 'mystery') // mystery: weird non-conforming trip
        perProvider[pid].mysteries = perProvider[pid].mysteries || {}
        const key = events.map(event => event.replace('trip_', '')).join('-')
        inc(perProvider[pid].mysteries, key)

        perProvider[pid].mystery_examples = perProvider[pid].mystery_examples || {}
        perProvider[pid].mystery_examples[key] = perProvider[pid].mystery_examples[key] || []
        if (perProvider[pid].mystery_examples[key].length < 10) {
          perProvider[pid].mystery_examples[key].push(trip_id)
        }
      }
      Object.assign(perProvider[pid], counts)
    })
    return perProvider
  }

  app.get(pathsFor('/admin/last_day_trips_by_provider'), async (req: AgencyApiRequest, res: AgencyApiResponse) => {
    async function fail(err: Error | string) {
      await log.error('last_day_trips_by_provider err:', err)
    }

    const { start_time, end_time } = startAndEnd(req.params)
    try {
      const rows = await db.getTripEventsLast24HoursByProvider(start_time, end_time)
      const perTripId = categorizeTrips(
        rows.reduce(
          (
            acc: {
              [s: string]: { provider_id: UUID; trip_id: UUID; eventTypes: { [t: number]: VehicleEvent } }
            },
            row
          ) => {
            const tid = row.trip_id
            acc[tid] = acc[tid] || {
              provider_id: row.provider_id,
              trip_id: tid,
              eventTypes: {}
            }
            acc[tid].eventTypes[row.timestamp] = row.event_type
            return acc
          },
          {}
        )
      )

      const provider_info = Object.keys(perTripId).reduce(
        (map: { [s: string]: TripsStats & { name: string } }, provider_id) => {
          return Object.assign(map, { [provider_id]: { ...perTripId[provider_id], name: providerName(provider_id) } })
        },
        {}
      )
      res.status(200).send(provider_info)
    } catch (err) {
      await fail(err)
    }
  })

  // get raw trip data for analysis
  app.get(pathsFor('/admin/raw_trip_data/:trip_id'), async (req: AgencyApiRequest, res: AgencyApiResponse) => {
    const { trip_id } = req.params
    try {
      const eventsAndCount: { events: VehicleEvent[]; count: number } = await db.readEvents({ trip_id })

      if (eventsAndCount.events.length > 0) {
        const { events } = eventsAndCount
        events[0].timestamp_long = new Date(events[0].timestamp).toString()
        for (let i = 1; i < events.length; i += 1) {
          events[i].timestamp_long = new Date(events[i].timestamp).toString()
          events[i].delta = events[i].timestamp - events[i - 1].timestamp
        }
        res.status(200).send({ events })
      } else {
        res.status(404).send({ result: 'not_found' })
      }
    } catch (err) {
      await log.error(`raw_trip_data: ${err}`)
      res.status(500).send(new ServerError())
    }
  })

  // Get a hash set up where the keys are the provider IDs, so it's easier
  // to combine the result of each db query.
  // I could have just used the providers who have vehicles registered, but
  // I didn't want to have to wrap everything in another Promise.then callback
  // by asking the DB for that information.
  // This function is ludicrously long as it is.
  app.get(pathsFor('/admin/last_day_stats_by_provider'), async (req: AgencyApiRequest, res: AgencyApiResponse) => {
    const provider_info: {
      [p: string]: {
        name: string
        events_last_24h: number
        trips_last_24h: number
        ms_since_last_event: number
        event_counts_last_24h: { [s: string]: number }
        late_event_counts_last_24h: { [s: string]: number }
        telemetry_counts_last_24h: number
        late_telemetry_counts_last_24h: number
        registered_last_24h: number
        events_not_in_conformance: number
      }
    } = {}

    const { start_time, end_time } = startAndEnd(req.params)

    async function fail(err: Error | string) {
      await log.error(
        'last_day_stats_by_provider err:',
        err instanceof Error ? err.message : err,
        err instanceof Error ? err.stack : ''
      )
    }

    const getTripCountsSince = async () => {
      try {
        const rows = await db.getTripCountsPerProviderSince(start_time, end_time)
        await log.info('trips last 24h', rows)
        rows.map(row => {
          const pid = row.provider_id
          provider_info[pid] = provider_info[pid] || {}
          provider_info[pid].trips_last_24h = Number(row.count)
        })
      } catch (err) {
        await fail(err)
      }
    }

    const getTimeSinceLastEvent = async () => {
      try {
        const rows = await db.getMostRecentEventByProvider()
        await log.info('time since last event', rows)
        rows.map(row => {
          const pid = row.provider_id
          provider_info[pid] = provider_info[pid] || {}
          provider_info[pid].ms_since_last_event = now() - row.max
        })
      } catch (err) {
        await fail(err)
      }
    }

    const getEventCountsPerProviderSince = async () => {
      try {
        const rows = await db.getEventCountsPerProviderSince(start_time, end_time)
        await log.info('time since last event', rows)
        rows.map(row => {
          const pid = row.provider_id
          provider_info[pid] = provider_info[pid] || {}
          provider_info[pid].event_counts_last_24h = provider_info[pid].event_counts_last_24h || {}
          provider_info[pid].late_event_counts_last_24h = provider_info[pid].late_event_counts_last_24h || {}
          provider_info[pid].event_counts_last_24h[row.event_type] = row.count
          provider_info[pid].late_event_counts_last_24h[row.event_type] = row.slacount
        })
      } catch (err) {
        await fail(err)
      }
    }

    const getTelemetryCountsPerProviderSince = async () => {
      try {
        const rows = await db.getTelemetryCountsPerProviderSince(start_time, end_time)
        await log.info('time since last event', rows)
        rows.map(row => {
          const pid = row.provider_id
          provider_info[pid] = provider_info[pid] || {}
          provider_info[pid].telemetry_counts_last_24h = row.count
          provider_info[pid].late_telemetry_counts_last_24h = row.slacount
        })
      } catch (err) {
        await fail(err)
      }
    }

    const getNumVehiclesRegisteredLast24Hours = async () => {
      try {
        const rows = await db.getNumVehiclesRegisteredLast24HoursByProvider(start_time, end_time)
        await log.info('num vehicles since last 24', rows)
        rows.map(row => {
          const pid = row.provider_id
          provider_info[pid] = provider_info[pid] || {}
          provider_info[pid].registered_last_24h = row.count
        })
      } catch (err) {
        await fail(err)
      }
    }

    const getNumEventsLast24Hours = async () => {
      try {
        const rows = await db.getNumEventsLast24HoursByProvider(start_time, end_time)
        rows.map(row => {
          const pid = row.provider_id
          provider_info[pid] = provider_info[pid] || {}
          provider_info[pid].events_last_24h = row.count
        })
      } catch (err) {
        await fail(err)
      }
    }

    const getConformanceLast24Hours = async () => {
      try {
        const rows = await db.getEventsLast24HoursPerProvider(start_time, end_time)
        const prev_event: { [key: string]: VehicleEvent } = {}
        await log.info('event', rows)
        rows.map(event => {
          const pid = event.provider_id
          provider_info[pid] = provider_info[pid] || {}
          provider_info[pid].events_not_in_conformance = provider_info[pid].events_not_in_conformance || 0
          if (prev_event[event.device_id]) {
            provider_info[pid].events_not_in_conformance += isStateTransitionValid(prev_event[event.device_id], event)
              ? 0
              : 1
          }
          prev_event[event.device_id] = event
        })
      } catch (err) {
        await fail(err)
      }
    }

    try {
      await Promise.all([
        getTimeSinceLastEvent(),
        getNumVehiclesRegisteredLast24Hours(),
        getNumEventsLast24Hours(),
        getTripCountsSince(),
        getEventCountsPerProviderSince(),
        getTelemetryCountsPerProviderSince(),
        getConformanceLast24Hours()
      ])

      Object.keys(provider_info).map(provider_id => {
        provider_info[provider_id].name = providerName(provider_id)
      })
      res.status(200).send(provider_info)
    } catch (err) {
      await log.error('unable to fetch data from last 24 hours', err)
      res.status(500).send(new ServerError())
    }
  })

  // /////////////////// end Agency candidate endpoints ////////////////////

  // ///////////////////// begin test-only endpoints ///////////////////////

  app.get(pathsFor('/test/initialize'), async (req: AgencyApiRequest, res: AgencyApiResponse) => {
    try {
      const kind = await Promise.all([db.initialize(), cache.initialize(), stream.initialize()])
      res.send({
        result: `Database initialized (${kind})`
      })
    } catch (err) {
      /* istanbul ignore next */
      await log.error('initialize failed', err)
      res.status(500).send(new ServerError())
    }
  })

  app.get(pathsFor('/test/shutdown'), async (req: AgencyApiRequest, res: AgencyApiResponse) => {
    try {
      await Promise.all([cache.shutdown(), stream.shutdown(), db.shutdown()])
      await log.info('shutdown complete (in theory)')
      res.send({
        result: 'cache/stream/db shutdown done'
      })
    } catch (err) {
      await log.error('shutdown failed', err)
      res.status(500).send(new ServerError())
    }
  })

  app.get(pathsFor('/test/reset'), async (req: AgencyApiRequest, res: AgencyApiResponse) => {
    try {
      await cache.reset()
      res.send({
        result: 'cache reset done'
      })
    } catch (err) {
      await log.error('cache reset failed', err)
      res.status(500).send(new ServerError())
    }
  })

  // read-back for test purposes
  app.get(
    pathsFor('/test/vehicles/:device_id/event/:timestamp'),
    validateDeviceId,
    async (req: AgencyApiRequest, res: AgencyApiResponse) => {
      const { device_id } = req.params
      let { timestamp } = req.params

      timestamp = parseInt(timestamp) || undefined

      const { cached } = req.query

      try {
        if (cached) {
          await log.info('ohai event cached')
          const event = await cache.readEvent(device_id)
          res.status(200).send(event)
        } else {
          await log.info('ohai event db')
          const event = await db.readEvent(device_id, timestamp)
          res.status(200).send(event)
        }
      } catch (err) {
        await log.error('readEvent failed', err)
        res.status(500).send(new ServerError())
      }
    }
  )

  app.get(pathsFor('/admin/cache/info'), async (req: AgencyApiRequest, res: AgencyApiResponse) => {
    const details = await cache.info()
    await log.warn('cache', JSON.stringify(details))
    res.send(details)
  })

  // wipe a device -- sandbox or admin use only
  app.get(
    pathsFor('/admin/wipe/:device_id'),
    validateDeviceId,
    async (req: AgencyApiRequest, res: AgencyApiResponse) => {
      try {
        const { device_id } = req.params
        await log.info('about to wipe', device_id)
        const cacheResult = await cache.wipeDevice(device_id)
        await log.info('cache wiped', cacheResult)
        const dbResult = await db.wipeDevice(device_id)
        await log.info('db wiped', dbResult)
        if (cacheResult >= 1) {
          res.send({
            result: `successfully wiped ${device_id}`
          })
        } else {
          res.status(404).send({
            result: `${device_id} not found (${cacheResult})`
          })
        }
      } catch (err) {
        await log.error(`/admin/wipe/:device_id failed`, err)
        res.status(500).send(new ServerError())
      }
    }
  )

  async function refresh(device_id: UUID, provider_id: UUID): Promise<string> {
    // TODO all of this back and forth between cache and db is slow
    const device = await db.readDevice(device_id, provider_id)
    // log.info('refresh device', JSON.stringify(device))
    await cache.writeDevice(device)
    try {
      const event = await db.readEvent(device_id)
      await cache.writeEvent(event)
    } catch (err) {
      await log.info('no events for', device_id, err)
    }
    try {
      await db.readTelemetry(device_id)
    } catch (err) {
      await log.info('no telemetry for', device_id, err)
    }
    return 'done'
  }

  app.get(pathsFor('/admin/cache/refresh'), async (req: AgencyApiRequest, res: AgencyApiResponse) => {
    // wipe the cache and rebuild from db
    let { skip, take } = req.query
    skip = parseInt(skip) || 0
    take = parseInt(take) || 10000000000

    try {
      const rows = await db.readDeviceIds()

      await log.info('read', rows.length, 'device_ids. skip', skip, 'take', take)
      const devices = rows.slice(skip, take + skip)
      await log.info('device_ids', JSON.stringify(devices))

      const promises = devices.map(device => refresh(device.device_id, device.provider_id))
      await Promise.all(promises)
      res.send({
        result: `success for ${devices.length} devices`
      })
    } catch (err) {
      await log.error('cache refresh fail', err)
      res.send({
        result: 'fail'
      })
    }
  })

  // read-back for test purposes
  app.get(
    pathsFor('/test/vehicles/:device_id/telemetry/:timestamp'),
    validateDeviceId,
    async (req: AgencyApiRequest, res: AgencyApiResponse) => {
      const { device_id, timestamp } = req.params

      try {
        const telemetry = await db.readTelemetry(device_id, timestamp, timestamp)
        if (Array.isArray(telemetry) && telemetry.length > 0) {
          res.send(telemetry[0])
        } else {
          res.status(404).send({
            result: 'not found'
          })
        }
      } catch (err) {
        await log.info('test read telemetry error', err)
        res.status(500).send(new ServerError())
      }
    }
  )

  return app
}

// ///////////////////// end test-only endpoints ///////////////////////

export { api }
