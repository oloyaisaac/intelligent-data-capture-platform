import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { UserSummary } from '@idcp/shared';
import { ApiClient, ApiError, BridgeTokenStorage, MemoryTokenStorage } from './api/client';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { BatchesPage } from './pages/BatchesPage';
import { DocumentsPage } from './pages/DocumentsPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { ReviewPage } from './pages/ReviewPage';
import { ExportsPage } from './pages/ExportsPage';
import { ConnectorsPage } from './pages/ConnectorsPage';
import { TemplatesPage } from './pages/TemplatesPage';
import { DevicesPage } from './pages/DevicesPage';
import { SettingsPage } from './pages/SettingsPage';
import { Badge } from './components/ui';
import { LOCALE_OPTIONS, loadLocale, saveLocale, translator } from './lib/i18n';
import type { Locale } from '@idcp/shared';

/**
 * Application shell (DESK-001).
 *
 * Hash routing keeps the renderer working when loaded from `file://` inside Electron, where
 * history-based routing would 404 on reload. The shell owns the session: pages receive a client
 * that is already authenticated.
 */

export type Route =
  | { name: 'dashboard' }
  | { name: 'documents'; documentId?: string; status?: string }
  | { name: 'batches' }
  | { name: 'projects' }
  | { name: 'review'; documentId?: string }
  | { name: 'exports' }
  | { name: 'connectors' }
  | { name: 'templates' }
  | { name: 'devices' }
  | { name: 'settings' }
  | { name: 'accept-invite'; token: string };

export function parseRoute(hash: string): Route {
  const cleaned = hash.replace(/^#\/?/, '');
  const [path, queryString] = cleaned.split('?');
  const params = new URLSearchParams(queryString ?? '');
  const segment = (path ?? '').split('/')[0];

  switch (segment) {
    case 'accept-invite':
      return { name: 'accept-invite', token: params.get('token') ?? '' };
    case 'documents':
      return { name: 'documents', status: params.get('status') ?? undefined };
    case 'review':
      return { name: 'review', documentId: params.get('documentId') ?? undefined };
    case 'batches':
      return { name: 'batches' };
    case 'projects':
      return { name: 'projects' };
    case 'exports':
      return { name: 'exports' };
    case 'connectors':
      return { name: 'connectors' };
    case 'templates':
      return { name: 'templates' };
    case 'devices':
      return { name: 'devices' };
    case 'settings':
      return { name: 'settings' };
    default:
      return { name: 'dashboard' };
  }
}

export function routeHref(route: Route): string {
  switch (route.name) {
    case 'documents':
      return route.status
        ? `#/documents?status=${encodeURIComponent(route.status)}`
        : '#/documents';
    case 'review':
      return route.documentId
        ? `#/review?documentId=${encodeURIComponent(route.documentId)}`
        : '#/review';
    default:
      return `#/${route.name}`;
  }
}

const NAV: Array<{
  route: Route;
  labelKey:
    | 'nav.overview'
    | 'nav.documents'
    | 'nav.batches'
    | 'nav.review'
    | 'nav.exports'
    | 'nav.projects'
    | 'nav.templates'
    | 'nav.connectors'
    | 'nav.devices'
    | 'nav.settings';
  sectionKey?: 'nav.configure';
}> = [
  { route: { name: 'dashboard' }, labelKey: 'nav.overview' },
  { route: { name: 'documents' }, labelKey: 'nav.documents' },
  { route: { name: 'batches' }, labelKey: 'nav.batches' },
  { route: { name: 'review' }, labelKey: 'nav.review' },
  { route: { name: 'exports' }, labelKey: 'nav.exports' },
  { route: { name: 'projects' }, labelKey: 'nav.projects', sectionKey: 'nav.configure' },
  { route: { name: 'templates' }, labelKey: 'nav.templates', sectionKey: 'nav.configure' },
  { route: { name: 'connectors' }, labelKey: 'nav.connectors' },
  { route: { name: 'devices' }, labelKey: 'nav.devices' },
  { route: { name: 'settings' }, labelKey: 'nav.settings' },
];

function createClient(onSessionExpired: () => void): ApiClient {
  const bridge = (
    globalThis as { idcpDesktop?: ConstructorParameters<typeof BridgeTokenStorage>[0] }
  ).idcpDesktop;
  return new ApiClient({
    storage: bridge ? new BridgeTokenStorage(bridge) : new MemoryTokenStorage(),
    onSessionExpired,
  });
}

export function App(): React.JSX.Element {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const [user, setUser] = useState<UserSummary | null>(null);
  const [booted, setBooted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locale, setLocale] = useState<Locale>(() => loadLocale());
  const t = useMemo(() => translator(locale), [locale]);

  const client = useMemo(
    () =>
      createClient(() => {
        setUser(null);
        setError('Your session expired. Sign in again.');
      }),
    [],
  );

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        if (await client.restoreSession()) setUser(await client.me());
      } catch (caught) {
        if (caught instanceof ApiError && caught.status !== 401) setError(caught.message);
      } finally {
        setBooted(true);
      }
    })();
  }, [client]);

  const navigate = useCallback((next: Route) => {
    window.location.hash = routeHref(next).slice(1);
    setRoute(next);
  }, []);

  if (!booted) {
    return (
      <div className="login-shell">
        <p className="muted">Starting IDCP…</p>
      </div>
    );
  }

  // The invitation link opens before sign-in: the token itself is the credential.
  if (!user && route.name === 'accept-invite') {
    return (
      <AcceptInvitePage
        client={client}
        token={route.token}
        onAccepted={async () => {
          try {
            setUser(await client.me());
            setError(null);
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Could not load your account.');
          }
        }}
      />
    );
  }

  if (!user) {
    return (
      <LoginPage
        client={client}
        onSignedIn={async () => {
          try {
            setUser(await client.me());
            setError(null);
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Could not load your account.');
          }
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            ID
          </div>
          <div>
            <div className="brand-name">IDCP</div>
            <div className="dim">{user.organisationName}</div>
          </div>
        </div>

        {NAV.map((entry) => (
          <React.Fragment key={entry.labelKey}>
            {entry.sectionKey && <div className="nav-section">{t(entry.sectionKey)}</div>}
            <button
              type="button"
              className="nav-item"
              aria-current={route.name === entry.route.name ? 'page' : undefined}
              onClick={() => navigate(entry.route)}
            >
              {t(entry.labelKey)}
            </button>
          </React.Fragment>
        ))}

        <div className="nav-spacer" />

        <div className="stack" style={{ gap: 4 }}>
          <div className="dim">{user.email}</div>
          <div className="row">
            <Badge tone={user.role === 'owner' ? 'info' : 'neutral'}>{user.role}</Badge>
            <button
              type="button"
              className="button secondary small"
              onClick={async () => {
                await client.logout();
                setUser(null);
              }}
            >
              {t('action.signOut')}
            </button>
          </div>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <span className="topbar-title">
            {NAV.find((entry) => entry.route.name === route.name)
              ? t(NAV.find((entry) => entry.route.name === route.name)!.labelKey)
              : t('nav.overview')}
          </span>
          <div className="topbar-spacer" />
          <span className="dim">{user.organisationName}</span>
        </header>
        <div className="content">
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}

          {route.name === 'dashboard' && (
            <DashboardPage
              client={client}
              accessToken={client.currentAccessToken()}
              onOpenDocument={(documentId) => navigate({ name: 'review', documentId })}
            />
          )}
          {route.name === 'documents' && (
            <DocumentsPage
              client={client}
              accessToken={client.currentAccessToken()}
              initial={{ status: route.status }}
              onOpenReview={(documentId) => navigate({ name: 'review', documentId })}
            />
          )}
          {route.name === 'review' && (
            <ReviewPage client={client} initialDocumentId={route.documentId} />
          )}
          {route.name === 'batches' && <BatchesPage client={client} />}
          {route.name === 'projects' && (
            <ProjectsPage
              client={client}
              canManage={user.role === 'owner' || user.role === 'admin'}
            />
          )}
          {route.name === 'exports' && <ExportsPage client={client} />}
          {route.name === 'connectors' && <ConnectorsPage client={client} />}
          {route.name === 'templates' && <TemplatesPage client={client} />}
          {route.name === 'devices' && <DevicesPage client={client} />}
          {route.name === 'settings' && (
            <SettingsPage
              client={client}
              role={user.role}
              locale={locale}
              localeOptions={LOCALE_OPTIONS}
              onLocaleChange={(next) => {
                setLocale(next);
                saveLocale(next);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
