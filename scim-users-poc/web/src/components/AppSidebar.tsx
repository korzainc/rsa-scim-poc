import { NavLink } from 'react-router-dom';
import { Users } from 'lucide-react';

// Single-destination sidebar: this POC only ships Owners (the IdP-provisioned
// user directory), so nothing else is listed.

const ROW =
  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium leading-[1.25] transition-colors';

export function AppSidebar({ collapsed }: { collapsed: boolean }) {
  return (
    <aside
      className={`${collapsed ? 'w-16' : 'w-64'} shrink-0 flex flex-col bg-[#1F2C36] text-white transition-[width] duration-200 ease-in-out`}
    >
      <div
        className={`flex h-16 items-center border-b border-white/[0.08] ${
          collapsed ? 'justify-center px-0' : 'gap-3 px-[18px]'
        }`}
      >
        <img src="/brand/rsa-logo.png" alt="RSA" className="h-[26px] w-auto shrink-0" />
        {!collapsed && (
          <span className="truncate text-[11px] font-bold uppercase leading-[1.3] tracking-[0.09em] text-white/90">
            Discover · Secure
          </span>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-[10px] py-4">
        <NavLink
          to="/owners"
          title={collapsed ? 'Owners' : undefined}
          className={({ isActive }) =>
            `${ROW} ${collapsed ? 'justify-center' : ''} ${
              isActive
                ? 'bg-[rgba(40,156,255,0.16)] font-semibold text-white'
                : 'text-white/75 hover:bg-white/5 hover:text-white'
            }`
          }
        >
          {({ isActive }) => (
            <>
              <Users
                className={`h-[19px] w-[19px] shrink-0 ${isActive ? 'text-[#289CFF]' : 'text-white/55'}`}
              />
              {!collapsed && <span className="truncate">Owners</span>}
            </>
          )}
        </NavLink>
      </nav>

      {!collapsed && (
        <div className="border-t border-white/[0.08] px-4 py-3 text-[10.5px] leading-relaxed text-white/35">
          GTW-179 POC · SCIM user provisioning
        </div>
      )}
    </aside>
  );
}
