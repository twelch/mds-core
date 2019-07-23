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

import GoogleSpreadsheet from 'google-spreadsheet'

import { promisify } from 'util'
import requestPromise from 'request-promise'
import log from '@mds/mds-logger'
import {
  JUMP_PROVIDER_ID,
  LIME_PROVIDER_ID,
  BIRD_PROVIDER_ID,
  LYFT_PROVIDER_ID,
  WHEELS_PROVIDER_ID,
  SPIN_PROVIDER_ID,
  SHERPA_PROVIDER_ID,
  BOLT_PROVIDER_ID
} from '@mds/mds-providers'
import { VehicleCountResponse, LastDayStatsResponse, MetricsSheetRow } from './types'

require('dotenv').config()

// The list of providers ids on which to report
const reportProviders = [
  JUMP_PROVIDER_ID,
  LIME_PROVIDER_ID,
  BIRD_PROVIDER_ID,
  LYFT_PROVIDER_ID,
  WHEELS_PROVIDER_ID,
  SPIN_PROVIDER_ID,
  SHERPA_PROVIDER_ID,
  BOLT_PROVIDER_ID
]

const creds = {
  client_email: process.env.GOOGLE_CLIENT_EMAIL,
  private_key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.split('\\n').join('\n') : null
}

function sum(arr: number[]) {
  return arr.reduce((total, amount) => total + (amount || 0))
}

// Round percent to two decimals
function percent(a: number, total: number) {
  return Math.round(((total - a) / total) * 10000) / 10000
}

async function appendSheet(sheetName: string, rows: MetricsSheetRow[]) {
  const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID)
  try {
    await promisify(doc.useServiceAccountAuth)(creds)
    const info = await promisify(doc.getInfo)()
    log.info(`Loaded doc: ${info.title} by ${info.author.email}`)
    const sheet = info.worksheets.filter((s: { title: string; rowCount: number } & unknown) => s.title === sheetName)[0]
    log.info(`${sheetName} sheet: ${sheet.title} ${sheet.rowCount}x${sheet.colCount}`)
    if (sheet.title === sheetName) {
      const inserted = rows.map(insert_row => promisify(sheet.addRow)(insert_row))
      log.info(`Wrote ${inserted.length} rows.`)
      return await Promise.all(inserted)
    }
    log.info('Wrong sheet!')
  } catch (error) {
    throw error
  }
}

async function getProviderMetrics(iter: number): Promise<MetricsSheetRow[]> {
  /* after 10 failed iterations, give up */
  if (iter >= 10) {
    throw new Error(`Failed to write to sheet after 10 tries!`)
  }
  const token_options = {
    method: 'POST',
    url: `${process.env.AUTH0_DOMAIN}/oauth/token`,
    headers: { 'content-type': 'application/json' },
    body: {
      grant_type: 'client_credentials',
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
      audience: process.env.AUDIENCE
    },
    json: true
  }
  try {
    const token = await requestPromise(token_options)
    const counts_options = {
      uri: 'https://api.ladot.io/daily/admin/vehicle_counts',
      headers: { authorization: `Bearer ${token.access_token}` },
      json: true
    }
    const last_options = {
      uri: 'https://api.ladot.io/daily/admin/last_day_stats_by_provider',
      headers: { authorization: `Bearer ${token.access_token}` },
      json: true
    }

    const counts: VehicleCountResponse = await requestPromise(counts_options)
    const last: LastDayStatsResponse = await requestPromise(last_options)

    const rows: MetricsSheetRow[] = counts
      .filter(p => reportProviders.includes(p.provider_id))
      .map(provider => {
        const dateOptions = { timeZone: 'America/Los_Angeles', day: '2-digit', month: '2-digit', year: 'numeric' }
        const timeOptions = { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit' }
        const d = new Date()
        let [starts, ends, start_sla, end_sla, telems, telem_sla] = [0, 0, 0, 0, 0, 0]
        let event_counts = { service_start: 0, provider_drop_off: 0, trip_start: 0, trip_end: 0 }
        if (last[provider.provider_id].event_counts_last_24h) {
          event_counts = last[provider.provider_id].event_counts_last_24h
          starts = last[provider.provider_id].event_counts_last_24h.trip_start || 0
          ends = last[provider.provider_id].event_counts_last_24h.trip_end || 0
          telems = last[provider.provider_id].telemetry_counts_last_24h || 0
          telem_sla = telems ? percent(last[provider.provider_id].late_telemetry_counts_last_24h, telems) : 0
          start_sla = starts ? percent(last[provider.provider_id].late_event_counts_last_24h.trip_start, starts) : 0
          end_sla = ends ? percent(last[provider.provider_id].late_event_counts_last_24h.trip_end, ends) : 0
        }
        return {
          date: `${d.toLocaleDateString('en-US', dateOptions)} ${d.toLocaleTimeString('en-US', timeOptions)}`,
          name: provider.provider,
          registered: provider.count || 0,
          deployed:
            sum([
              provider.status.available,
              provider.status.unavailable,
              provider.status.trip,
              provider.status.reserved
            ]) || 0,
          validtrips: 'tbd', // Placeholder for next day valid trip analysis
          trips: last[provider.provider_id].trips_last_24h || 0,
          servicestart: event_counts.service_start || 0,
          providerdropoff: event_counts.provider_drop_off || 0,
          tripstart: starts,
          tripend: ends,
          tripenter: last[provider.provider_id].event_counts_last_24h.trip_enter || 0,
          tripleave: last[provider.provider_id].event_counts_last_24h.trip_leave || 0,
          telemetry: telems,
          telemetrysla: telem_sla,
          tripstartsla: start_sla,
          tripendsla: end_sla
        }
      })
    return rows
  } catch (err) {
    await log.error('getProviderMetrics', err)
    return getProviderMetrics(iter + 1)
  }
}

export const MetricsLogHandler = async () => {
  try {
    const rows = await getProviderMetrics(0)
    await appendSheet('Metrics Log', rows)
  } catch (err) {
    await log.error('MetricsLogHandler', err)
  }
}
