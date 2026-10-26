import React, { useState } from 'react';
import type { Project } from '@idcp/shared';
import type { ApiClient } from '../api/client';
import { formatDateTime } from '../lib/format';
import { Badge, Card, EmptyState, ErrorBanner, Field, useAsync } from '../components/ui';

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
      setError(caught instanceof Error ? caught.message : 'Could not create the project.');
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
      setError(caught instanceof Error ? caught.message : 'Could not update the project.');
    }
  };

  return (
    <div className="stack">
      <h1>Projects</h1>
      <ErrorBanner message={error ?? projects.error} />

      {canManage && (
        <Card title="New project">
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Field label="Name">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Kampala branch"
                maxLength={120}
              />
            </Field>
            <Field label="Key" hint="Optional — derived from the name when left blank.">
              <input
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="KAMPALA"
                maxLength={20}
              />
            </Field>
            <button
              className="button"
              type="button"
              onClick={() => void create()}
              disabled={busy || name.trim().length < 2}
            >
              {busy ? 'Creating…' : 'Create project'}
            </button>
          </div>
        </Card>
      )}

      <Card title="All projects">
        {items.length === 0 ? (
          <EmptyState
            title="No projects yet"
            hint="Group documents and batches by branch, client or month."
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Created</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((project) => (
                <tr key={project.id}>
                  <td>{project.name}</td>
                  <td className="mono">{project.key}</td>
                  <td className="dim">{formatDateTime(project.createdAt)}</td>
                  <td>
                    <Badge tone={project.archivedAt ? 'neutral' : 'success'}>
                      {project.archivedAt ? 'archived' : 'active'}
                    </Badge>
                  </td>
                  <td>
                    {canManage && (
                      <button
                        className="button secondary small"
                        type="button"
                        onClick={() => void toggle(project)}
                      >
                        {project.archivedAt ? 'Restore' : 'Archive'}
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
