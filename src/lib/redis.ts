import * as Redis from 'ioredis';

export const redis = new Redis({
  port: 16379,
});

redis.on('error', (err) => {
  console.error('redis 连接失败！', err);
});

redis.on('connect', () => {
  console.info(`redis 连接成功！`);
});

redis.on('close', (err) => {
  console.error('redis 连接断开！', err);
});

redis.on('reconnecting', () => {
  console.warn('redis 重连中...');
});
