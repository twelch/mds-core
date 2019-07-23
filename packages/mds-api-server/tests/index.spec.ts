/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable promise/prefer-await-to-callbacks */
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

import supertest from 'supertest'
import test from 'unit.js'
import { ApiServer } from '@mds/mds-api-server'

const request = supertest(ApiServer(app => app))

const APP_JSON = 'application/json; charset=utf-8'

describe('Testing API Server', () => {
  it('verifies get root', done => {
    request
      .get('/')
      .expect(200)
      .end((err, result) => {
        test.value(result).hasHeader('content-type', APP_JSON)
        test.object(result.body).hasProperty('name')
        test.object(result.body).hasProperty('version')
        test.object(result.body).hasProperty('node')
        done(err)
      })
  })

  it('verifies health', done => {
    request
      .get('/health')
      .expect(200)
      .end((err, result) => {
        test.value(result).hasHeader('content-type', APP_JSON)
        test.object(result.body).hasProperty('node')
        test.object(result.body).hasProperty('process')
        test.object(result.body).hasProperty('memory')
        test.object(result.body).hasProperty('uptime')
        done(err)
      })
  })
})
