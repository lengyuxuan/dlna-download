import 'ioredis';
declare module 'cluster' {
  interface Worker {
    /** 任务 */
    task: {
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
    };
    /** 标记进程为主动销毁 */
    activeDestroy: boolean;
  }
}

declare module 'ioredis' {
  interface Commands {
    incrCurrent(key: string): Promise<[number, number, string]>;
  }
} 
