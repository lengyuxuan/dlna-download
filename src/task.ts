import * as fs from 'fs';
import * as path from 'path';
import got from 'got';
import Worker from './lib/worker';

export default class GetImage extends Worker {
  public async run(url: string, dir: string, key: string, progress: boolean, name: string, msgId: string) {
    const readStream = await got.stream(url, {
      agent: this.agent,
      timeout: 60000,
    });
    name = (name || path.basename(new URL(url).pathname)).replace(/[\\\/:\*\?\"\<\>\|]/g, '');
    const writeStream = fs.createWriteStream(path.join(dir, name));
    readStream.pipe(writeStream);
    let timer = null;
    if (progress) {
      timer = setInterval(() => {
        const { percent } = readStream.downloadProgress;
        console.log(`${ name } 下载进度：${ (percent * 100).toFixed(2) }%`);
      }, 1000);
    }
    await new Promise<void>((resolve, reject) => {
      writeStream.on('close', () => {
        this.send('download-finish', { msgId, name });
        clearInterval(timer);
        resolve();
      });
      writeStream.on('error', (error) => {
        clearInterval(timer);
        reject(error);
      });
      readStream.on('error', (error) => {
        clearInterval(timer);
        reject(error);
      });
    });
    if (!progress) {
      this.send('download-merge', { msgId, key });
    }
  }
}
