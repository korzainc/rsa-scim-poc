export interface ScimUser {
  id: string;
  externalId: string | null;
  userName: string;
  displayName: string;
  email: string | null;
  active: boolean;
  title: string | null;
  department: string | null;
  userType: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface StatusResponse {
  tokenConfigured: boolean;
  scimPath: string;
  port: number;
  users: number;
  deleted: number;
  groups: number;
  lastPushAt: string | null;
}

export interface ActivityEvent {
  id: number;
  ts: string;
  method: string;
  path: string;
  status: number;
  summary: string | null;
  agent: string | null;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

export const fetchStatus = () => getJson<StatusResponse>('/api/status');
export const fetchUsers = () => getJson<{ users: ScimUser[] }>('/api/users');
export const fetchActivity = () => getJson<{ events: ActivityEvent[] }>('/api/activity');
