import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type AuthUser } from '../api';

const ROLE_LABEL: Record<string, string> = { owner: '所有者', admin: '管理员', collaborator: '协作 · 只读' };

/** 团队邀请落地页：/invite?token=xxx，公开路由 */
export default function InvitePage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [info, setInfo] = useState<{ teamName: string; email: string; role: string } | null>(null);
  const [me, setMe] = useState<AuthUser | null>(null);
  const [checked, setChecked] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const [state, setState] = useState<'idle' | 'accepting' | 'ok' | 'fail'>('idle');
  const [errMsg, setErrMsg] = useState('');

  useEffect(() => {
    if (!token) {
      setLoadErr('链接不完整：缺少邀请令牌');
      setChecked(true);
      return;
    }
    api
      .inviteInfo(token)
      .then(setInfo)
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setChecked(true));
    api.me().then(setMe).catch(() => setMe(null));
  }, [token]);

  const accept = useCallback(async () => {
    setState('accepting');
    setErrMsg('');
    try {
      await api.acceptInvite(token);
      setState('ok');
    } catch (ex) {
      setErrMsg(ex instanceof Error ? ex.message : String(ex));
      setState('fail');
    }
  }, [token]);

  if (!checked) return <div className="page-msg">加载中…</div>;

  return (
    <div className="auth-wrap">
      <div className="auth-card" style={{ textAlign: 'center' }}>
        <div className="auth-brand">
          <span className="logo">✦</span>
          <strong>团队邀请</strong>
        </div>

        {loadErr ? (
          <>
            <p style={{ fontSize: 30, margin: '8px 0' }}>❌</p>
            <p style={{ fontSize: 13, color: '#6b7280' }}>{loadErr}</p>
            <Link className="auth-submit" to="/" style={{ display: 'block', textDecoration: 'none' }}>
              回首页
            </Link>
          </>
        ) : state === 'ok' && info ? (
          <>
            <p style={{ fontSize: 30, margin: '8px 0' }}>🎉</p>
            <strong style={{ fontSize: 17 }}>已加入 {info.teamName}</strong>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '8px 0 16px' }}>
              你的角色：{ROLE_LABEL[info.role] ?? info.role}
            </p>
            <Link className="auth-submit" to={`/projects`} style={{ display: 'block', textDecoration: 'none' }}>
              进入工作台
            </Link>
          </>
        ) : info ? (
          <>
            <p style={{ fontSize: 15, margin: '8px 0' }}>
              <b>{info.teamName}</b> 邀请你以
              <span className={`role-badge ${info.role}`} style={{ margin: '0 6px' }}>
                {ROLE_LABEL[info.role] ?? info.role}
              </span>
              身份加入
            </p>
            <p style={{ fontSize: 13, color: '#6b7280' }}>被邀请邮箱：{info.email}</p>

            {!me ? (
              <>
                <p style={{ fontSize: 13, color: '#92400e', margin: '14px 0 6px' }}>
                  请先注册 / 登录 <b>{info.email}</b> 账号，再回到本页面接受邀请
                </p>
                <Link
                  className="auth-submit"
                  to="/login"
                  state={{ from: `/invite?token=${token}` }}
                  style={{ display: 'block', textDecoration: 'none' }}
                >
                  去登录 / 注册
                </Link>
              </>
            ) : me.email !== info.email ? (
              <>
                <p style={{ fontSize: 13, color: '#92400e', margin: '14px 0 6px' }}>
                  当前登录的是 <b>{me.email}</b>，与本邀请不符
                </p>
                <Link
                  className="auth-submit"
                  to="/login"
                  state={{ from: `/invite?token=${token}` }}
                  style={{ display: 'block', textDecoration: 'none' }}
                >
                  切换账号登录
                </Link>
              </>
            ) : (
              <>
                {state === 'fail' && (
                  <p style={{ fontSize: 13, color: '#d92d20', margin: '10px 0 0' }}>{errMsg}</p>
                )}
                <button className="auth-submit" onClick={() => void accept()} disabled={state === 'accepting'}>
                  {state === 'accepting' ? '接受中…' : '接受邀请'}
                </button>
              </>
            )}
          </>
        ) : null}

        <p className="auth-foot">
          <Link to="/">先逛逛首页</Link>
        </p>
      </div>
    </div>
  );
}
