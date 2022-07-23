import * as Router from 'koa-router';
import * as xml2js from 'xml2js';
import * as path from 'path';
import * as fs from 'fs';
import { URL } from 'url';
import * as ip from 'ip';
import got from 'got';
import * as http from 'http';
import * as https from 'https';

import Dlna from './lib/dlna';
import { redis } from './lib/redis';
import { parseM3u8 } from './lib/util';
import { Producer, Consumer } from './lib/redisQueue';

interface File {
  url: string;
  dir: string;
}

export const router = new Router();
const dlna = new Dlna(ip.address());

dlna.start();

const topic = 'stream:download';
const downloadProduce = new Producer<File>(redis, topic);

(async () => {
  await downloadProduce.createGroup('default', '$');
  const downloadConsumer = new Consumer<File>(redis, topic, 'default', 'dlna');
  const agent = {
    http: new http.Agent(),
    https: new https.Agent(),
  };
  let list = await downloadConsumer.getMessage(10);
  while (true) {
    await Promise.all(list.map(async (item) => {
      console.log(item.data.dir);
      const readStream = await got.stream(item.data.url, {
        agent,
        timeout: 60000,
      });
      const name = path.basename(new URL(item.data.url).pathname);
      const writeStream = fs.createWriteStream(path.join(item.data.dir, name));
      readStream.pipe(writeStream);
      await new Promise<void>((resolve, reject) => {
        writeStream.on('close', resolve);
        writeStream.on('error', reject);
        readStream.on('error', reject);
      });
      await downloadConsumer.ack(item.id);
    }));
    list = await downloadConsumer.getMessage(10, '>');
    if (list.length < 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
})();

router.get('/restart', async (ctx) => {
  await dlna.restart();
  ctx.response.body = { success: true };
});

router.post('/AVTransport/control.xml', async (ctx) => {
  const body = await xml2js.parseStringPromise(ctx.request.body, { explicitArray: false });
  const SetAVTransportURI = body['s:Envelope']['s:Body']['u:SetAVTransportURI'];
  if (SetAVTransportURI) {
    const key = `url:${ SetAVTransportURI.CurrentURI }`;
    const exists = await redis.get(key);
    if (exists === 'true') {
      return;
    }
    await redis.set(key, 'true');
    console.log(key);
    const meta = await xml2js.parseStringPromise(SetAVTransportURI.CurrentURIMetaData, { explicitArray: false });
    const title: string = meta["DIDL-Lite"].item["dc:title"];
    const url = new URL(meta["DIDL-Lite"].item.res._);
    const extname = path.extname(url.pathname);
    if (extname === '.m3u8') {
      const { body } = await got.get(url);
      const m3u8 = parseM3u8(body);
      const reg = /^http/;
      const prefix = url.origin + path.dirname(url.pathname);
      const dir = path.join(__dirname, `../download/${ title }`);
      await fs.promises.mkdir(dir, { recursive: true });
      const fileList = [];
      for (const item of m3u8) {
        fileList.push(`file ${ path.basename(item.url) }`);
        if (!reg.test(item.url)) {
          item.url = prefix + (/^\//.test(item.url) ? item.url : `/${ item.url }`);
        }
        downloadProduce.push({ url: item.url, dir });
      }
      await fs.promises.writeFile(path.join(dir, 'files'), fileList.join('\n'));
      console.log(title, 'm3u8', url);
    } else {
      console.log(title, 'no m3u8', url);
    }
  }
});
