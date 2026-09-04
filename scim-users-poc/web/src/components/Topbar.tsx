import { useQuery } from '@tanstack/react-query';
import { Waypoints } from 'lucide-react';
import { fetchStatus } from '../lib/api';

// Fluent panel-left contract/expand glyphs, same as rsa-unified-ui's Topbar.
const PANEL_CONTRACT =
  'M14.808 9.249a.75.75 0 0 0-1.06-.056l-2.5 2.25a.75.75 0 0 0 0 1.114l2.5 2.25a.75.75 0 0 0 1.004-1.115l-1.048-.942h3.546a.75.75 0 1 0 0-1.5h-3.546l1.048-.942a.75.75 0 0 0 .055-1.059M2 17.251A2.75 2.75 0 0 0 4.75 20h14.5A2.75 2.75 0 0 0 22 17.25V6.75A2.75 2.75 0 0 0 19.25 4H4.75A2.75 2.75 0 0 0 2 6.75zm2.75 1.25c-.69 0-1.25-.56-1.25-1.25V6.749c0-.69.56-1.25 1.25-1.25h3.254V18.5zm4.754 0V5.5h9.746c.69 0 1.25.56 1.25 1.25v10.5c0 .69-.56 1.25-1.25 1.25z';
const PANEL_EXPAND =
  'M14.193 14.751a.75.75 0 0 0 1.059.056l2.5-2.25a.75.75 0 0 0 0-1.114l-2.5-2.25a.75.75 0 0 0-1.004 1.115l1.048.942H11.75a.75.75 0 1 0 0 1.5h3.546l-1.048.942a.75.75 0 0 0-.055 1.06M2 6.75A2.75 2.75 0 0 1 4.75 4h14.5A2.75 2.75 0 0 1 22 6.75v10.5A2.75 2.75 0 0 1 19.25 20H4.75A2.75 2.75 0 0 1 2 17.25zM4.75 5.5c-.69 0-1.25.56-1.25 1.25v10.5c0 .69.56 1.25 1.25 1.25h3.254v-13zm4.754 0v13h9.746c.69 0 1.25-.56 1.25-1.25V6.75c0-.69-.56-1.25-1.25-1.25z';

export function Topbar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-[#E2E6EC] bg-white px-4">
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title="Toggle navigation"
        className="grid h-9 w-9 place-items-center rounded-[10px] border border-[#E2E6EC] text-[#2C333D] transition-colors hover:bg-neutral-50"
      >
        <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d={collapsed ? PANEL_EXPAND : PANEL_CONTRACT} />
        </svg>
      </button>

      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-[14px]">
        <span className="text-neutral-700">Discover</span>
        <span className="text-neutral-400">/</span>
        <span className="font-semibold text-[#101317]">Owners</span>
      </nav>

      <div className="ml-auto">
        <ScimBadge />
      </div>
    </header>
  );
}

/** Mirrors the unified UI's RUNTIME picker trigger, repurposed to show the SCIM
 *  endpoint the IdP's provisioning client pushes to. */
function ScimBadge() {
  const { data } = useQuery({ queryKey: ['status'], queryFn: fetchStatus, refetchInterval: 5000 });
  const value = data
    ? data.tokenConfigured
      ? `:${data.port}${data.scimPath}`
      : 'token not set'
    : '…';

  return (
    <div
      title="SCIM 2.0 server endpoint — point your IdP's provisioning client (via ngrok) here"
      className="inline-flex h-11 items-center gap-2.5 rounded-[10px] border border-[#E2E6EC] bg-white px-3 text-left"
    >
      <Waypoints className="h-[17px] w-[17px] shrink-0 text-[#5B6573]" />
      <span className="flex min-w-0 max-w-[280px] flex-col leading-none">
        <span className="text-[9.5px] font-bold uppercase tracking-[0.08em] text-[#9AA3B0]">
          SCIM endpoint
        </span>
        <span className="mt-0.5 truncate font-mono text-[12.5px] font-bold text-[#101317]">
          {value}
        </span>
      </span>
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${
          data?.tokenConfigured ? 'bg-[#1E8E3E]' : 'bg-[#D83E1C]'
        }`}
        aria-hidden="true"
      />
    </div>
  );
}
