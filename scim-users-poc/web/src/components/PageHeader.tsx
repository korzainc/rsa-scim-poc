import type { ReactNode } from 'react';

/** Title + one-line description + page CTA, same treatment as unified-ui's PageHeader. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-[22px] font-black leading-tight text-[#1F2C36]">{title}</h1>
        <p className="mt-1 max-w-2xl text-[13.5px] text-[#4F5355]">{description}</p>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2 pt-1">{actions}</div>}
    </div>
  );
}
