import * as Koa from 'koa';
import * as koaBody from 'koa-body';
import * as koaStatic from 'koa-static';
import * as path from 'path';
import { spawn } from 'child_process';

const { stdout } = spawn(path.join(__dirname, '../redis-server.exe'), [
  '--port',
  '16379',
  '--appendonly',
  'yes',
  '--dir',
  path.join(__dirname, '..'),
]);

stdout.on('data', function (chunk) {
  const message = chunk.toString();
  if (message.includes('Ready to accept connections')) {
    const app = new Koa();
    const { router } = require('./router');
    app.use(koaStatic(path.join(__dirname, '../public')));
    app.use(koaBody());
    app.use(router.routes());
    app.use(router.allowedMethods());
    app.listen(7024, () => {
      console.log('listen 7024...');
    });
  }
  console.log(chunk.toString());
});
