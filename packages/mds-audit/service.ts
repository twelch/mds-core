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

import db from '@mds/mds-db'
import {
  Audit,
  AuditEvent,
  Device,
  Recorded,
  Telemetry,
  Timestamp,
  UUID,
  VehicleEvent,
  TelemetryData,
  WithGpsProperty
} from '@mds/mds-types'

export async function deleteAudit(audit_trip_id: UUID): Promise<number> {
  const result: number = await db.deleteAudit(audit_trip_id)
  return result
}

// Currently, many of the database methods are a little heavy handed in the way they throw exceptions on read (not found)
// requests. In mds-audit, there are valid scenarios where a particular audit or device may not exist. These service methods
// exist to wrap the database calls and return null rather than forcing the caller to catch and handle exceptions for expected
// scenarios.
//
// In the future, we could have additional database methods that allow the caller to be more specific about the
// expected result. For example: readAudit.Single (expect exactly 1, throws if 0 or more than 1), readAudit.SingleOrDefault
// (expect 0 or 1, throws if more than 1), readAudit.First (expect 1 or more, throws if 0), readAudit.FirstOrDefault
// (expect 0 or more, never throws).

export async function readAudit(audit_trip_id: UUID): Promise<Recorded<Audit> | null> {
  try {
    const result: Recorded<Audit> = await db.readAudit(audit_trip_id)
    return result
  } catch (err) {
    return null
  }
}

export async function readAudits(
  query: Partial<{
    skip: number
    take: number
    provider_id: UUID
    provider_vehicle_id: string
    audit_subject_id: string
    start_time: Timestamp
    end_time: Timestamp
  }>
): Promise<{ count: number; audits: Recorded<Audit>[] }> {
  const result: { count: number; audits: Recorded<Audit>[] } = await db.readAudits(query)
  return result
}

export async function writeAudit(audit: Audit): Promise<Recorded<Audit>> {
  const result: Recorded<Audit> = await db.writeAudit({ ...audit, audit_vehicle_id: audit.audit_device_id })
  return result
}

export async function readAuditEvents(audit_trip_id: UUID): Promise<Recorded<AuditEvent>[]> {
  const result: Recorded<AuditEvent>[] = await db.readAuditEvents(audit_trip_id)
  return result
}

export async function writeAuditEvent(event: AuditEvent): Promise<Recorded<AuditEvent>> {
  const result: Recorded<AuditEvent> = await db.writeAuditEvent(event)
  return result
}

export async function readDevice(device_id: UUID, provider_id: UUID): Promise<Recorded<Device>> {
  const result: Recorded<Device> = await db.readDevice(device_id, provider_id)
  return result
}

export async function readDeviceByVehicleId(provider_id: UUID, vehicle_id: string): Promise<Recorded<Device> | null> {
  try {
    const result: Recorded<Device> = await db.readDeviceByVehicleId(
      provider_id,
      vehicle_id,
      vehicle_id.replace(/[\W_-]/g, '')
    )
    return result
  } catch (err) {
    return null
  }
}

export async function readEvents(
  device_id: UUID,
  start_time: Timestamp,
  end_time: Timestamp
): Promise<Recorded<VehicleEvent>[]> {
  if (start_time && end_time) {
    const result: { count: number; events: Recorded<VehicleEvent>[] } = await db.readEvents({
      device_id,
      start_time,
      end_time
    })
    return result.events
  }
  /* istanbul ignore next */
  return []
}

export async function readTelemetry(
  device_id: UUID,
  start_time: Timestamp,
  end_time: Timestamp
): Promise<Recorded<Telemetry>[]> {
  if (start_time && end_time) {
    const result: Recorded<Telemetry>[] = await db.readTelemetry(device_id, start_time, end_time)
    return result
  }
  /* istanbul ignore next */
  return []
}

export function withGpsProperty<T extends TelemetryData>({
  lat,
  lng,
  speed,
  heading,
  accuracy,
  hdop,
  altitude,
  satellites,
  ...props
}: T): WithGpsProperty<T> {
  return { ...props, gps: { lat, lng, speed, heading, accuracy, hdop, altitude, satellites } }
}
