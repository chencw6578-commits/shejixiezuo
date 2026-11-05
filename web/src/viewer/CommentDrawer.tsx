import { useEffect, useRef, useState } from 'react';
import type { CommentItem } from '../api';

interface Props {
  comments: CommentItem[];
  activeId: string | null;
  author: string;
  nodeNames: Map<string, string>;
  onAuthorChange: (name: string) => void;
  onClose: () => void;
  onReply: (rootId: string, body: string) => Promise<void>;
  onResolve: (id: string, resolved: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export default function CommentDrawer({
  comments, activeId, author, nodeNames, onAuthorChange, onClose, onReply, onResolve, onDelete,
}: Props) {
  const [replyBody, setReplyBody] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const activeRef = useRef<HTMLDivElement>(null);

  const roots = comments
    .filter((c) => !c.parent_id)
    .sort((a, b) => Number(a.resolved) - Number(b.resolved) || a.created_at.localeCompare(b.created_at));

  useEffect(() => {
    if (activeId) activeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeId]);

  const send = async (rootId: string) => {
    const body = (replyBody[rootId] ?? '').trim();
    if (!body) return;
    setBusy(true);
    try {
      await onReply(rootId, body);
      setReplyBody((m) => ({ ...m, [rootId]: '' }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="comments-drawer">
      <header className="comments-header">
        <h3>评论 <span className="dim">({roots.filter((r) => !r.resolved).length} 未解决)</span></h3>
        <button className="icon-btn" onClick={onClose} title="关闭">✕</button>
      </header>
      <div className="author-row">
        <span className="dim small">我的昵称</span>
        <input
          value={author}
          onChange={(e) => onAuthorChange(e.target.value)}
          placeholder="匿名"
          maxLength={40}
        />
      </div>
      <div className="comments-list">
        {roots.length === 0 && <p className="empty small">还没有评论。开启评论模式后点击画布或图层即可添加。</p>}
        {roots.map((root) => {
          const replies = comments.filter((c) => c.parent_id === root.id);
          return (
            <div key={root.id} ref={root.id === activeId ? activeRef : undefined} className={`thread ${root.id === activeId ? 'active' : ''} ${root.resolved ? 'resolved' : ''}`}>
              <div className="thread-head">
                <span className="avatar">{root.author.slice(0, 1).toUpperCase()}</span>
                <b>{root.author}</b>
                {root.node_id && nodeNames.get(root.node_id) && (
                  <span className="node-chip" title={nodeNames.get(root.node_id)}>{nodeNames.get(root.node_id)}</span>
                )}
                <span className="dim small">{fmtTime(root.created_at)}</span>
              </div>
              <p className="thread-body">{root.body}</p>
              {replies.map((r) => (
                <div key={r.id} className="reply">
                  <span className="avatar avatar-sm">{r.author.slice(0, 1).toUpperCase()}</span>
                  <div>
                    <span className="small"><b>{r.author}</b> <span className="dim">{fmtTime(r.created_at)}</span></span>
                    <p className="thread-body">{r.body}</p>
                  </div>
                </div>
              ))}
              <div className="reply-input">
                <input
                  placeholder={`回复 ${root.author}…`}
                  value={replyBody[root.id] ?? ''}
                  onChange={(e) => setReplyBody((m) => ({ ...m, [root.id]: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && void send(root.id)}
                />
                <button className="primary-btn" disabled={busy || !(replyBody[root.id] ?? '').trim()} onClick={() => void send(root.id)}>
                  回复
                </button>
              </div>
              <div className="thread-actions">
                <button className="link-btn" onClick={() => void onResolve(root.id, !root.resolved)}>
                  {root.resolved ? '取消解决' : '标记已解决'}
                </button>
                <button className="link-btn danger" onClick={() => void onDelete(root.id)}>删除</button>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
