import {
  Recorded,
  UUID,
  Timestamp,
  VehicleEvent,
  TelemetryData,
  VEHICLE_TYPE,
  PROPULSION_TYPE,
  VEHICLE_STATUS,
  VEHICLE_EVENT,
  VEHICLE_REASON
} from '@mds/mds-types'
import { Feature, FeatureCollection } from 'geojson'
import schema from './schema'

export interface ReadEventsResult {
  events: Recorded<VehicleEvent>[]
  count: number
}

export interface Trip {
  provider_id: UUID
  provider_name: string
  device_id: UUID
  vehicle_id: string
  vehicle_type: VEHICLE_TYPE
  propulsion_type: PROPULSION_TYPE[]
  provider_trip_id: UUID
  trip_start?: Timestamp | null
  first_trip_enter?: Timestamp | null
  last_trip_leave?: Timestamp | null
  trip_end?: Timestamp | null
  trip_duration?: number | null
  trip_distance?: number | null
  route?: FeatureCollection | null
  accuracy?: number | null
  parking_verification_url?: string | null
  standard_cost?: number | null
  actual_cost?: number | null
  recorded: Timestamp
}

// TODO move to mds-db?
export interface ReadTripsResult {
  count: number
  trips: Trip[]
}

export interface StatusChange {
  provider_id: UUID
  provider_name: string
  device_id: UUID
  vehicle_id: string
  vehicle_type: VEHICLE_TYPE
  propulsion_type: PROPULSION_TYPE[]
  event_type: VEHICLE_STATUS
  event_type_reason: VEHICLE_EVENT | VEHICLE_REASON
  event_time: Timestamp
  event_location: Feature | null
  battery_pct: number | null
  associated_trip: UUID | null
  recorded: Timestamp
}

export type StatusChangeEvent = Pick<StatusChange, 'event_type' | 'event_type_reason'>

// TODO move to mds-db?
export interface ReadStatusChangesResult {
  count: number
  status_changes: StatusChange[]
}

// Represents a row in the "telemetry" table
export interface TelemetryRecord extends TelemetryData {
  device_id: UUID
  provider_id: UUID
  timestamp: Timestamp
  recorded: Timestamp
}

export interface ReadEventsQueryParams {
  skip?: number | string
  take?: number | string
  start_time?: number | string
  end_time?: number | string
  start_recorded?: string
  end_recorded?: string
  device_id?: UUID
  trip_id?: UUID
}

export interface ReadHistoricalEventsQueryParams {
  provider_id: UUID
  end_date: number
}

export type ReadAuditsQueryParams = Partial<{
  skip: number
  take: number
  provider_id: UUID
  provider_vehicle_id: string
  audit_subject_id: string
  start_time: Timestamp
  end_time: Timestamp
}>

export interface VehicleEventCountResult {
  count: number
  events: Recorded<VehicleEvent>[]
}

export type DEVICES_COL = typeof schema.DEVICES_COLS[number]
export type EVENTS_COL = typeof schema.EVENTS_COLS[number]
export type TELEMETRY_COL = typeof schema.TELEMETRY_COLS[number]
export type TRIPS_COL = typeof schema.TRIPS_COLS[number]
export type STATUS_CHANGES_COL = typeof schema.STATUS_CHANGES_COLS[number]
export type AUDITS_COL = typeof schema.AUDITS_COLS[number]
export type AUDIT_EVENTS_COL = typeof schema.AUDITS_COLS[number]
export type POLICIES_COL = typeof schema.POLICIES_COLS[number]
export type GEOGRAPHIES_COL = typeof schema.GEOGRAPHIES_COLS
