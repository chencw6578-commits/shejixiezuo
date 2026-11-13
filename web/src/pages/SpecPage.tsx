import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { SpecData } from '../types';
import { gradientHexList, parseGradientCss } from '../viewer/gradient';

export default function SpecPage() {
  const { fileId = '' } = useParams();
  const [file, setFile] = useState<{ name: string } | null>(null);
  const [spec, setSpec] = useState<SpecData | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  const copy = (text: string, key: string) => {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(key);
        setTimeout(() => setCopied((cur) => (cur === key ? '' : cur)), 1500);
      },
      () => undefined
    );
  };

  useEffect(() => {
    api.getFile(fileId).then((f) => setFile({ name: f.name })).catch((e) => setError(e.message));
    api
      .getSpec(fileId)
      .then(setSpec)
      .catch((e) => setError(e.message));
  }, [fileId]);

  if (error) return <div className="page-msg">错误：{error} <Link to={`/files/${fileId}`}>返回</Link></div>;
  if (!spec || !file) return <div className="page-msg">加载中…</div>;

  return (
    <div className="file-page">
      <header className="topbar">
        <Link to={`/files/${fileId}`} className="back">← 画板列表</Link>
        <h1>{file.name}</h1>
        <span className="crumb">设计规范</span>
        <span className="spacer" />
        <span className="dim">{spec.stats.nodeCount} 个图层 · {spec.colors.length} 色 · {spec.fonts.length} 种字体</span>
      </header>

      <div className="spec-page">
        <section className="spec-section">
          <h2>颜色 <span className="dim">点击复制 HEX，按使用次数排序</span></h2>
          {spec.colors.length === 0 && <p className="empty">暂无纯色填充</p>}
          <div className="color-grid">
            {spec.colors.map((c) => (
              <button
                key={c.hex}
                className="color-card"
                title={`点击复制 ${c.hex}`}
                onClick={() => navigator.clipboard?.writeText(c.hex)}
              >
                <span className="color-chip" style={{ background: c.rgba }} />
                <span className="mono">{c.hex}</span>
                {c.alpha < 1 && <span className="dim">α{Math.round(c.alpha * 100)}%</span>}
                <span className="dim">×{c.count}</span>
              </button>
            ))}
          </div>
        </section>

        {spec.gradients.length > 0 && (
          <section className="spec-section">
            <h2>渐变 <span className="dim">点击复制色号或整段 CSS</span></h2>
            <div className="color-grid">
              {spec.gradients.map((g, i) => {
                const grad = parseGradientCss(g.css);
                return (
                  <div key={i} className="grad-card" data-spec-gradient>
                    <button
                      className="color-card grad-card-main"
                      title="点击复制渐变 CSS"
                      onClick={() => copy(grad?.css ?? g.css, `css-${i}`)}
                    >
                      <span className="color-chip color-chip-lg" style={{ background: grad?.css ?? g.css }} />
                      <span className="dim">×{g.count} · {copied === `css-${i}` ? '已复制 ✓' : '复制 CSS'}</span>
                    </button>
                    <div className="grad-stop-list">
                      {(grad?.stops ?? []).map((s, j) => (
                        <button
                          key={j}
                          className="grad-copy-chip"
                          data-spec-stop={j}
                          title={`复制 ${s.cssValue}`}
                          onClick={() => copy(s.cssValue, `${i}-${j}`)}
                        >
                          <span className="grad-stop-dot" style={{ background: s.cssValue }} />
                          <span className="mono">{s.hex}</span>
                          <span className="dim">{Math.round(s.pos)}%</span>
                          {copied === `${i}-${j}` && <span className="grad-ok">✓</span>}
                        </button>
                      ))}
                      {grad && (
                        <button
                          className="grad-copy-chip"
                          title="复制全部色号"
                          onClick={() => copy(gradientHexList(grad), `hex-${i}`)}
                        >
                          {copied === `hex-${i}` ? '已复制 ✓' : '全部色号'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <section className="spec-section">
          <h2>字体 <span className="dim">按使用次数排序</span></h2>
          {spec.fonts.length === 0 && <p className="empty">暂无文本图层</p>}
          <table className="font-table">
            <thead>
              <tr><th>字体</th><th>字号</th><th>字重</th><th>预览</th><th>使用次数</th></tr>
            </thead>
            <tbody>
              {spec.fonts.map((f, i) => (
                <tr key={i}>
                  <td>{f.family}</td>
                  <td className="mono">{f.size}px</td>
                  <td className="mono">{f.weight}</td>
                  <td>
                    <span style={{ fontFamily: f.family, fontWeight: f.weight, fontSize: Math.min(f.size, 22) }}>
                      字体 Aa
                    </span>
                  </td>
                  <td className="dim">×{f.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
