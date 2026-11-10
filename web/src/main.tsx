import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Navigate, createBrowserRouter, RouterProvider, useLocation } from 'react-router-dom';
import { api } from './api';
import HomePage from './pages/HomePage';
import ProjectCanvasPage from './pages/ProjectCanvasPage';
import FilePage from './pages/FilePage';
import SpecPage from './pages/SpecPage';
import ViewerPage from './pages/ViewerPage';
import LoginPage from './pages/LoginPage';
import VerifyPage from './pages/VerifyPage';
import InvitePage from './pages/InvitePage';
import ResetPage from './pages/ResetPage';
import './styles.css';

/** 登录守卫：未登录跳转 /login 并记录来源页，登录后回跳 */
function Protected({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'checking' | 'ok' | 'deny'>('checking');
  const loc = useLocation();

  useEffect(() => {
    api
      .me()
      .then(() => setState('ok'))
      .catch(() => setState('deny'));
  }, []);

  if (state === 'checking') return <div className="page-msg">加载中…</div>;
  if (state === 'deny') return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/verify', element: <VerifyPage /> },
  { path: '/invite', element: <InvitePage /> },
  { path: '/reset', element: <ResetPage /> },
  { path: '/', element: <Protected><HomePage /></Protected> },
  { path: '/projects', element: <Protected><HomePage /></Protected> },
  { path: '/projects/:projectId', element: <Protected><ProjectCanvasPage /></Protected> },
  { path: '/files/:fileId', element: <Protected><FilePage /></Protected> },
  { path: '/files/:fileId/spec', element: <Protected><SpecPage /></Protected> },
  { path: '/files/:fileId/frames/:frameId', element: <Protected><ViewerPage /></Protected> },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
