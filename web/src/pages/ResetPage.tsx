import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';

/** 密码重置落地页：/reset?token=xxx，公开路由 */
export default function ResetPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [state, setState] = useState<'form' | 'submitting' | 'ok' | 'fail'>(
    token ? 'form' : 'fail'
  );
  const [errMsg, setErrMsg] = useState('');

  useEffect(() => {
    if (!token) setErrMsg('链接不完整：缺少重置令牌');
  }, [token]);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (password.length < 8) {
        setErrMsg('密码至少 8 位');
        return;
      }
      if (password !== confirm) {
        setErrMsg('两次输入的密码不一致');
        return;
      }
      setErrMsg('');
      setState('submitting');
      try {
        await api.resetPassword(token, password);
        setState('ok');
      } catch (ex) {
        setErrMsg(ex instanceof Error ? ex.message : String(ex));
        setState('fail');
      }
    },
    [token, password, confirm]
  );

  return (
    <div className="auth-wrap">
      <div className="auth-card" style={{ textAlign: 'center' }}>
        <div className="auth-brand">
          <span className="logo">✦</span>
          <strong>设置新密码</strong>
        </div>

        {state === 'ok' ? (
          <>
            <p style={{ fontSize: 30, margin: '8px 0' }}>✅</p>
            <strong style={{ fontSize: 17 }}>密码已重置</strong>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '8px 0 16px' }}>
              请用新密码登录
            </p>
            <Link className="auth-submit" to="/login" style={{ display: 'block', textDecoration: 'none' }}>
              去登录
            </Link>
          </>
        ) : state === 'fail' && !token ? (
          <>
            <p style={{ fontSize: 30, margin: '8px 0' }}>❌</p>
            <p style={{ fontSize: 13, color: '#6b7280' }}>{errMsg}</p>
            <Link className="auth-submit" to="/login" style={{ display: 'block', textDecoration: 'none' }}>
              返回登录
            </Link>
          </>
        ) : (
          <form onSubmit={(e) => void submit(e)} style={{ textAlign: 'left' }}>
            <label>
              新密码
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="至少 8 位"
                autoComplete="new-password"
                required
              />
            </label>
            <label>
              确认新密码
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="再输入一次"
                autoComplete="new-password"
                required
              />
            </label>
            {errMsg && <p className="auth-err">{errMsg}</p>}
            <button
              type="submit"
              className="auth-submit"
              disabled={state === 'submitting' || !password || !confirm}
            >
              {state === 'submitting' ? '提交中…' : '重置密码'}
            </button>
            {state === 'fail' && token && (
              <p className="auth-err" style={{ textAlign: 'center' }}>
                链接可能已过期，请回到登录页重新发送
              </p>
            )}
          </form>
        )}

        <p className="auth-foot">
          <Link to="/login">返回登录</Link>
        </p>
      </div>
    </div>
  );
}
