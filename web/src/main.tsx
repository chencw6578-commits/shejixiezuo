import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import HomePage from './pages/HomePage';
import ProjectCanvasPage from './pages/ProjectCanvasPage';
import FilePage from './pages/FilePage';
import SpecPage from './pages/SpecPage';
import ViewerPage from './pages/ViewerPage';
import './styles.css';

const router = createBrowserRouter([
  { path: '/', element: <HomePage /> },
  { path: '/projects/:projectId', element: <ProjectCanvasPage /> },
  { path: '/files/:fileId', element: <FilePage /> },
  { path: '/files/:fileId/spec', element: <SpecPage /> },
  { path: '/files/:fileId/frames/:frameId', element: <ViewerPage /> },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
