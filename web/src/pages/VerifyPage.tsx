import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';

/** 邮件验证落地页：/verify?token=xxx，公开路由（无需登录） */
export default function VerifyPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [state, setState] = useState<'verifying' | 'ok' | 'fail'>(
    token ? 'verifying' : 'fail'
  );
  const [errMsg, setErrMsg] = useState('');

  const verify = useCallback(async (t: string) => {
    try {
      await api.verifyEmail(t);
      setState('ok');
    } catch (ex) {
      setErrMsg(ex instanceof Error ? ex.message : String(ex));
      setState('fail');
    }
  }, []);

  useEffect(() => {
    if (token) void verify(token);
  }, [token, verify]);

  return (
    <div className="auth-wrap">
      <div className="auth-card" style={{ textAlign: 'center' }}>
        {state === 'verifying' && (
          <>
            <p style={{ fontSize: 30, margin: '8px 0' }}>⏳</p>
            <strong style={{ fontSize: 17 }}>正在验证邮箱…</strong>
          </>
        )}
        {state === 'ok' && (
          <>
            <p style={{ fontSize: 30, margin: '8px 0' }}>✅</p>
            <strong style={{ fontSize: 17 }}>邮箱验证成功</strong>
            <p className="auth-brand" style={{ marginTop: 8 }}>
              <span style={{ fontSize: 12, color: '#6b7280' }}>账号已激活全部功能</span>
            </p>
            <Link className="auth-submit" to="/" style={{ display: 'block', textDecoration: 'none' }}>
              进入工作台
            </Link>
          </>
        )}
        {state === 'fail' && (
          <>
            <p style={{ fontSize: 30, margin: '8px 0' }}>❌</p>
            <strong style={{ fontSize: 17 }}>验证失败</strong>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '8px 0 16px' }}>
              {errMsg || '链接无效或已过期'}
            </p>
            <Link className="auth-submit" to="/login" style={{ display: 'block', textDecoration: 'none' }}>
              去登录后重新发送
            </Link>
          </>
        )}
        <p className="auth-foot">
          <Link to="/">先逛逛首页</Link>
        </p>
      </div>
    </div>
  );
}
