import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface PromptOptions {
  title: string;
  label?: string;
  initialValue?: string;
  placeholder?: string;
  maxLength?: number;
  confirmText?: string;
  /** 返回错误文案表示校验不通过；返回 null 表示通过 */
  validate?: (value: string) => string | null;
}

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export interface AlertOptions {
  title?: string;
  message: ReactNode;
}

export interface ChooseOption {
  label: string;
  value: string;
  danger?: boolean;
}

export interface ChooseOptions {
  title: string;
  message: ReactNode;
  options: ChooseOption[];
  cancelText?: string;
}

/** 站内弹窗：替代浏览器原生 prompt / confirm / alert */
function Overlay({ children, onCancel }: { children: ReactNode; onCancel: () => void }) {
  return (
    <div
      className="dlg-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      {children}
    </div>
  );
}

function PromptDialog({
  opts,
  onClose,
}: {
  opts: PromptOptions;
  onClose: (value: string | null) => void;
}) {
  const [value, setValue] = useState(opts.initialValue ?? '');
  const [touched, setTouched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const trimmed = value.trim();
  let error: string | null = null;
  if (!trimmed) error = '名称不能为空';
  else if (opts.maxLength && trimmed.length > opts.maxLength) {
    error = `名称过长（最多 ${opts.maxLength} 个字符，当前 ${trimmed.length}）`;
  } else {
    error = opts.validate?.(trimmed) ?? null;
  }

  const submit = () => {
    setTouched(true);
    if (error) return;
    onClose(trimmed);
  };

  return (
    <Overlay onCancel={() => onClose(null)}>
      <div
        className="dlg"
        role="dialog"
        aria-modal="true"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose(null);
          }
        }}
      >
        <h2 className="dlg-title">{opts.title}</h2>
        {opts.label && <label className="dlg-label">{opts.label}</label>}
        <input
          ref={inputRef}
          className="dlg-input"
          value={value}
          placeholder={opts.placeholder}
          aria-invalid={touched && !!error}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="dlg-meta">
          {error ? (
            <span className={`dlg-error ${touched ? '' : 'is-hint'}`}>{error}</span>
          ) : (
            <span className="dlg-hint">Enter 确认 · Esc 取消</span>
          )}
          {opts.maxLength && <span className="dlg-count">{trimmed.length}/{opts.maxLength}</span>}
        </div>
        <div className="dlg-actions">
          <button className="dlg-btn" onClick={() => onClose(null)}>
            取消
          </button>
          <button className="dlg-btn is-primary" disabled={touched && !!error} onClick={submit}>
            {opts.confirmText ?? '确定'}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function ConfirmDialog({ opts, onClose }: { opts: ConfirmOptions; onClose: (ok: boolean) => void }) {
  return (
    <Overlay onCancel={() => onClose(false)}>
      <div
        className="dlg"
        role="dialog"
        aria-modal="true"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose(false);
          }
        }}
      >
        <h2 className="dlg-title">{opts.title}</h2>
        <div className="dlg-message">{opts.message}</div>
        <div className="dlg-actions">
          <button className="dlg-btn" onClick={() => onClose(false)}>
            {opts.cancelText ?? '取消'}
          </button>
          <button
            className={`dlg-btn ${opts.danger ? 'is-danger' : 'is-primary'}`}
            onClick={() => onClose(true)}
          >
            {opts.confirmText ?? '确定'}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function AlertDialog({ opts, onClose }: { opts: AlertOptions; onClose: () => void }) {
  return (
    <Overlay onCancel={onClose}>
      <div
        className="dlg"
        role="dialog"
        aria-modal="true"
        onKeyDown={(e) => {
          if (e.key === 'Escape' || e.key === 'Enter') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 className="dlg-title">{opts.title ?? '提示'}</h2>
        <div className="dlg-message">{opts.message}</div>
        <div className="dlg-actions">
          <button className="dlg-btn is-primary" autoFocus onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function ChooseDialog({ opts, onClose }: { opts: ChooseOptions; onClose: (value: string | null) => void }) {
  return (
    <Overlay onCancel={() => onClose(null)}>
      <div
        className="dlg"
        role="dialog"
        aria-modal="true"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose(null);
          }
        }}
      >
        <h2 className="dlg-title">{opts.title}</h2>
        <div className="dlg-message">{opts.message}</div>
        <div className="dlg-choices">
          {opts.options.map((o) => (
            <button
              key={o.value}
              className={`dlg-btn is-block ${o.danger ? 'is-danger' : ''}`}
              onClick={() => onClose(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div className="dlg-actions">
          <button className="dlg-btn" onClick={() => onClose(null)}>
            {opts.cancelText ?? '取消'}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

type PromptState = { opts: PromptOptions; resolve: (v: string | null) => void };
type ConfirmState = { opts: ConfirmOptions; resolve: (v: boolean) => void };
type AlertState = { opts: AlertOptions; resolve: () => void };
type ChooseState = { opts: ChooseOptions; resolve: (v: string | null) => void };

/**
 * 站内弹窗 hook。用法：
 * const dialogs = useDialogs();
 * const name = await dialogs.prompt({...});
 * 页面根节点渲染 {dialogs.element}
 */
export function useDialogs() {
  const [promptState, setPromptState] = useState<PromptState | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [alertState, setAlertState] = useState<AlertState | null>(null);
  const [chooseState, setChooseState] = useState<ChooseState | null>(null);

  const prompt = (opts: PromptOptions) =>
    new Promise<string | null>((resolve) => setPromptState({ opts, resolve }));
  const confirm = (opts: ConfirmOptions) =>
    new Promise<boolean>((resolve) => setConfirmState({ opts, resolve }));
  const alert = (message: ReactNode, title = '出错了') =>
    new Promise<void>((resolve) => setAlertState({ opts: { title, message }, resolve }));
  const choose = (opts: ChooseOptions) =>
    new Promise<string | null>((resolve) => setChooseState({ opts, resolve }));

  const element = (
    <>
      {promptState && (
        <PromptDialog
          opts={promptState.opts}
          onClose={(v) => {
            promptState.resolve(v);
            setPromptState(null);
          }}
        />
      )}
      {confirmState && (
        <ConfirmDialog
          opts={confirmState.opts}
          onClose={(ok) => {
            confirmState.resolve(ok);
            setConfirmState(null);
          }}
        />
      )}
      {alertState && (
        <AlertDialog
          opts={alertState.opts}
          onClose={() => {
            alertState.resolve();
            setAlertState(null);
          }}
        />
      )}
      {chooseState && (
        <ChooseDialog
          opts={chooseState.opts}
          onClose={(v) => {
            chooseState.resolve(v);
            setChooseState(null);
          }}
        />
      )}
    </>
  );

  return { prompt, confirm, alert, choose, element };
}
