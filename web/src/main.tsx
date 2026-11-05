import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import HomePage from './pages/HomePage';
import FilePage from './pages/FilePage';
import ViewerPage from './pages/ViewerPage';
import './styles.css';

const router = createBrowserRouter([
  { path: '/', element: <HomePage /> },
  { path: '/files/:fileId', element: <FilePage /> },
  { path: '/files/:fileId/frames/:frameId', element: <ViewerPage /> },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
