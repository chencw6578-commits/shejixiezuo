import { useState } from 'react';
import type { FrameDetail, LayerNode, ParsedColor } from '../types';
import { api } from '../api';
import { generateSnippet, SNIPPET_LANGS, type SnippetLang } from './snippets';

interface Props {
  frame: FrameDetail['frame'];
  nodeCount: number;
  selected: LayerNode | null;
  fileId: string;
}

const TYPE_LABEL: Record<string, string> = {
  FRAME: '容器', GROUP: '编组', COMPONENT: '组件', INSTANCE: '实例', TEXT: '文本',
  RECTANGLE: '矩形', ELLIPSE: '椭圆', VECTOR: '矢量', LINE: '直线', SLICE: '切片',
  BOOLEAN_OPERATION: '布尔', REGULAR_POLYGON: '多边形', STAR: '星形',
};

function CopyChip({ text, children }: { text: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-chip"
      title={`点击复制 ${text}`}
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => undefined
        );
      }}
    >
      {copied ? '已复制 ✓' : children}
    </button>
  );
}

function ColorRow({ color, label }: { color: ParsedColor; label?: string }) {
  return (
    <CopyChip text={color.hex}>
      <span className="swatch" style={{ background: color.rgba }} />
      <span className="mono">{color.hex}</span>
      <span className="dim">{Math.round(color.alpha * 100)}%</span>
      {label && <span className="dim">{label}</span>}
    </CopyChip>
  );
}

export default function PropertyPanel({ frame, nodeCount, selected, fileId }: Props) {
  const [format, setFormat] = useState('PNG');
  const [scale, setScale] = useState('2');
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState('');
  const [error, setError] = useState('');
  const [snippetLang, setSnippetLang] = useState<SnippetLang>('CSS');
  const [snippetCopied, setSnippetCopied] = useState(false);

  if (!selected) {
    return (
      <div className="prop-panel">
        <div className="prop-section">
          <h3>画板</h3>
          <div className="kv"><span>名称</span><b>{frame.name}</b></div>
          <div className="kv"><span>尺寸</span><b>{Math.round(frame.width)} × {Math.round(frame.height)}</b></div>
          <div className="kv"><span>图层数</span><b>{nodeCount}</b></div>
        </div>
        <p className="prop-hint">点击画布或左侧图层层树中的图层，查看尺寸、颜色、字体与切图。</p>
      </div>
    );
  }

  // 旧数据（种子/Figma 早期导入）的 props 可能缺数组字段，这里统一兜底
  const p = {
    ...selected.props,
    fills: selected.props.fills ?? [],
    strokes: selected.props.strokes ?? [],
    effects: selected.props.effects ?? [],
    exportPresets: selected.props.exportPresets ?? [],
  };
  const isSvg = format === 'SVG' || format === 'PDF';

  const doExport = async (presetFormat?: string, presetScale?: number) => {
    setExporting(true);
    setError('');
    setExportMsg('');
    try {
      const r = await api.exportAsset({
        fileId,
        nodeId: selected.node_id,
        name: selected.name,
        format: presetFormat ?? format,
        scale: presetScale ?? Number(scale),
      });
      api.download(r.url, `${selected.name}${presetScale && presetScale !== 1 ? `@${presetScale}x` : Number(scale) !== 1 ? `@${scale}x` : ''}.${(presetFormat ?? format).toLowerCase()}`);
      setExportMsg(`已导出 ${(r.size / 1024).toFixed(1)} KB`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="prop-panel">
      <div className="prop-header">
        <span className="prop-type">{TYPE_LABEL[selected.type] ?? selected.type}</span>
        <b className="prop-name" title={selected.name}>{selected.name}</b>
      </div>

      {/* 位置尺寸 */}
      <div className="prop-section">
        <h3>位置与尺寸</h3>
        <div className="kv-grid">
          <div className="kv"><span>X</span><b>{selected.x}</b></div>
          <div className="kv"><span>Y</span><b>{selected.y}</b></div>
          <div className="kv"><span>W</span><b>{selected.width}</b></div>
          <div className="kv"><span>H</span><b>{selected.height}</b></div>
          {p.cornerRadius !== undefined && p.cornerRadius > 0 && (
            <div className="kv"><span>圆角</span><b>{p.cornerRadius}</b></div>
          )}
          {p.cornerRadii && (
            <div className="kv"><span>四角</span><b>{p.cornerRadii.join(' / ')}</b></div>
          )}
          <div className="kv"><span>透明度</span><b>{Math.round(p.opacity * 100)}%</b></div>
        </div>
      </div>

      {/* 文本 */}
      {p.text && (
        <div className="prop-section">
          <h3>文本</h3>
          {p.text.content && <div className="text-content">{p.text.content}</div>}
          {p.text.family && <div className="kv"><span>字体</span><b>{p.text.family}</b></div>}
          {p.text.size && <div className="kv"><span>字号</span><b>{p.text.size}px / {p.text.weight ?? 400}</b></div>}
          {p.text.lineHeight && <div className="kv"><span>行高</span><b>{p.text.lineHeight}px</b></div>}
          {p.text.letterSpacing !== undefined && <div className="kv"><span>字间距</span><b>{p.text.letterSpacing}px</b></div>}
          {p.text.alignHorizontal && <div className="kv"><span>对齐</span><b>{p.text.alignHorizontal}</b></div>}
          {p.text.color && <ColorRow color={p.text.color} />}
        </div>
      )}

      {/* 填充 */}
      {p.fills.filter((f) => f.visible).length > 0 && (
        <div className="prop-section">
          <h3>填充</h3>
          {p.fills.filter((f) => f.visible).map((f, i) => {
            if (f.type === 'solid' && f.color) return <ColorRow key={i} color={f.color} />;
            if (f.type === 'gradient')
              return (
                <div key={i} className="fill-row">
                  <span className="swatch swatch-lg" style={{ background: f.css ?? undefined }} />
                  <span className="dim">渐变</span>
                </div>
              );
            if (f.type === 'image')
              return (
                <div key={i} className="fill-row">
                  <span className="swatch swatch-lg swatch-img" />
                  <span className="dim">图像填充（{f.scaleMode}）</span>
                </div>
              );
            return <div key={i} className="fill-row"><span className="dim">{f.type}</span></div>;
          })}
        </div>
      )}

      {/* 描边 */}
      {p.strokes.filter((s) => s.visible).length > 0 && (
        <div className="prop-section">
          <h3>描边</h3>
          {p.strokes.filter((s) => s.visible).map((s, i) =>
            s.color ? <ColorRow key={i} color={s.color} label={p.strokeWeight ? `${p.strokeWeight}px` : undefined} /> : null
          )}
        </div>
      )}

      {/* 效果 */}
      {p.effects.length > 0 && (
        <div className="prop-section">
          <h3>效果</h3>
          {p.effects.map((e, i) => (
            <div key={i} className="effect-row">
              <span className="dim">{e.type === 'DROP_SHADOW' ? '投影' : e.type === 'INNER_SHADOW' ? '内阴影' : e.type}</span>
              {e.css && <code className="mono small">{e.css}</code>}
            </div>
          ))}
        </div>
      )}

      {/* 代码片段 */}
      <div className="prop-section">
        <h3>代码</h3>
        <div className="snippet-tabs">
          {SNIPPET_LANGS.map((l) => (
            <button
              key={l}
              className={`snippet-tab ${snippetLang === l ? 'active' : ''}`}
              onClick={() => setSnippetLang(l)}
            >
              {l}
            </button>
          ))}
        </div>
        <pre className="snippet-code">{generateSnippet(snippetLang, selected)}</pre>
        <button
          className="copy-btn"
          onClick={() => {
            navigator.clipboard?.writeText(generateSnippet(snippetLang, selected)).then(
              () => {
                setSnippetCopied(true);
                setTimeout(() => setSnippetCopied(false), 1200);
              },
              () => undefined
            );
          }}
        >
          {snippetCopied ? '已复制 ✓' : '复制代码'}
        </button>
      </div>

      {/* 切图导出 */}
      <div className="prop-section">
        <h3>切图导出</h3>
        {p.exportPresets.length > 0 && (
          <div className="preset-row">
            {p.exportPresets.map((ps, i) => (
              <button key={i} className="preset-btn" disabled={exporting} onClick={() => doExport(ps.format, ps.scale)}>
                {ps.format}{ps.suffix} {ps.scale}x
              </button>
            ))}
            <span className="dim">设计标记的导出预设</span>
          </div>
        )}
        <div className="export-controls">
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option>PNG</option><option>SVG</option><option>JPG</option><option>PDF</option>
          </select>
          <select value={scale} onChange={(e) => setScale(e.target.value)} disabled={isSvg}>
            <option value="0.5">0.5x</option><option value="1">1x</option>
            <option value="2">2x</option><option value="3">3x</option><option value="4">4x</option>
          </select>
          <button className="primary-btn" disabled={exporting} onClick={() => doExport()}>
            {exporting ? '导出中…' : '导出切图'}
          </button>
        </div>
        {p.hasImageFill && (
          <p className="dim small hint">该图层含图像填充，导出 PNG 会带出填充图。</p>
        )}
        {exportMsg && <p className="ok small">{exportMsg}</p>}
        {error && <p className="err small">{error}</p>}
      </div>
    </div>
  );
}
