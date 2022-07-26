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
  constructor (
    private redis: Redis,
    private topic: string,
    private group: string,
    private name: string,
  ) {}

  public async getMessage(count: number) {
    const results = await this.redis.xreadgroup('GROUP', this.group, this.name, 'COUNT', count, 'STREAMS', this.topic, this.id);
    if (results) {
      const [_, messageList] = results[0];
      if (messageList.length < 1) {
        this.id = '>';
      }
      return messageList.map((message) => {
        const data = arrToObj(message[1] as unknown as string[]) as T;
        return { id: message[0], data };
      });
    }
    this.id = '>';
    return [];
  }

  public ack(id: string) {
    return this.redis.xack(this.topic, this.group, id);
  }
}
