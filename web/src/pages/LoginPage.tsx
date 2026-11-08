import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, type AuthUser } from '../api';

/** 登录 / 注册双模式卡片页。登录成功后回到来源页或首页。 */
export default function LoginPage() {
  const nav = useNavigate();
  const loc = useLocation();
  const from = (loc.state as { from?: string } | null)?.from ?? '/';

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // 已登录则直接进入
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    api
      .me()
      .then(() => nav(from, { replace: true }))
      .catch(() => undefined)
      .finally(() => setChecked(true));
  }, [from, nav]);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setErr('');
      setBusy(true);
      try {
        const user =
          mode === 'login'
            ? await api.login(email.trim(), password)
            : await api.register(email.trim(), password, name.trim());
        nav(from, { replace: true });
      } catch (ex) {
        setErr(ex instanceof Error ? ex.message : String(ex));
      } finally {
        setBusy(false);
      }
    },
    [mode, email, password, name, nav, from]
  );

  if (!checked) return <div className="page-msg">加载中…</div>;

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="logo">✦</span>
          <strong>Design Handoff</strong>
          <p>设计协作与交付平台</p>
        </div>

        <div className="auth-tabs">
          <button className={mode === 'login' ? 'is-active' : ''} onClick={() => { setMode('login'); setErr(''); }}>
            登录
          </button>
          <button className={mode === 'register' ? 'is-active' : ''} onClick={() => { setMode('register'); setErr(''); }}>
            注册
          </button>
        </div>

        <form onSubmit={submit}>
          {mode === 'register' && (
            <label>
              昵称
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="怎么称呼你（可选）"
                autoComplete="nickname"
              />
            </label>
          )}
          <label>
            邮箱
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              required
            />
          </label>
          <label>
            密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'register' ? '至少 8 位' : '输入密码'}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              required
            />
          </label>

          {err && <p className="auth-err">{err}</p>}

          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? '请稍候…' : mode === 'login' ? '登录' : '创建账号'}
          </button>
        </form>

        <p className="auth-foot">
          <Link to="/">先逛逛首页</Link>
        </p>
      </div>
    </div>
  );
}
