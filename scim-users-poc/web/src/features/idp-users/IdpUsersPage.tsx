import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Info,
  Radio,
  Search,
} from 'lucide-react';
import { fetchActivity, fetchStatus, fetchUsers } from '../../lib/api';
import type { ActivityEvent, ScimUser } from '../../lib/api';
import { PageHeader } from '../../components/PageHeader';

type Pill = 'all' | 'active' | 'inactive' | 'deleted';
type SortKey = 'displayName' | 'userName' | 'email' | 'department' | 'updatedAt';
type Sort = { key: SortKey; dir: 'asc' | 'desc' } | null;

export function IdpUsersPage() {
  const status = useQuery({ queryKey: ['status'], queryFn: fetchStatus, refetchInterval: 3000 });
  const usersQ = useQuery({ queryKey: ['users'], queryFn: fetchUsers, refetchInterval: 3000 });
  const activityQ = useQuery({ queryKey: ['activity'], queryFn: fetchActivity, refetchInterval: 2500 });

  const [pill, setPill] = useState<Pill>('all');
  const [query, setQuery] = useState('');
  const [searchFocus, setSearchFocus] = useState(false);
  const [sort, setSort] = useState<Sort>({ key: 'displayName', dir: 'asc' });

  const users = useMemo(() => usersQ.data?.users ?? [], [usersQ.data]);

  const counts = useMemo(
    () => ({
      all: users.filter((u) => !u.deletedAt).length,
      active: users.filter((u) => !u.deletedAt && u.active).length,
      inactive: users.filter((u) => !u.deletedAt && !u.active).length,
      deleted: users.filter((u) => u.deletedAt).length,
    }),
    [users],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = users.filter((u) => {
      if (pill === 'deleted') {
        if (!u.deletedAt) return false;
      } else {
        if (u.deletedAt) return false;
        if (pill === 'active' && !u.active) return false;
        if (pill === 'inactive' && u.active) return false;
      }
      if (!q) return true;
      return [u.displayName, u.userName, u.email, u.department, u.title]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(q));
    });
    if (sort) {
      const dir = sort.dir === 'asc' ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const av = (a[sort.key] ?? '').toString().toLowerCase();
        const bv = (b[sort.key] ?? '').toString().toLowerCase();
        return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
      });
    }
    return rows;
  }, [users, pill, query, sort]);

  const empty = users.length === 0;

  return (
    <div className="max-w-[1200px] space-y-5">
      <PageHeader
        title="Owners"
        description="Users provisioned into the gateway by the tenant's IdP over SCIM 2.0 — the IdP pushes creates, updates and deprovisions to our endpoint."
      />

      <StatusNotice
        tokenConfigured={status.data?.tokenConfigured ?? true}
        lastPushAt={status.data?.lastPushAt ?? null}
        userCount={counts.all}
        groupCount={status.data?.groups ?? 0}
      />

      {empty ? (
        <SetupCard tokenConfigured={status.data?.tokenConfigured ?? false} />
      ) : (
        <UsersCard
          shown={shown}
          total={counts.all}
          counts={counts}
          pill={pill}
          onPill={setPill}
          query={query}
          onQuery={setQuery}
          searchFocus={searchFocus}
          onSearchFocus={setSearchFocus}
          sort={sort}
          onSort={setSort}
        />
      )}

      <ActivityCard events={activityQ.data?.events ?? []} />
    </div>
  );
}

// --- notices -----------------------------------------------------------------

function StatusNotice({
  tokenConfigured,
  lastPushAt,
  userCount,
  groupCount,
}: {
  tokenConfigured: boolean;
  lastPushAt: string | null;
  userCount: number;
  groupCount: number;
}) {
  if (!tokenConfigured) {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-[#EFC7C2] bg-[#FBEDEB] px-4 py-2.5">
        <Info className="h-[17px] w-[17px] shrink-0 text-[#BE3A34]" />
        <p className="text-[12.5px] leading-relaxed text-[#2C333D]">
          <span className="font-semibold">SCIM token not configured.</span> Set{' '}
          <code className="rounded bg-white/70 px-1 font-mono text-[11.5px]">SCIM_TOKEN</code> in{' '}
          <code className="rounded bg-white/70 px-1 font-mono text-[11.5px]">.env</code> and restart —
          the IdP can't authenticate until then.
        </p>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-[#BAD1E6] bg-[#E9F0F7] px-4 py-2.5">
      <Info className="h-[17px] w-[17px] shrink-0 text-[#1F6CAE]" />
      <p className="text-[12.5px] leading-relaxed text-[#2C333D]">
        SCIM server ready — <span className="font-semibold">{userCount} users</span>
        {groupCount > 0 && <> · {groupCount} groups</>} provisioned by the IdP
        {lastPushAt ? (
          <>
            {' '}
            · last push <span className="font-semibold">{timeAgo(lastPushAt)}</span>
          </>
        ) : (
          <> · waiting for the first push</>
        )}
        . Data arrives on the IdP's provisioning schedule (Entra: ~40-minute cycles, or
        &quot;Provision on demand&quot; for instant single-user pushes).
      </p>
    </div>
  );
}

function SetupCard({ tokenConfigured }: { tokenConfigured: boolean }) {
  return (
    <div className="rounded-[14px] border border-[#e2e6ec] bg-white p-6 shadow-[0_1px_2px_rgba(16,19,23,.06),0_1px_1px_rgba(16,19,23,.04)]">
      <h2 className="text-[16px] font-bold text-[#101317]">Waiting for the IdP's first push</h2>
      <p className="mt-1 max-w-2xl text-[13px] text-[#4F5355]">
        No users yet. Wire Entra's provisioning client to this SCIM server (full steps in the
        README):
      </p>
      <ol className="mt-4 list-decimal space-y-2 pl-5 text-[13px] leading-relaxed text-[#2C333D]">
        {!tokenConfigured && (
          <li>
            Generate a token (<code className="rounded bg-[#f5f7fa] px-1 font-mono text-[12px]">openssl rand -hex 24</code>),
            put it in <code className="rounded bg-[#f5f7fa] px-1 font-mono text-[12px]">.env</code> as{' '}
            <code className="rounded bg-[#f5f7fa] px-1 font-mono text-[12px]">SCIM_TOKEN</code>, restart.
          </li>
        )}
        <li>
          Expose this server: <code className="rounded bg-[#f5f7fa] px-1 font-mono text-[12px]">make tunnel</code>{' '}
          and copy the https URL.
        </li>
        <li>
          Entra admin center → <span className="font-semibold">Enterprise applications</span> → New
          application → <span className="font-semibold">Create your own</span> (non-gallery).
        </li>
        <li>
          In the app: <span className="font-semibold">Provisioning</span> → Automatic → Tenant URL ={' '}
          <code className="rounded bg-[#f5f7fa] px-1 font-mono text-[12px]">https://&lt;ngrok&gt;/scim/v2</code>,
          Secret Token = your <code className="rounded bg-[#f5f7fa] px-1 font-mono text-[12px]">SCIM_TOKEN</code> →{' '}
          <span className="font-semibold">Test Connection</span>.
        </li>
        <li>
          Settings → Scope = <span className="font-semibold">Sync all users and groups</span> → turn
          provisioning <span className="font-semibold">On</span> (or use{' '}
          <span className="font-semibold">Provision on demand</span> for an instant demo).
        </li>
      </ol>
      <p className="mt-4 text-[12.5px] text-[#5b6573]">
        No Entra handy? <code className="rounded bg-[#f5f7fa] px-1 font-mono text-[12px]">make simulate</code>{' '}
        replays an IdP-shaped provisioning cycle against the real SCIM endpoints.
      </p>
    </div>
  );
}

// --- users grid ---------------------------------------------------------------

const PILLS: { id: Pill; label: string }[] = [
  { id: 'all', label: 'All users' },
  { id: 'active', label: 'Active' },
  { id: 'inactive', label: 'Inactive' },
  { id: 'deleted', label: 'Deprovisioned' },
];

const COLUMNS: { key: string; label: string; width: number; sort?: SortKey }[] = [
  { key: 'user', label: 'User', width: 250, sort: 'displayName' },
  { key: 'userName', label: 'userName', width: 250, sort: 'userName' },
  { key: 'email', label: 'Email', width: 230, sort: 'email' },
  { key: 'status', label: 'Status', width: 120 },
  { key: 'title', label: 'Title', width: 180 },
  { key: 'department', label: 'Department', width: 160, sort: 'department' },
  { key: 'externalId', label: 'External id', width: 120 },
  { key: 'updated', label: 'Last push', width: 120, sort: 'updatedAt' },
];

function UsersCard(props: {
  shown: ScimUser[];
  total: number;
  counts: Record<Pill, number>;
  pill: Pill;
  onPill: (p: Pill) => void;
  query: string;
  onQuery: (q: string) => void;
  searchFocus: boolean;
  onSearchFocus: (f: boolean) => void;
  sort: Sort;
  onSort: (s: Sort) => void;
}) {
  const { shown, total, counts, pill, onPill, query, onQuery, searchFocus, onSearchFocus, sort, onSort } = props;

  const cycle = (key: SortKey) =>
    onSort(
      !sort || sort.key !== key
        ? { key, dir: 'asc' }
        : sort.dir === 'asc'
          ? { key, dir: 'desc' }
          : null,
    );

  const totalW = COLUMNS.reduce((a, c) => a + c.width, 0);

  return (
    <div className="min-h-0 rounded-[14px] border border-[#e2e6ec] bg-white shadow-[0_1px_2px_rgba(16,19,23,.06),0_1px_1px_rgba(16,19,23,.04)]">
      {/* header band */}
      <div className="shrink-0 rounded-t-[14px] border-b border-[#e2e6ec] bg-[#f5f7fa] px-[18px] pt-3.5">
        <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-1.5">
          <div className="flex items-baseline gap-2.5">
            <span className="text-[16px] font-bold text-[#101317]">Provisioned users</span>
            <span className="text-[11.5px] text-[#5b6573]">
              Showing {shown.length} of {total} users
            </span>
          </div>
          <div className="flex min-w-[300px] flex-[1_1_380px] justify-end">
            <div className="flex items-center gap-2 pb-4">
              <div
                className={`inline-flex h-7 flex-shrink-0 items-center gap-[7px] rounded-full border bg-white px-3 transition-[border-color,box-shadow] duration-150 ${
                  searchFocus
                    ? 'border-[#1F6CAE] shadow-[0_0_0_3px_rgba(31,108,174,.18)]'
                    : 'border-[#cbd2db] shadow-none'
                }`}
              >
                <Search className="h-[14px] w-[14px] text-[#5b6573]" />
                <input
                  value={query}
                  onChange={(e) => onQuery(e.target.value)}
                  onFocus={() => onSearchFocus(true)}
                  onBlur={() => onSearchFocus(false)}
                  placeholder="Search name, userName, email…"
                  aria-label="Search users"
                  className="w-[200px] border-0 bg-transparent text-[12.5px] text-[#101317] outline-none"
                />
              </div>
            </div>
          </div>
        </div>
        {/* pills */}
        <div className="pb-3">
          <div className="flex flex-nowrap items-center gap-2 overflow-x-auto pb-0.5">
            {PILLS.map((t) => {
              const on = pill === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onPill(t.id)}
                  className={`inline-flex h-7 flex-shrink-0 items-center gap-[7px] whitespace-nowrap rounded-full border px-[13px] text-[12.5px] font-normal transition-colors hover:border-[#1F6CAE] ${
                    on
                      ? 'border-[#1F6CAE] bg-[#E9F0F7] text-[#1F6CAE]'
                      : 'border-[#cbd2db] bg-white text-[#2c333d]'
                  }`}
                >
                  {t.label}
                  <span className={`text-[11px] font-semibold ${on ? 'text-[#1F6CAE]' : 'text-[#9aa3b0]'}`}>
                    {counts[t.id]}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* table */}
      <div className="min-h-0 overflow-hidden rounded-b-[14px]">
        <div className="max-h-[54vh] overflow-auto">
          <table
            className="border-collapse [table-layout:fixed]"
            style={{ width: totalW, minWidth: '100%' }}
          >
            <colgroup>
              {COLUMNS.map((c) => (
                <col key={c.key} style={{ width: c.width }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {COLUMNS.map((c) => {
                  const active = sort?.key === c.sort;
                  return (
                    <th
                      key={c.key}
                      className="sticky top-0 z-[2] border-b border-[#e2e6ec] bg-white px-3.5 py-[10px] text-left align-bottom text-[11.5px] font-bold leading-[1.25] tracking-[0.02em] text-[#2c333d]"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="flex-auto">{c.label}</span>
                        {c.sort && (
                          <button
                            type="button"
                            onClick={() => cycle(c.sort!)}
                            title={active ? `Sorted ${sort!.dir}` : 'Sort'}
                            className={`inline-flex items-center rounded-full border-0 py-px ${
                              active
                                ? 'bg-[#F3D4D3] px-[5px] text-[#BE3A34]'
                                : 'bg-transparent px-[3px] text-[#9aa3b0]'
                            }`}
                          >
                            {active ? (
                              sort!.dir === 'asc' ? (
                                <ArrowUp className="h-[14px] w-[14px]" />
                              ) : (
                                <ArrowDown className="h-[14px] w-[14px]" />
                              )
                            ) : (
                              <ChevronsUpDown className="h-[16px] w-[16px]" />
                            )}
                          </button>
                        )}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNS.length} className="py-12 text-center text-[13px] text-[#5b6573]">
                    No users match.
                  </td>
                </tr>
              ) : (
                shown.map((u) => <Row key={u.id} u={u} />)
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const TD =
  'overflow-hidden text-ellipsis whitespace-nowrap border-b border-[#e2e6ec] px-3.5 py-[9px] align-middle text-[13px] text-[#2c333d]';

function Row({ u }: { u: ScimUser }) {
  return (
    <tr className={`cursor-default hover:bg-[#f5f7fa] ${u.deletedAt ? 'opacity-50' : ''}`}>
      <td className={TD}>
        <div className="flex items-center gap-2.5">
          <span className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-full bg-[#E9F0F7] text-[11px] font-bold text-[#1F6CAE]">
            {initials(u.displayName || u.userName)}
          </span>
          <span className="truncate font-semibold text-[#101317]">{u.displayName || '—'}</span>
        </div>
      </td>
      <td className={TD} title={u.userName}>
        {u.userName}
      </td>
      <td className={TD}>{u.email ?? <Dim>—</Dim>}</td>
      <td className={TD}>
        <StatusDot u={u} />
      </td>
      <td className={TD}>{u.title ?? <Dim>—</Dim>}</td>
      <td className={TD}>{u.department ?? <Dim>—</Dim>}</td>
      <td className={TD}>{u.externalId ?? <Dim>—</Dim>}</td>
      <td className={TD} title={u.updatedAt}>
        {timeAgo(u.updatedAt)}
      </td>
    </tr>
  );
}

function Dim({ children }: { children: React.ReactNode }) {
  return <span className="text-[#9aa3b0]">{children}</span>;
}

function StatusDot({ u }: { u: ScimUser }) {
  const [color, label] = u.deletedAt
    ? ['bg-[#9aa3b0]', 'Deprovisioned']
    : u.active
      ? ['bg-[#1E8E3E]', 'Active']
      : ['bg-[#D83E1C]', 'Inactive'];
  return (
    <span className="inline-flex items-center gap-1.5 text-[12.5px]">
      <span className={`h-2 w-2 rounded-full ${color}`} aria-hidden="true" />
      {label}
    </span>
  );
}

// --- SCIM activity feed --------------------------------------------------------

const METHOD_STYLE: Record<string, string> = {
  GET: 'border-[#cbd2db] bg-white text-[#2c333d]',
  POST: 'border-[#B5D6BD] bg-[#EAF5ED] text-[#1E8E3E]',
  PATCH: 'border-[#BAD1E6] bg-[#E9F0F7] text-[#1F6CAE]',
  PUT: 'border-[#BAD1E6] bg-[#E9F0F7] text-[#1F6CAE]',
  DELETE: 'border-[#EFC7C2] bg-[#FBEDEB] text-[#BE3A34]',
};

function ActivityCard({ events }: { events: ActivityEvent[] }) {
  return (
    <div className="min-h-0 rounded-[14px] border border-[#e2e6ec] bg-white shadow-[0_1px_2px_rgba(16,19,23,.06),0_1px_1px_rgba(16,19,23,.04)]">
      <div className="flex items-baseline gap-2.5 rounded-t-[14px] border-b border-[#e2e6ec] bg-[#f5f7fa] px-[18px] py-3">
        <Radio className="h-[15px] w-[15px] self-center text-[#1F6CAE]" />
        <span className="text-[16px] font-bold text-[#101317]">SCIM activity</span>
        <span className="text-[11.5px] text-[#5b6573]">
          live requests from the IdP's provisioning client
        </span>
      </div>
      <div className="max-h-[300px] overflow-auto rounded-b-[14px]">
        {events.length === 0 ? (
          <p className="py-8 text-center text-[13px] text-[#5b6573]">
            Nothing yet — requests appear here the moment the IdP calls the endpoint.
          </p>
        ) : (
          <ul>
            {events.map((e) => (
              <li
                key={e.id}
                className="flex items-center gap-3 border-b border-[#eef0f3] px-[18px] py-[7px] text-[12.5px]"
              >
                <span className="w-[86px] shrink-0 tabular-nums text-[#9aa3b0]">
                  {new Date(e.ts).toLocaleTimeString()}
                </span>
                <span
                  className={`inline-flex w-[62px] shrink-0 justify-center rounded-full border px-1.5 py-px text-[10.5px] font-bold ${METHOD_STYLE[e.method] ?? METHOD_STYLE.GET}`}
                >
                  {e.method}
                </span>
                <span className="shrink-0 font-mono text-[11.5px] text-[#2c333d]">{e.path}</span>
                <span
                  className={`shrink-0 tabular-nums text-[11.5px] font-bold ${e.status < 400 ? 'text-[#1E8E3E]' : 'text-[#BE3A34]'}`}
                >
                  {e.status}
                </span>
                <span className="truncate text-[#5b6573]">{e.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// --- misc ----------------------------------------------------------------------

function initials(name: string) {
  const parts = name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

function timeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
