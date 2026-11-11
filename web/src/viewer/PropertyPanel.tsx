import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { FrameDetail, LayerNode, ParsedColor } from '../types';
import { api } from '../api';
import { EXPORT_SCALES, PLATFORM_LABEL, type PlatformId } from './devices';
import { generateSnippet, SNIPPET_LANGS, type SnippetLang } from './snippets';
import { metricToPx, renderable } from './textMetric';
import type { Unit } from '../unit';

interface Props {
  frame: FrameDetail['frame'];
  nodeCount: number;
  selected: LayerNode | null;
  /** 尺寸单位：只影响数值后缀，不改变数值 */
  unit?: Unit;
  /** 坐标：absolute = 相对画板左上角；relative = 相对父级图层（顶层图层与 absolute 相同） */
  coords?: {
    absolute: { x: number; y: number };
    relative: { x: number; y: number };
    parentName: string | null;
  } | null;
  fileId: string;
  readOnly?: boolean;
  /** 文本内容写回后通知外层重新拉取画板数据（让画布同步更新） */
  onNodeUpdated?: () => void;
}

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
    <CopyChip text={renderable(color.hex)}>
      <span className="swatch" style={{ background: typeof color.rgba === 'string' ? color.rgba : undefined }} />
      <span className="mono">{renderable(color.hex)}</span>
      <span className="dim">{renderable(Math.round((Number(color.alpha) || 1) * 100))}%</span>
      {label && <span className="dim">{renderable(label)}</span>}
    </CopyChip>
  );
}

export default function PropertyPanel({ frame, nodeCount, selected, coords, fileId, readOnly = false, unit = 'px', onNodeUpdated }: Props) {
  const [format, setFormat] = useState('PNG');
  const [scale, setScale] = useState('2');
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState('');
  const [error, setError] = useState('');
  const [snippetLang, setSnippetLang] = useState<SnippetLang>('CSS');
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [textCopied, setTextCopied] = useState(false);
  // 文本图层：内容回填 + 可编辑（失焦 / 回车写回数据库）
  const isText = selected?.type === 'TEXT';
  const [textDraft, setTextDraft] = useState(selected?.props?.text?.content ?? '');
  useEffect(() => {
    setTextDraft(selected?.props?.text?.content ?? '');
    setTextCopied(false);
  }, [selected?.node_id]);

  // 切图默认格式/倍率跟随 Figma Export 面板里设置好的预设。
  // 设计师常把预设打在图标外层容器上，用户点到内部 Vector 时也必须跟随父级标记，
  // 否则会按默认 2x 把 16.67×15.83 的内部路径裁成 33×32，且四边被切断。
  useEffect(() => {
    const ps = selected?.props?.exportPresets ?? [];
    const anc = selected?.exportPresetAncestor;
    if (ps.length) {
      setFormat(ps[0].format);
      setScale(String(ps[0].scale));
    } else if (anc) {
      setFormat(anc.format);
      setScale(String(anc.scale));
    } else {
      setFormat('PNG');
      setScale('2');
    }
  }, [selected?.node_id, selected?.exportPresetAncestor]);

  // 倍率分组跟随顶栏单位平台：pt→iOS / dp→Android / px→Web，其它平台分组不再显示
  //（用户要求：单位选 iOS 时，切图倍率下拉只保留 iOS 的 1x/2x/3x）
  const UNIT_PLATFORM: Record<Unit, PlatformId> = { pt: 'ios', dp: 'android', px: 'web' };
  const scaleGroups = EXPORT_SCALES[UNIT_PLATFORM[unit]];

  // 原型交互（跳转到画板）
  const [protoFrames, setProtoFrames] = useState<{ id: string; name: string }[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  useEffect(() => {
    api
      .getFile(fileId)
      .then((f) => {
        setProtoFrames((f.frames ?? []).map((x) => ({ id: x.id, name: x.name })));
        setProjectId(f.project_id ?? null);
      })
      .catch(() => undefined);
  }, [fileId]);
  const interactionTarget =
    (selected?.props as { interaction?: { targetFrameId?: string } } | undefined)?.interaction
      ?.targetFrameId ?? '';
  const [linkTarget, setLinkTarget] = useState(interactionTarget);
  useEffect(() => setLinkTarget(interactionTarget), [selected?.node_id, interactionTarget]);
  const setLink = async (v: string) => {
    setLinkTarget(v);
    if (!selected) return;
    try {
      await api.setInteraction(fileId, selected.node_id, v || null);
    } catch {
      setLinkTarget(interactionTarget);
    }
  };

  // 保存文本内容：失焦 / Enter 触发，成功后通知外层刷新画布
  const saveText = async () => {
    if (!selected || !isText || readOnly) return;
    const prev = selected.props?.text?.content ?? '';
    if (textDraft === prev) return;
    try {
      await api.setNodeText(fileId, selected.node_id, textDraft);
      onNodeUpdated?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : '文本保存失败');
    }
  };

  if (!selected) {
    return (
      <div className="prop-panel">
        <div className="prop-section">
          <h3>画板</h3>
          <div className="kv"><span>名称</span><b>{frame.name}</b></div>
          <div className="kv"><span>尺寸</span><b>{Math.round(frame.width)} × {Math.round(frame.height)} {unit}</b></div>
          <div className="kv"><span>图层数</span><b>{nodeCount}</b></div>
        </div>
        <p className="prop-hint">
          {nodeCount === 0 ? (
            <>
              该画板为图片，无结构数据，因此无法逐元素查看宽高、坐标、填充、字体等属性。
              {projectId ? (
                <>
                  {' '}
                  <Link className="prop-import-link" to={`/projects/${projectId}`}>
                    导入 Figma 文件
                  </Link>
                </>
              ) : null}
            </>
          ) : (
            '点击画布中的元素即可查看宽高、坐标、颜色、字体等属性，并可自选格式与倍率导出切图。'
          )}
        </p>
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

  // Figma 插件导入的文本度量可能是 {unit,value} 对象（PERCENT 相对字号）。
  // 统一换算成 px 数字再渲染，避免把对象直接当 React 子节点导致整页白屏。
  const textSize = metricToPx(p.text?.size);
  const lineHeightPx = metricToPx(p.text?.lineHeight, textSize ?? undefined);
  const letterSpacingPx = metricToPx(p.text?.letterSpacing, textSize ?? undefined);

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
      const from = r.resolvedFrom
        ? `（按 Figma 标记的父级「${r.resolvedFrom.name}」${r.resolvedFrom.format} ${r.resolvedFrom.scale}x 导出）`
        : '';
      setExportMsg(`已导出 ${(r.size / 1024).toFixed(1)} KB${from}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="prop-panel">
      {/* 顶部「容器/文本 + 名称」标题行已按需求移除：面板直接从「位置与尺寸」开始 */}

      {/* 位置尺寸 */}
      <div className="prop-section">
        <h3>位置与尺寸</h3>
        <div className="size-grid">
          <div className="size-cell">
            <span className="cell-label">X（相对父级）</span>
            <CopyChip text={String(coords?.relative.x ?? selected.x)}>
              <b>{coords?.relative.x ?? selected.x} {unit}</b>
            </CopyChip>
          </div>
          <div className="size-cell">
            <span className="cell-label">Y（相对父级）</span>
            <CopyChip text={String(coords?.relative.y ?? selected.y)}>
              <b>{coords?.relative.y ?? selected.y} {unit}</b>
            </CopyChip>
          </div>
          <div className="size-cell">
            <span className="cell-label">X（绝对）</span>
            <CopyChip text={String(coords?.absolute.x ?? selected.x)}>
              <b>{coords?.absolute.x ?? selected.x} {unit}</b>
            </CopyChip>
          </div>
          <div className="size-cell">
            <span className="cell-label">Y（绝对）</span>
            <CopyChip text={String(coords?.absolute.y ?? selected.y)}>
              <b>{coords?.absolute.y ?? selected.y} {unit}</b>
            </CopyChip>
          </div>
          <div className="size-cell"><span className="cell-label">W</span><CopyChip text={String(selected.width)}><b>{selected.width} {unit}</b></CopyChip></div>
          <div className="size-cell"><span className="cell-label">H</span><CopyChip text={String(selected.height)}><b>{selected.height} {unit}</b></CopyChip></div>
          {p.cornerRadius !== undefined && p.cornerRadius > 0 && (
            <div className="size-cell"><span className="cell-label">圆角</span><b className="cell-value">{renderable(p.cornerRadius)}</b></div>
          )}
          {p.cornerRadii && (
            <div className="size-cell"><span className="cell-label">四角</span><b className="cell-value">{renderable(p.cornerRadii)}</b></div>
          )}
          <div className="size-cell"><span className="cell-label">透明度</span><b className="cell-value">{renderable(Math.round((Number(p.opacity) || 1) * 100))}%</b></div>
        </div>
      </div>

      {/* 文本：仅 TEXT 图层显示，内容回填且可编辑（失焦 / Enter 写回并刷新画布） */}
      {isText && (
        <div className="prop-section">
          <h3>文本</h3>
          <div className="text-content-row">
            <textarea
              className="text-edit"
              value={textDraft}
              readOnly={readOnly}
              placeholder="空文本图层"
              rows={Math.min(6, Math.max(2, textDraft.split('\n').length))}
              onChange={(e) => {
                setTextDraft(e.target.value);
                setTextCopied(false);
              }}
              onBlur={() => void saveText()}
              onKeyDown={(e) => {
                // Enter 保存，Shift+Enter 换行（保留多行文本）
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void saveText();
                }
              }}
            />
            <button
              className="copy-btn"
              disabled={!textDraft.trim()}
              onClick={() => {
                navigator.clipboard?.writeText(textDraft).then(
                  () => {
                    setTextCopied(true);
                    setTimeout(() => setTextCopied(false), 1200);
                  },
                  () => undefined
                );
              }}
              title={textDraft.trim() ? '复制文本内容' : '文本为空，无可复制内容'}
            >
              {textCopied ? '已复制 ✓' : '复制文本'}
            </button>
          </div>
          {p.text?.family && <div className="kv"><span>字体</span><CopyChip text={renderable(p.text.family)}><b>{renderable(p.text.family)}</b></CopyChip></div>}
          {textSize !== null && textSize > 0 && (
            <div className="kv"><span>字号</span><CopyChip text={renderable(textSize)}><b>{renderable(textSize)}px / {renderable(p.text?.weight ?? 400)}</b></CopyChip></div>
          )}
          {lineHeightPx !== null && lineHeightPx > 0 && (
            <div className="kv"><span>行高</span><b>{renderable(lineHeightPx)}px</b></div>
          )}
          {letterSpacingPx !== null && (
            <div className="kv"><span>字间距</span><b>{renderable(letterSpacingPx)}px</b></div>
          )}
          {p.text?.alignHorizontal && <div className="kv"><span>对齐</span><b>{renderable(p.text.alignHorizontal)}</b></div>}
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
                  <span className="swatch swatch-lg" style={{ background: typeof f.css === 'string' ? f.css : undefined }} />
                  <span className="dim">渐变</span>
                </div>
              );
            if (f.type === 'image')
              return (
                <div key={i} className="fill-row">
                  <span className="swatch swatch-lg swatch-img" />
                  <span className="dim">图像填充（{renderable(f.scaleMode)}）</span>
                </div>
              );
            return <div key={i} className="fill-row"><span className="dim">{renderable(f.type)}</span></div>;
          })}
        </div>
      )}

      {/* 描边 */}
      {p.strokes.filter((s) => s.visible).length > 0 && (
        <div className="prop-section">
          <h3>描边</h3>
          {p.strokes.filter((s) => s.visible).map((s, i) =>
            s.color ? <ColorRow key={i} color={s.color} label={p.strokeWeight ? `${Math.round(Number(p.strokeWeight) * 100) / 100}px` : undefined} /> : null
          )}
        </div>
      )}

      {/* 效果 */}
      {p.effects.length > 0 && (
        <div className="prop-section">
          <h3>效果</h3>
          {p.effects.map((e, i) => (
            <div key={i} className="effect-row">
              <span className="dim">{e.type === 'DROP_SHADOW' ? '投影' : e.type === 'INNER_SHADOW' ? '内阴影' : renderable(e.type)}</span>
              {e.css && <code className="mono small">{renderable(e.css)}</code>}
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

      {/* 原型交互 */}
      <div className="prop-section">
        <h3>原型交互</h3>
        <div className="export-controls">
          <select
            value={linkTarget}
            onChange={(e) => void setLink(e.target.value)}
            disabled={readOnly}
            title={readOnly ? '协作者身份为只读，不能修改原型交互' : undefined}
          >
            <option value="">不跳转</option>
            {protoFrames
              .filter((f) => f.id !== frame.id)
              .map((f) => (
                <option key={f.id} value={f.id}>
                  跳转到「{f.name}」
                </option>
              ))}
          </select>
        </div>
      </div>

      {/* 切图导出：任意图层均可按自选格式与倍率导出（服务端渲染） */}
      <div className="prop-section">
        <h3>切图导出</h3>
        {p.exportPresets.length > 0 && (
          <div className="preset-row">
            {p.exportPresets.map((ps, i) => (
              <button key={i} className="preset-btn" disabled={exporting} onClick={() => doExport(ps.format, ps.scale)}>
                {renderable(ps.format)}{renderable(ps.suffix)} {renderable(ps.scale)}x
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
            {!scaleGroups.some((s) => s.value === scale) && <option value={scale}>{scale}x</option>}
            <optgroup label={PLATFORM_LABEL[UNIT_PLATFORM[unit]]}>
              {scaleGroups.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </optgroup>
          </select>
          <button className="primary-btn" disabled={exporting} onClick={() => doExport()}>
            {exporting ? '导出中…' : '导出切图'}
          </button>
        </div>
        {p.hasImageFill && (
          <p className="dim small hint">该图层含图像填充，整板裁剪会如实带出填充图。</p>
        )}
        {exportMsg && <p className="ok small">{exportMsg}</p>}
        {error && <p className="err small">{error}</p>}
      </div>
    </div>
  );
}
