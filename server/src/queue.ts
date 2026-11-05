/** 极简进程内 FIFO 队列：串行执行任务，进程重启则丢失（MVP 足够，重启后可重新导入）。 */
type Task<T> = () => Promise<T>;

const queue: Task<unknown>[] = [];
let active = 0;
let concurrency = 2;

export function setConcurrency(n: number) {
  concurrency = Math.max(1, n);
}

export function enqueue<T>(task: Task<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push(async () => {
      try {
        resolve(await task());
      } catch (err) {
        reject(err);
      }
    });
    void pump();
  });
}

export function queueDepth() {
  return { pending: queue.length, active };
}

async function pump() {
  while (active < concurrency && queue.length > 0) {
    const task = queue.shift()!;
    active++;
    task().catch(() => {}).finally(() => {
      active--;
      void pump();
    });
  }
}
