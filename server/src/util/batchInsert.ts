import type { PoolClient } from 'pg';

/** 分块多行 INSERT，绕开 65535 参数上限。 */
export async function batchInsert(
  client: PoolClient,
  sqlHead: string,
  rows: unknown[][],
  chunkSize = 400
) {
  if (rows.length === 0) return;
  const cols = sqlHead.match(/\(([^)]+)\)/)?.[1].split(',').length ?? 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values: unknown[] = [];
    const tuples = chunk.map((row, r) => {
      const ph = row.map((_, c) => `$${r * cols + c + 1}`);
      values.push(...row);
      return `(${ph.join(',')})`;
    });
    await client.query(`${sqlHead} VALUES ${tuples.join(',')}`, values as unknown[]);
  }
}
