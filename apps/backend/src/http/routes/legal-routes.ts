import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { AppError } from '@idcp/shared';
import type { Services } from '../../services/container';

/**
 * Public legal documents, served from the repository's `legal/` directory.
 *
 * These routes are deliberately unauthenticated: a person deciding whether to sign up has to be able
 * to read the privacy policy, and a customer's auditor has to be able to fetch the DPA without an
 * account. The slug is matched against a fixed list, so the filesystem path is never built from
 * user input.
 *
 * The files are Markdown: the desktop app opens these URLs in the system browser, and a plain-text
 * response renders readably everywhere without shipping a Markdown parser into the API.
 */
const DOCUMENTS = [
  { slug: 'privacy', filename: 'PRIVACY.md', title: 'Privacy Policy' },
  { slug: 'terms', filename: 'TERMS.md', title: 'Terms of Service' },
  { slug: 'dpa', filename: 'DPA.md', title: 'Data Processing Agreement' },
  { slug: 'subprocessors', filename: 'SUBPROCESSORS.md', title: 'Sub-processors' },
  { slug: 'security', filename: 'SECURITY.md', title: 'Security overview' },
] as const;

export function registerLegalRoutes(app: FastifyInstance, services: Services): void {
  const directory = resolve(services.config.LEGAL_DIR);

  app.get('/legal', async () => ({
    documents: DOCUMENTS.map(({ slug, title }) => ({
      slug,
      title,
      url: `/api/v1/legal/${slug}`,
    })),
  }));

  app.get('/legal/:slug', async (request, reply) => {
    const slug = (request.params as Record<string, string>).slug;
    const document = DOCUMENTS.find((entry) => entry.slug === slug);
    if (!document) throw new AppError('NOT_FOUND', 'No such document.');

    try {
      const text = await readFile(join(directory, document.filename), 'utf8');
      return reply
        .header('cache-control', 'public, max-age=300')
        .type('text/plain; charset=utf-8')
        .send(`# ${document.title}\n\n${stripTitle(text)}`);
    } catch {
      // A missing legal document is a deployment mistake, and it must not look like a routing bug.
      services.logger.error('legal document missing', {
        slug,
        directory,
        file: document.filename,
      });
      throw new AppError(
        'NOT_FOUND',
        'That document is not available in this deployment. Contact the operator.',
      );
    }
  });
}

/** The files carry their own heading; the route adds a stable one so the URL always has a title. */
function stripTitle(text: string): string {
  return text.replace(/^#\s+.*\r?\n/, '').trimStart();
}
