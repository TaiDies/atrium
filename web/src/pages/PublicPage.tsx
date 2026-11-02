import { useQuery } from '@tanstack/react-query';
import { Globe } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { DocumentEditor } from '../app/DocumentEditor';
import { PageIcon } from '../app/PageIcon';
import { FullScreenSpinner } from '../components/ui';
import { DatabaseView } from '../database/DatabaseView';
import type { ViewType } from '../database/model';
import { pageTitle, type PageSummary } from '../lib/api';
import { coverStyle } from '../lib/covers';
import { setDirectory } from '../lib/directory';
import { publicFileUrl, type PublicPageInfo, usePublicDoc } from '../lib/publicDoc';

// A page published to the web (/share/<token>), read-only and without an account.

const GUEST = { id: 'guest', name: 'Guest', email: '', color: '#868e96' };

interface PublishedTree {
  root: string;
  allowIndex: boolean;
  pages: PublicPageInfo[];
}

export function PublicPage() {
  const { token = '', pageId } = useParams();
  const navigate = useNavigate();
  const tree = useQuery({
    queryKey: ['public-page', token],
    queryFn: async () => {
      const res = await fetch(`/api/public/pages/${token}`);
      if (!res.ok) throw new Error(res.status === 404 ? 'missing' : 'failed');
      return (await res.json()) as PublishedTree;
    },
    retry: false,
  });
  const pages = tree.data?.pages ?? [];
  const page = pages.find((p) => p.id === (pageId ?? tree.data?.root));

  // The editor's page links and embedded databases read the directory: here it holds only the published pages.
  useEffect(() => {
    if (!tree.data) return;
    setDirectory({
      workspaceId: '',
      user: GUEST,
      canCreatePages: false,
      pages: pages as unknown as PageSummary[],
      members: [],
      public: { token },
      navigate: (to) => {
        const id = /\/p\/([0-9a-f-]{36})/.exec(to)?.[1];
        if (id && pages.some((p) => p.id === id)) navigate(`/share/${token}/${id}`);
      },
    });
  }, [tree.data, token]);

  useEffect(() => {
    if (page) document.title = pageTitle(page as unknown as PageSummary);
    // Search engines skip published pages unless their owner allows it (the server also says so).
    let meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'robots';
      document.head.appendChild(meta);
    }
    meta.content = tree.data?.allowIndex ? 'index, follow' : 'noindex, nofollow';
  }, [page, tree.data]);

  if (tree.isPending) return <FullScreenSpinner />;
  if (!tree.data || !page) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Globe size={28} className="text-faint" />
        <h1 className="text-lg font-semibold">This page isn’t available</h1>
        <p className="text-sm text-muted">It may have been unpublished, or the link is wrong.</p>
      </div>
    );
  }

  const crumbs: PublicPageInfo[] = [];
  for (let p: PublicPageInfo | undefined = page; p; p = pages.find((x) => x.id === p!.parentId)) crumbs.unshift(p);

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <header className="sticky top-0 z-20 flex h-11 items-center gap-1 border-b border-line bg-bg/90 px-4 text-sm backdrop-blur">
        {crumbs.map((c, i) => (
          <span key={c.id} className="flex min-w-0 items-center gap-1">
            {i > 0 && <span className="text-faint">/</span>}
            <Link to={`/share/${token}/${c.id}`} className="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 hover:bg-hover">
              <PageIcon page={c as unknown as PageSummary} size={14} />
              <span className="max-w-[30vw] truncate">{pageTitle(c as unknown as PageSummary)}</span>
            </Link>
          </span>
        ))}
      </header>
      {page.cover && <div className="h-[22vh] min-h-32 w-full" style={{ background: coverStyle(page.cover, (url) => publicFileUrl(token, url)) }} />}
      <div className="mx-auto w-full max-w-(--page-width) px-6 pt-10 sm:px-[54px]">
        {page.icon && <div className="mb-2 text-5xl leading-none">{page.icon}</div>}
        <h1 className="mb-4 text-4xl font-bold break-words">{pageTitle(page as unknown as PageSummary)}</h1>
      </div>
      <PublicContent key={page.id} token={token} page={page} />
      <footer className="py-10 text-center text-xs text-faint">Published with Workspace</footer>
    </div>
  );
}

function PublicContent({ token, page }: { token: string; page: PublicPageInfo }) {
  const { session, error } = usePublicDoc(token, page.id);
  if (error) return <p className="px-[54px] text-sm text-muted">This page couldn’t be loaded.</p>;
  if (!session) return <FullScreenSpinner />;
  if (page.type === 'document') {
    return (
      <div className="mx-auto w-full max-w-(--page-width)">
        <DocumentEditor session={session} user={GUEST} workspaceId="" parentPageId={page.id} readOnly className="pb-16" />
      </div>
    );
  }
  return (
    <div className="px-6 sm:px-[54px]">
      <DatabaseView doc={session.doc} pageId={page.id} pageType={page.type as ViewType} workspaceId="" readOnly />
    </div>
  );
}
