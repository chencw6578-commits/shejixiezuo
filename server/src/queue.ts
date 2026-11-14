/**
 * 极简 FIFO 队列：常驻进程（本地 / Docker）用进程内队列串行执行；
 * Vercel Serverless 没有跨请求的常驻 worker，改用平台 waitUntil 让任务在响应
 * 发出后继续执行（api/[...path].mjs 会注入 globalThis.__waitUntil）。
 */
type Task<T> = () => Promise<T>;
type WaitUntil = (promise: Promise<unknown>) => void;

const queue: Task<unknown>[] = [];
let active = 0;
let concurrency = 2;

const runtime = globalThis as typeof globalThis & { __waitUntil?: WaitUntil };

export function setConcurrency(n: number) {
  concurrency = Math.max(1, n);
}

export function enqueue<T>(task: Task<T>): Promise<T> {
  const wu = runtime.__waitUntil;
  if (wu) {
    // Serverless：立即执行并注册给平台，实例在响应后不会被提前冻结。
    // 仍返回原 promise，调用方的 .then/.catch 行为保持不变。
    const p = Promise.resolve().then(task);
    wu(p.then(() => undefined, () => undefined));
    return p;
  }
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

/** 一次性 fire-and-forget 任务（如注册后的验证邮件）：Serverless 下同样挂 waitUntil。 */
export function runInBackground(p: Promise<unknown>): void {
  const safe = p.catch(() => undefined);
  const wu = runtime.__waitUntil;
  if (wu) wu(safe);
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
