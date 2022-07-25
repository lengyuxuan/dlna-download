import * as Router from 'koa-router';
import * as xml2js from 'xml2js';
import * as path from 'path';
import * as fs from 'fs';
import { URL } from 'url';
import * as ip from 'ip';
import got from 'got';

import Dlna from './lib/dlna';
import { redis } from './lib/redis';
import { parseM3u8 } from './lib/util';
import { Producer, Consumer } from './lib/redisQueue';
import { ProcessPool } from './lib/pool';
import { exec } from 'child_process';

interface File {
  url: string;
  dir: string;
  key: string;
  progress: boolean;
  name?: string;
}

redis.defineCommand('incrCurrent', {
  numberOfKeys: 1,
  lua: `
    local key = KEYS[1];
    local result = redis.call("hmget", key, "current", "total", "name");
    result[1] = result[1] + 1
    result[2] = result[2] + 0
    redis.call("hset", key, "current", result[1]);
    return result;
  `,
});
const dlna = new Dlna(ip.address());
dlna.start();
dlna.search();
const pool = new ProcessPool({
  keepAliveTime: 1000,
  /** 并发下载数 */
  maxProcess: 10,
  pullInterval: 1000,
});
const topic = 'stream:download';
const downloadProduce = new Producer<File>(redis, topic);
const downloadDIr = path.join(__dirname, '../download');
(async () => {
  await downloadProduce.createGroup('default', '$');
  const downloadConsumer = new Consumer<File>(redis, topic, 'default', 'dlna');
  pool.onWorker('download-finish', async ({ msgId, name }) => {
    await downloadConsumer.ack(msgId);
    console.log(`${ name } 下载完成`);
  });
  pool.onWorker('download-merge', async ({ msgId, key }) => {
    await downloadConsumer.ack(msgId);
    const [current, total, name] = await redis.incrCurrent(key);
    console.log(`${ name } 下载进度：${ (current / total * 100).toFixed(2) }%`);
    if (current === total) {
      const cmd = `ffmpeg -f concat -safe 0 -i "${ path.join(downloadDIr, name, 'files') }" -c copy "${ path.join(downloadDIr, name) }.mp4"`;
      console.log(cmd);
      exec(cmd, () => {
        console.log(`${ name } 下载转码完成`);
      });
    }
  });

  pool.listen(async (count) => {
    const list = await downloadConsumer.getMessage(count);
    return list.map((item) => {
      return {
        id: item.data.url,
        executableFilePath: path.join(__dirname, './task'),
        retry: 0,
        args: [
          item.data.url,
          item.data.dir,
          item.data.key,
          item.data.progress === 'true',
          item.data.name,
          item.id,
        ],
      };
    });
  });
})();

export const router = new Router();

router.get('/restart', async (ctx) => {
  await dlna.restart();
  ctx.response.body = { success: true };
});

router.post('/RenderingControl/control.xml', async (ctx) => {
  console.log('RenderingControl', ctx.header.soapaction)
  switch (ctx.header.soapaction) {
    case '"urn:schemas-upnp-org:service:RenderingControl:1#GetVolume"':
      ctx.response.body = `
        <?xml version="1.0" encoding="UTF-8"?>
        <s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
          <s:Body>
            <u:GetVolumeResponse xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">
              <CurrentVolume>100</CurrentVolume>
            </u:GetVolumeResponse>
          </s:Body>
        </s:Envelope>
      `;
      break;
  }
});

let CurrentURI = '';
let CurrentURIMetaData = '';

router.post('/AVTransport/control.xml', async (ctx) => {
  console.log(ctx.header.soapaction)
  ctx.response.set('Content-Type', 'text/xml; charset="utf-8"')
  switch (ctx.header.soapaction) {
    case '"urn:schemas-upnp-org:service:AVTransport:1#Stop"':
      ctx.response.body = `
        <?xml version="1.0" encoding="UTF-8"?>
        <s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
          <s:Body>
            <u:StopResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/>
          </s:Body>
        </s:Envelope>
      `;
      break;
    case '"urn:schemas-upnp-org:service:AVTransport:1#GetTransportInfo"':
      ctx.response.body = `
        <?xml version="1.0" encoding="UTF-8"?>
        <s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
          <s:Body>
            <u:GetTransportInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
              <CurrentTransportState>STOPPED</CurrentTransportState>
              <CurrentTransportStatus>OK</CurrentTransportStatus>
              <CurrentSpeed>1</CurrentSpeed>
            </u:GetTransportInfoResponse>
          </s:Body>
        </s:Envelope>
      `;
      break;
    case '"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI"':
      const body = await xml2js.parseStringPromise(ctx.request.body, { explicitArray: false });
      CurrentURI = body['s:Envelope']['s:Body']['u:SetAVTransportURI'].CurrentURI;
      CurrentURIMetaData = body['s:Envelope']['s:Body']['u:SetAVTransportURI'].CurrentURIMetaData;
      download(body['s:Envelope']['s:Body']['u:SetAVTransportURI']);
      ctx.response.body = `
        <?xml version="1.0" encoding="UTF-8"?>
        <s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
          <s:Body>
            <u:SetAVTransportURIResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/>
          </s:Body>
        </s:Envelope>
      `;
      break;
    case '"urn:schemas-upnp-org:service:AVTransport:1#Play"':
      ctx.response.body = `
        <?xml version="1.0" encoding="UTF-8"?>
        <s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
          <s:Body>
            <u:PlayResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/>
          </s:Body>
        </s:Envelope>
      `;
      break;
    case '"urn:schemas-upnp-org:service:AVTransport:1#Pause"':
      ctx.response.body = `
        <?xml version="1.0" encoding="UTF-8"?>
        <s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
          <s:Body>
            <u:PauseResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/>
          </s:Body>
        </s:Envelope>
      `;
      break;
    case '"urn:schemas-upnp-org:service:AVTransport:1#GetPositionInfo"':
      ctx.response.body = `
        <?xml version="1.0" encoding="UTF-8"?>
        <s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
          <s:Body>
            <u:GetPositionInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
              <Track>1</Track>
              <TrackDuration>00:00:00</TrackDuration>
              <TrackMetaData></TrackMetaData>
              <TrackURI></TrackURI>
              <RelTime>00:00:00</RelTime>
              <AbsTime>00:00:00</AbsTime>
              <RelCount>2147483647</RelCount>
              <AbsCount>2147483647</AbsCount>
            </u:GetPositionInfoResponse>
          </s:Body>
        </s:Envelope>
      `;
      break;
    case '"urn:schemas-upnp-org:service:AVTransport:1#GetMediaInfo"':
      ctx.response.body = `
      <?xml version="1.0" encoding="UTF-8"?>
      <s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
        <s:Body>
          <u:GetMediaInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
            <NrTracks>1</NrTracks>
            <MediaDuration>00:00:00</MediaDuration>
            <CurrentURI>${ CurrentURI }</CurrentURI>
            <CurrentURIMetaData>${ CurrentURIMetaData }</CurrentURIMetaData>
            <NextURI>NOT_IMPLEMENTED</NextURI>
            <NextURIMetaData>NOT_IMPLEMENTED</NextURIMetaData>
            <PlayMedium>NONE</PlayMedium>
            <RecordMedium>NOT_IMPLEMENTED</RecordMedium>
            <WriteStatus>NOT_IMPLEMENTED</WriteStatus>
          </u:GetMediaInfoResponse>
        </s:Body>
      </s:Envelope>
      `;
      break;
  }
});

async function download({ CurrentURI, CurrentURIMetaData }) {
  const key = `url:${ CurrentURI }`;
  const exists = await redis.exists(key);
  if (exists) {
    return;
  }
  const meta = await xml2js.parseStringPromise(CurrentURIMetaData, { explicitArray: false });
  const title: string = meta['DIDL-Lite'].item['dc:title'];
  const url: string = meta['DIDL-Lite'].item.res._;
  const uri = new URL(meta['DIDL-Lite'].item.res._);
  if (meta['DIDL-Lite'].item.res.$.protocolInfo.includes('video/x-flv')) {
    downloadProduce.push({
      url,
      dir: path.join(__dirname, `../download`) ,
      key,
      progress: true,
      name: title + path.extname(uri.pathname),
    });
  } else {
    const { body } = await got.get(url);
    const m3u8 = parseM3u8(body);
    const reg = /^http/;
    const prefix = uri.origin + path.dirname(uri.pathname);
    const dir = path.join(__dirname, `../download/${ title }`);
    await fs.promises.mkdir(dir, { recursive: true });
    const fileList = [];
    for (const item of m3u8) {
      if (!reg.test(item.url)) {
        item.url = prefix + (/^\//.test(item.url) ? item.url : `/${ item.url }`);
      }
      fileList.push(`file '${ path.join(dir, path.basename(new URL(item.url).pathname)) }'`);
      downloadProduce.push({ url: item.url, dir, key, progress: false });
    }
    await redis.hmset(key, {
      name: title,
      total: m3u8.length,
      current: 0,
    });
    await fs.promises.writeFile(path.join(dir, 'files'), fileList.join('\n'));
  }
}
