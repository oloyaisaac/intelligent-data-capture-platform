import React, { useState } from 'react';
import type { Project } from '@idcp/shared';
import type { ApiClient } from '../api/client';
import { formatDateTime } from '../lib/format';
import { Badge, Card, EmptyState, ErrorBanner, Field, useAsync } from '../components/ui';
import { useLocale, useTranslator } from '../lib/locale';

/**
 * TEAM-001 — projects.
 *
 * A project is a grouping label for documents and batches inside the organisation. Archiving keeps
 * the documents (and their assignment) and only hides the project from the default list.
 */
export function ProjectsPage({
  client,
  canManage,
}: {
  client: ApiClient;
  canManage: boolean;
}): React.JSX.Element {
  const t = useTranslator();
  const { locale } = useLocale();
  const projects = useAsync(() => client.listProjects(true), []);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items: Project[] = projects.data?.items ?? [];

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.createProject({
        name: name.trim(),
        ...(key.trim() ? { key: key.trim().toUpperCase() } : {}),
      });
      setName('');
      setKey('');
      await projects.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('projects.createFailed'));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (project: Project) => {
    setError(null);
    try {
      await client.updateProject(project.id, { archived: !project.archivedAt });
      await projects.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('projects.updateFailed'));
    }
  };

  return (
    <div className="stack">
      <h1>{t('projects.title')}</h1>
      <ErrorBanner message={error ?? projects.error} />

      {canManage && (
        <Card title={t('projects.new')}>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Field label={t('projects.name')}>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('projects.namePlaceholder')}
                maxLength={120}
              />
            </Field>
            <Field label={t('projects.key')} hint={t('projects.keyHint')}>
              <input
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder={t('projects.keyPlaceholder')}
                maxLength={20}
              />
            </Field>
            <button
              className="button"
              type="button"
              onClick={() => void create()}
              disabled={busy || name.trim().length < 2}
            >
              {busy ? t('projects.creating') : t('projects.create')}
            </button>
          </div>
        </Card>
      )}

      <Card title={t('projects.all')}>
        {items.length === 0 ? (
          <EmptyState title={t('projects.none')} hint={t('projects.noneHint')} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('projects.name')}</th>
                <th>{t('projects.key')}</th>
                <th>{t('table.created')}</th>
                <th>{t('table.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((project) => (
                <tr key={project.id}>
                  <td>{project.name}</td>
                  <td className="mono">{project.key}</td>
                  <td className="dim">{formatDateTime(project.createdAt, locale)}</td>
                  <td>
                    <Badge tone={project.archivedAt ? 'neutral' : 'success'}>
                      {project.archivedAt ? t('projects.archived') : t('status.active')}
                    </Badge>
                  </td>
                  <td>
                    {canManage && (
                      <button
                        className="button secondary small"
                        type="button"
                        onClick={() => void toggle(project)}
                      >
                        {project.archivedAt ? t('projects.restore') : t('projects.archive')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
