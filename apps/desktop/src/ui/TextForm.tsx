import { useState } from 'react';

/** 单行输入的小表单：新建作品、新建章节、重命名章节共用。回车提交，Esc 取消。 */
export function TextForm({
  label,
  initial = '',
  submitText,
  onSubmit,
  onCancel,
}: {
  readonly label: string;
  readonly initial?: string;
  readonly submitText: string;
  readonly onSubmit: (value: string) => Promise<boolean>;
  readonly onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="text-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim() === '') return;
        void onSubmit(value).then((done) => {
          if (done) onCancel();
        });
      }}
    >
      <input
        aria-label={label}
        placeholder={label}
        value={value}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
      />
      <button type="submit" disabled={value.trim() === ''}>
        {submitText}
      </button>
      <button type="button" onClick={onCancel}>
        取消
      </button>
    </form>
  );
}
