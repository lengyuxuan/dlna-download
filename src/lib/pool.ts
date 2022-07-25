import * as cluster from 'cluster';
import { debuglog } from 'util';
import { EventEmitter } from 'events';
import { clearTimeout } from 'timers';

interface Options {
  /** 工作进程最大数量 */
  maxProcess: number;
  /** 空闲进程存活时间(单位: 毫秒)，如果设置为 0 则表示不进行回收 */
  keepAliveTime: number;
  /** 任务获取时间间隔 (ms)，默认 100ms */
  pullInterval?: number;
}

export interface Task {
  /** 任务标识，需唯一 */
  id: string;
  /** 任务文件的绝对路径 */
  executableFilePath: string;
  /** 任务重试次数 */
  retry?: number;
  /** 任务传参 */
  args?: any[];
  preArgs?: any[];
  /** 任务超时时间 */
  timeout?: number;
}

interface Message {
  type: string;
}

/** 子进程已成功获取可执行路径，准备好运行 */
interface ReadyMessage extends Message { }

/** 子进程完成分配的任务 */
interface FinishMessage extends Message {
  /** 任务完成耗时 */
  takeUpTime: number;
  /** 任务id */
  id: string;
  /** 任务重试次数 */
  retry: number;
  /** 任务是否成功 */
  success: boolean;
}

interface MessageEvent {
  on(event: 'finish', listener: (worker: cluster.Worker, message: FinishMessage) => void): void;
  on(event: 'ready', listener: (worker: cluster.Worker, message: ReadyMessage) => void): void;
  on(event: string | symbol, listener: (worker: cluster.Worker, ...args: any[]) => void): void;
  emit(event: string | symbol, ...args: any[]): boolean;
}

const masterLog = debuglog('process-pool-master');

export class ProcessPool {
  /** 进程池最大数量 */
  private maxProcess = 0;

  /** 空闲进程存活时间(单位: 毫秒)，如果设置为0则表示不进行回收 */
  private keepAliveTime: number;

  /** 空闲进程 */
  private idlePool = new Set<cluster.Worker>();

  /** 空闲进程销毁的定时器 */
  private destroyTimer = new Map<cluster.Worker, NodeJS.Timeout>();

  /** 当前已申请的进程数 */
  private workerCount = 0;

  /** 空闲工作进程数 */
  private idleWorkerCount = 0;

  /** 主进程接受工作进程的message事件 */
  private messageEvent: MessageEvent = new EventEmitter();

  /** 主进程接受工作进程的用户自定义message事件 */
  private workerEvent: MessageEvent = new EventEmitter();

  private pullInterval: number = 100;

  constructor(options: Options) {
    if (cluster.isWorker) {
      throw new Error('ClusterWorker must run in master!');
    }
    this.maxProcess = options.maxProcess;
    this.keepAliveTime = options.keepAliveTime;
    this.pullInterval = options.pullInterval || this.pullInterval;

    cluster.setupMaster({ exec: __filename });
    cluster.on('online', (worker) => {
      masterLog(`子进程${ worker.process.pid }启动成功！`);
      // 子进程建立成功后分配任务
      worker.send({ type: 'pre-launch', task: worker.task });
    });

    cluster.on('exit', (worker) => {
      this.removeWorkerIdle(worker);
      this.workerCount--;
      if (worker.activeDestroy) {
        masterLog(`工作进程 ${ worker.process.pid } 已退出，当前剩余进程数 ${ this.workerCount }`);
        return;
      }
    });

    this.messageEvent.on('ready', (worker) => {
      worker.send({ type: 'run' });
    });

    this.messageEvent.on('finish', (worker, message) => {
      masterLog(`任务 ${ message.id } 执行${ message.success ? '成功' : '失败' }，耗时(${ message.takeUpTime })ms`);
      // 标记进程空闲
      this.setWorkerIdle(worker);
      // 进入销毁期
      this.destoryStage(worker);
    });

    cluster.on('message', (worker, message) => {
      if (message.type === 'ready' || message.type === 'finish') {
        this.messageEvent.emit(message.type, worker, message);
      } else {
        this.workerEvent.emit(message.type, message.data);
      }
    });
  }

  public onWorker(type: string, callback: (data: any) => void) {
    this.workerEvent.on(type, callback);
  }

  public async listen(getTask: (count: number) => Promise<Task[]>) {
    while (true) {
      const count = this.maxProcess - this.workerCount + this.idleWorkerCount;
      if (count < 1) {
        await new Promise((resolve) => setTimeout(resolve, this.pullInterval));
        continue;
      }
      const taskList = await getTask(count);
      if (taskList.length < 1) {
        await new Promise((resolve) => setTimeout(resolve, this.pullInterval));
        continue;
      }
      assignTask: for (const task of taskList) {
        // 如有空闲进程直接分配
        for (const worker of this.idlePool) {
          this.removeWorkerIdle(worker);
          worker.send({ type: 'pre-launch', task });
          continue assignTask;
        }

        // 如不存在空闲进程并且未达到进程池数量上限，则创建新的进程
        this.workerCount ++;
        const worker = cluster.fork(process.env);
        worker.task = task;
      }
    }
  }

  /**
   * 标记工作进程为空闲
   * @param worker 工作进程
   */
  private setWorkerIdle(worker: cluster.Worker) {
    if (this.idlePool.add(worker)) {
      this.idleWorkerCount ++;
    }
  }

  /**
   * 取消标记工作进程空闲
   * @param worker 工作进程
   */
  private removeWorkerIdle(worker: cluster.Worker) {
    this.cancelDestoryStage(worker);
    if (this.idlePool.delete(worker)) {
      this.idleWorkerCount --;
    }
  }

  /**
   * 工作进程进入销毁期
   * @param worker 工作进程
   */
  private destoryStage(worker: cluster.Worker) {
    if (this.keepAliveTime) {
      this.cancelDestoryStage(worker);
      this.destroyTimer.set(worker, setTimeout(() => {
        this.removeWorkerIdle(worker);
        this.destroyTimer.delete(worker);
        worker.activeDestroy = true;
        worker.send({ type: 'end' });
      }, this.keepAliveTime));
    }
  }

  /**
   * 取消工作进程销毁
   * @param worker 工作进程
   */
  private cancelDestoryStage(worker: cluster.Worker) {
    if (this.keepAliveTime) {
      const timer = this.destroyTimer.get(worker);
      if (timer) {
        clearTimeout(timer);
        this.destroyTimer.delete(worker);
      }
    }
  }
}

export abstract class Worker {
  /** 运行前的准备工作 */
  public abstract preLaunch(...args): Promise<void>

  /** 主启动方法 */
  public abstract run(...args): Promise<void>

  /** 进程退出前执行 */
  public abstract end(): Promise<void>

  protected send(type: string, data: any) {
    process.send({ type, data });
  }
}

if (cluster.isWorker) {
  let app: Worker = null;
  let task: Task = null;
  const workerLog = debuglog('process-pool-worker');
  let executableFilePath: string = '';
  process.on('message', async (message) => {
    switch (message.type) {
      case 'pre-launch':
        task = message.task;
        workerLog(`得到任务: ${ task.id }`);
        if (executableFilePath !== task.executableFilePath) {
          app = new (require(task.executableFilePath).default)();
          await app.preLaunch(...(task.preArgs || []));
        }
        process.send({ type: 'ready' });
        break;
      case 'run':
        const beginStamp = Date.now();
        let success = false;
        let i = 0;
        for (; i < task.retry + 1 && !success; i++) {
          try {
            const promiseList = [];
            let timer = null;
            if (task.timeout > 0) {
              let timeoutResolve = null;
              timer = setTimeout(() => {
                success = false;
                workerLog(`任务 ${ task.id } 超时!`);
                timeoutResolve();
              }, task.timeout);
              promiseList.push(new Promise((resolve) => {
                timeoutResolve = resolve;
              }));
            }
            promiseList.push(app.run(...task.args).then(() => {
              success = true;
              if (timer) {
                clearTimeout(timer);
              }
            }));
            await Promise.race(promiseList);
          } catch (error) {
            workerLog('unkown error', error);
          }
        }
        process.send({
          type: 'finish',
          id: task.id,
          retry: i,
          success,
          takeUpTime: Date.now() - beginStamp,
        });
        break;
      case 'end':
        await app.end();
        process.exit(0);
      default:
        workerLog('unkonw type', message.type);
        break;
    }
  });
}
