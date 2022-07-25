import * as http from 'http';
import * as https from 'https';

import { Worker as PoolWorker } from './pool';

const opt: http.AgentOptions = {
  timeout: 600000,
  maxSockets: 30,
  keepAlive: true,
};

export default class Worker extends PoolWorker {
  protected agent = {
    http: new http.Agent(opt),
    https: new https.Agent(opt),
  };
  public async preLaunch() {}
  public async end() {};
  public async run(...args) {};
}
