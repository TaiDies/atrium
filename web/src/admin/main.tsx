import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { ConfirmHost, Toaster } from '../components/ui';
import '../styles.css';
import { AdminApp } from './AdminApp';

const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <AdminApp />
    <Toaster />
    <ConfirmHost />
  </QueryClientProvider>,
);
