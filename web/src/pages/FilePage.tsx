import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, getIdentity, getMeCached, setActiveTeam } from '../api';
import type { FileDetail, FrameRow } from '../types';
import { useDialogs } from '../components/Dialogs';

export default function FilePage() {
  const { fileId = '' } = useParams();
  const dialogs = useDialogs();
  const [file, setFile] = useState<FileDetail | null>(null);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [readOnly, setReadOnly] = useState(false);

  /**
   * 与服务端 editGuard 对齐的只读判定：
   * - 团队稿：优先用体验身份（localStorage identity），否则用成员表真实角色（/api/teams my_role）。
   *   旧实现只看 identity——普通协作者从不写入 identity，导致删除/同步按钮可见、点击 403。
   * - 个人空间稿：登录即可管理，未登录只读。
   * - 角色查询失败时保守按只读处理（宁可少显示按钮，不让协作者点了报 403）。
   */
  const computeReadOnly = useCallback(async (teamId: string | null): Promise<boolean> => {
    if (teamId) {
      const identity = getIdentity(teamId);
      if (identity) return identity.role === 'collaborator';
      try {
        const teams = await api.listTeams();
        const role = teams.find((t) => t.id === teamId)?.my_role;
        return role === 'collaborator' || role == null;
      } catch {
        return true;
      }
    }
    return !getMeCached();
  }, []);

  const load = useCallback(() => {
    api
      .getFile(fileId)
      .then(async (f) => {
        setFile(f);
        setActiveTeam(f.team_id ?? null);
        setReadOnly(await computeReadOnly(f.team_id ?? null));
      })
      .catch((e) => setError(e.message));
  }, [fileId, computeReadOnly]);

  useEffect(load, [load]);

  // 未就绪时轮询
  useEffect(() => {
    if (!file || file.status === 'ready' || file.status === 'failed') return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [file, load]);

  if (error) return <div className="page-msg">错误：{error} <Link to="/projects">返回</Link></div>;
  if (!file) return <div className="page-msg">加载中…</div>;

  const frames = file.frames ?? [];
  const loading = file.status === 'pending' || file.status === 'processing';

  return (
    <div className="file-page">
      <header className="topbar">
        <Link to={file.project_id ? `/projects/${file.project_id}` : '/'} className="back">← 返回画板</Link>
        <h1>{file.name}</h1>
        <span className={`status ${file.status === 'ready' ? 'status-ok' : file.status === 'failed' ? 'status-err' : 'status-wait status-pulse'}`}>
          {file.status === 'ready' ? `共 ${frames.length} 个画板` : file.status === 'failed' ? '解析失败' : '解析中…'}
        </span>
        <span className="spacer" />
        {readOnly && <span className="readonly-tag">协作者 · 只读</span>}
        {syncMsg && <span className={`small ${syncMsg.includes('已') && !syncMsg.includes('失败') ? 'ok' : 'dim'}`}>{syncMsg}</span>}
        {!readOnly && (
          <button
            className="ghost-btn"
            disabled={syncing || loading}
            onClick={async () => {
              setSyncing(true);
              setSyncMsg('');
              try {
                const r = await api.syncFile(fileId);
                setSyncMsg(r.updated ? '发现新版本，正在重新导入' : '已是最新版本');
              } catch (e) {
                setSyncMsg(`同步失败：${e instanceof Error ? e.message : e}`);
              } finally {
                setSyncing(false);
                load();
              }
            }}
          >
            {syncing ? '同步中…' : '重新同步'}
          </button>
        )}
        {file.status === 'ready' && frames.length > 0 && (
          <>
            <a
              className="ghost-btn"
              href={`/api/files/${fileId}/prototype`}
              target="_blank"
              rel="noreferrer"
              title="在浏览器新标签页打开可交互原型"
            >
              预览原型
            </a>
            <a
              className="ghost-btn"
              href={`/api/files/${fileId}/prototype.zip`}
              title="下载可交互静态网页（index.html + assets，可直接部署）"
            >
              导出原型
            </a>
            <Link className="primary-link" to={`/files/${fileId}/spec`}>设计规范</Link>
          </>
        )}
        {!readOnly && (
          <button
            className="ghost-btn"
            onClick={async () => {
              const ok = await dialogs.confirm({
                title: '删除设计稿',
                message: `确认删除「${file.name}」？其中的画板、图层与评论将一并删除，且不可恢复。`,
                confirmText: '删除',
                danger: true,
              });
              if (!ok) return;
              await api.deleteFile(fileId);
              location.href = file.project_id ? `/projects/${file.project_id}` : '/';
            }}
          >
            删除
          </button>
        )}
      </header>

      {file.error && <div className="page-msg err">{file.error}</div>}
      {loading && (
        <div className="page-msg">
          正在从 Figma 拉取文件并解析图层，画板越多耗时越久，可稍后刷新…
        </div>
      )}

      {!loading && frames.length === 0 && <div className="page-msg">该文件没有可展示的画板</div>}

      <div className="frame-grid">
        {frames.map((f: FrameRow) => (
          <Link key={f.id} className="frame-card" to={`/files/${fileId}/frames/${f.id}`}>
            <div className="frame-thumb">
              {f.thumb_url ? (
                <img src={f.thumb_url} alt={f.name} loading="lazy" />
              ) : (
                <span className="no-thumb">无预览</span>
              )}
            </div>
            <div className="frame-info">
              <span className="frame-name" title={f.name}>{f.name}</span>
              <span className="frame-size">{Math.round(f.width)} × {Math.round(f.height)}</span>
            </div>
          </Link>
        ))}
      </div>
      {dialogs.element}
    </div>
  );
}
