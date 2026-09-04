import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Routes, Route } from 'react-router-dom';
import { AppSidebar } from './components/AppSidebar';
import { Topbar } from './components/Topbar';
import { IdpUsersPage } from './features/idp-users/IdpUsersPage';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

// Same viewport-fixed shell as rsa-unified-ui: the sidebar stays put, <main> scrolls.
export default function App() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <div className="flex h-screen flex-col bg-[#F5F7FA]">
          <div className="flex min-h-0 flex-1">
            <AppSidebar collapsed={collapsed} />
            <div className="flex min-w-0 flex-1 flex-col">
              <Topbar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
              <main className="flex-1 overflow-auto px-6 py-8">
                <Routes>
                  <Route path="/owners" element={<IdpUsersPage />} />
                  <Route path="*" element={<Navigate to="/owners" replace />} />
                </Routes>
              </main>
            </div>
          </div>
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
