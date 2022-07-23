import * as dgram from 'dgram';
import { EventEmitter } from 'events';
import * as xml2js from 'xml2js';
import got from 'got';

const UPNP_ADDR = '239.255.255.250';
const UPNP_PORT = 1900;

export default class Dlna {
  private socket: dgram.Socket = null;
  constructor(private ip: string) {}

  /**
   * 查找当前局域网设备
   * @param count 查到多少个时返回默认3
   * @param wait 等待时间，单位: 秒
   */
  public async search(count = 3, wait = 10) {
    const socket = dgram.createSocket('udp4');
    const urlSet: Set<string> = new Set();
    const searchCount = new EventEmitter();
    const list = [];
    socket.on('message', async (buffer) => {
      const obj = parseSdpResponseHeader(buffer.toString());
      if (urlSet.has(obj.LOCATION)) {
        return;
      }
      urlSet.add(obj.LOCATION);
      const { body: xml } = await got.get(obj.LOCATION);
      const json = await xml2js.parseStringPromise(xml, { explicitArray: false });
      list.push(json.root);
      if (list.length >= count) {
        searchCount.emit('searchEnd');
      }
    });

    socket.on('error', (err) => {
      console.error(err);
    });
    await new Promise<void>((resolve) => {
      socket.bind({ address: this.ip }, () => {
        resolve();
      });
    });

    /**
     * HOST: 设置为协议保留多播地址和端口，必须是：239.255.255.250:1900（IPv4）或FF0x::C(IPv6)
     * MAN: 设置协议查询的类型，必须是：ssdp:discover
     * MX: 设置设备响应最长等待时间。设备响应在0和这个值之间随机选择响应延迟的值，这样可以为控制点响应平衡网络负载。
     * ST: 设置服务查询的目标，它必须是下面的类型：
     *     ssdp:all 搜索所有设备和服务
     *     upnp:rootdevice 仅搜索网络中的根设备
     *     uuid:device-UUID 查询UUID标识的设备
     *     urn:schemas-upnp-org:device:device-Type:version 查询device-Type字段指定的设备类型，设备类型和版本由UPNP组织定义。
     *     urn:schemas-upnp-org:service:service-Type:version 查询service-Type字段指定的服务类型，服务类型和版本由UPNP组织定义。
     */
    const ssdp_string = [
      `M-SEARCH * HTTP/1.1`,
      `HOST: ${ UPNP_ADDR }:${ UPNP_PORT }`,
      `ST:upnp:rootdevice`,
      `MAN:"ssdp:discover"`,
      `MX:3`,
      ''
    ].join('\r\n') + '\r\n';
    const ssdp = Buffer.from(ssdp_string, 'utf8');
    await new Promise<void>((resolve) => {
      socket.send(ssdp, 0, ssdp.length, UPNP_PORT, UPNP_ADDR, () => {
        resolve();
      });
    });
    let timeout;
    await Promise.race([
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          socket.removeAllListeners('message');
          resolve();
        }, wait * 1000);
      }),
      new Promise<void>((resolve) => {
        searchCount.on('searchEnd', () => {
          clearTimeout(timeout);
          resolve();
        });
      }),
    ]);
    socket.close();
    return list;
  }

  public async start() {
    const location = `http://${ this.ip }:7024/desc.xml`;
    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', (err) => {
      console.error(err);
      this.socket.close();
    });
    await new Promise<void>((resolve) => {
      this.socket.bind({ address: this.ip }, () => {
        this.socket.addMembership(UPNP_ADDR);
        resolve();
      });
    });

    await this.sendSsdp([
      `NOTIFY * HTTP/1.1`,
      `HOST: ${ UPNP_ADDR }:${ UPNP_PORT }`,
      `LOCATION: ${ location }`,
      `NTS: ssdp:byebye`,
      `USN: uuid:b270dfc237b76e4b45c3b01f66fefcb2::upnp:rootdevice`,
      `NT: upnp:rootdevice`,
      '',
    ]);
    await this.sendSsdp([
      `NOTIFY * HTTP/1.1`,
      `HOST: ${ UPNP_ADDR }:${ UPNP_PORT }`,
      `LOCATION: ${ location }`,
      `NTS: ssdp:byebye`,
      `USN: uuid:b270dfc237b76e4b45c3b01f66fefcb2`,
      `NT: uuid:b270dfc237b76e4b45c3b01f66fefcb2`,
      '',
    ]);
    await this.sendSsdp([
      `NOTIFY * HTTP/1.1`,
      `HOST: ${ UPNP_ADDR }:${ UPNP_PORT }`,
      `LOCATION: ${ location }`,
      `NTS: ssdp:byebye`,
      `USN: uuid:b270dfc237b76e4b45c3b01f66fefcb2::urn:schemas-upnp-org:device:MediaRenderer:1`,
      `NT: urn:schemas-upnp-org:device:MediaRenderer:1`,
      '',
    ]);
    await this.sendSsdp([
      `NOTIFY * HTTP/1.1`,
      `HOST: ${ UPNP_ADDR }:${ UPNP_PORT }`,
      `LOCATION: ${ location }`,
      `NTS: ssdp:byebye`,
      `USN: uuid:b270dfc237b76e4b45c3b01f66fefcb2::urn:schemas-upnp-org:device:AVTransport:1`,
      `NT: urn:schemas-upnp-org:device:AVTransport:1`,
      '',
    ]);
    await this.sendSsdp([
      `NOTIFY * HTTP/1.1`,
      `HOST: ${ UPNP_ADDR }:${ UPNP_PORT }`,
      `LOCATION: ${ location }`,
      `NTS: ssdp:byebye`,
      `USN: uuid:b270dfc237b76e4b45c3b01f66fefcb2::urn:schemas-upnp-org:device:ConnectionManager:1`,
      `NT: urn:schemas-upnp-org:device:ConnectionManager:1`,
      '',
    ]);
    await this.sendSsdp([
      `NOTIFY * HTTP/1.1`,
      `CACHE-CONTROL: max-age=7393`,
      `Server: UPnP/1.0 DLNADOC/1.50 Platinum/1.0.5.13`,
      `NTS: ssdp:byebye`,
      `USN: uuid:b270dfc237b76e4b45c3b01f66fefcb2::urn:schemas-upnp-org:device:RenderingControl:1`,
      `NT: urn:schemas-upnp-org:device:RenderingControl:1`,
      '',
    ]);

    /**
     * 
     * HOST: 设置为协议保留多播地址和端口，必须是239.255.255.250:1900。
     * CACHE-CONTROL: max-age指定通知消息存活时间，如果超过此时间间隔，控制点可以认为设备不存在
     * LOCATION: 包含根设备描述得URL地址
     * NT: 在此消息中，NT头必须为服务的服务类型。
     * NTS: 表示通知消息的子类型，必须为ssdp:alive
     * USN: 表示不同服务的统一服务名，它提供了一种标识出相同类型服务的能力。
     */
    await this.sendSsdp([
      `NOTIFY * HTTP/1.1`,
      `HOST: ${ UPNP_ADDR }:${ UPNP_PORT }`,
      `LOCATION: ${ location }`,
      `CACHE-CONTROL: max-age=7393`,
      `Server: UPnP/1.0 DLNADOC/1.50 Platinum/1.0.5.13`,
      `NTS: ssdp:alive`,
      `USN: uuid:b270dfc237b76e4b45c3b01f66fefcb2::upnp:rootdevice`,
      `NT: upnp:rootdevice`,
      '',
    ]);
    await this.sendSsdp([
      `NOTIFY * HTTP/1.1`,
      `HOST: ${ UPNP_ADDR }:${ UPNP_PORT }`,
      `LOCATION: ${ location }`,
      `CACHE-CONTROL: max-age=7393`,
      `Server: UPnP/1.0 DLNADOC/1.50 Platinum/1.0.5.13`,
      `NTS: ssdp:alive`,
      `USN: uuid:b270dfc237b76e4b45c3b01f66fefcb2`,
      `NT: uuid:b270dfc237b76e4b45c3b01f66fefcb2`,
      '',
    ]);
    await this.sendSsdp([
      `NOTIFY * HTTP/1.1`,
      `HOST: ${ UPNP_ADDR }:${ UPNP_PORT }`,
      `LOCATION: ${ location }`,
      `CACHE-CONTROL: max-age=7393`,
      `Server: UPnP/1.0 DLNADOC/1.50 Platinum/1.0.5.13`,
      `NTS: ssdp:alive`,
      `USN: uuid:b270dfc237b76e4b45c3b01f66fefcb2::urn:schemas-upnp-org:device:MediaRenderer:1`,
      `NT: urn:schemas-upnp-org:device:MediaRenderer:1`,
      '',
    ]);
    await this.sendSsdp([
      `NOTIFY * HTTP/1.1`,
      `HOST: ${ UPNP_ADDR }:${ UPNP_PORT }`,
      `LOCATION: ${ location }`,
      `CACHE-CONTROL: max-age=7393`,
      `Server: UPnP/1.0 DLNADOC/1.50 Platinum/1.0.5.13`,
      `NTS: ssdp:alive`,
      `USN: uuid:b270dfc237b76e4b45c3b01f66fefcb2::urn:schemas-upnp-org:device:AVTransport:1`,
      `NT: urn:schemas-upnp-org:device:AVTransport:1`,
      '',
    ]);
    await this.sendSsdp([
      `NOTIFY * HTTP/1.1`,
      `HOST: ${ UPNP_ADDR }:${ UPNP_PORT }`,
      `LOCATION: ${ location }`,
      `CACHE-CONTROL: max-age=7393`,
      `Server: UPnP/1.0 DLNADOC/1.50 Platinum/1.0.5.13`,
      `NTS: ssdp:alive`,
      `USN: uuid:b270dfc237b76e4b45c3b01f66fefcb2::urn:schemas-upnp-org:device:ConnectionManager:1`,
      `NT: urn:schemas-upnp-org:device:ConnectionManager:1`,
      '',
    ]);
    await this.sendSsdp([
      `NOTIFY * HTTP/1.1`,
      `HOST: ${ UPNP_ADDR }:${ UPNP_PORT }`,
      `LOCATION: ${ location }`,
      `CACHE-CONTROL: max-age=7393`,
      `Server: UPnP/1.0 DLNADOC/1.50 Platinum/1.0.5.13`,
      `NTS: ssdp:alive`,
      `USN: uuid:b270dfc237b76e4b45c3b01f66fefcb2::urn:schemas-upnp-org:device:RenderingControl:1`,
      `NT: urn:schemas-upnp-org:device:RenderingControl:1`,
      '',
    ]);
  }

  public async restart() {
    if (this.socket) {
      this.socket.close();
    }
    await this.start();
  }

  private sendSsdp(list: string[]) {
    const ssdp = Buffer.from(list.join('\r\n') + '\r\n', 'utf8');
    return new Promise<void>((resolve) => {
      this.socket.send(ssdp, 0, ssdp.length, UPNP_PORT, UPNP_ADDR, () => {
        resolve();
      });
    });
  }
}

function parseSdpResponseHeader(text: string) {
  try {
    const [Protocol, ...lineList] = text.split('\r\n');
    if (!/^(NOTIFY|HTTP)/.test(Protocol)) {
      return;
    }
    const header = { protocol: Protocol };
    for (const line of lineList) {
      if (line === '') {
        continue;
      }
      const result = line.match(/^(.+?): (.+?)?$/);
      if (result) {
        header[result[1].toUpperCase()] = result[2];
      }
    }
    return header as any;
  } catch (error) {
    console.error(error);
  }
}
