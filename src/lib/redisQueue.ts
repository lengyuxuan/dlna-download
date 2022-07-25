import { Redis } from 'ioredis';
import { objToArr, arrToObj } from './util';

export class Producer<T> {
  constructor(private redis: Redis, private topic: string) { }

  public createGroup(group: string, lastId: '$' | number) {
    lastId = lastId || '$';
    return this.redis.xgroup('CREATE', this.topic, group, lastId, 'MKSTREAM').catch((err) => {
      if (err.message !== 'BUSYGROUP Consumer Group name already exists') {
        console.log(err.message);
      }
    });
  }

  public async push(message: T, id = '*') {
    return this.redis.xadd(this.topic, id, ...objToArr(message));
  }
}

export class Consumer<T> {
  private id = '0';
  private cacheList: { id: string; data: T; }[] = [];

  constructor(
    private redis: Redis,
    private topic: string,
    private group: string,
    private name: string,
  ) { }

  public async getMessage(count: number) {
    const list = [];
    if (this.cacheList.length > 1) {
      for (let i = 0; i < count && i < this.cacheList.length; i ++) {
        list.push(this.cacheList.shift());
      }
      if (list.length < count) {
        count -= list.length;
      } else {
        return list;
      }
    }
    const results = await this.redis.xreadgroup('GROUP', this.group, this.name, 'COUNT', count, 'STREAMS', this.topic, this.id);
    if (results) {
      const [_, messageList] = results[0];
      for (const message of messageList) {
        const data = arrToObj(message[1] as unknown as string[]) as T;
        if (this.id === '0') {
          list.push({ id: message[0], data });
        } else {
          this.cacheList.push({ id: message[0], data });
        }
      }
    }
    this.id = '>';
    return list;
  }

  public ack(id: string) {
    return this.redis.xack(this.topic, this.group, id);
  }
}
