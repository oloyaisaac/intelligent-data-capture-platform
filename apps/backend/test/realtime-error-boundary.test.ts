import { createLogger } from '../src/logger';
import { InMemoryRealtimeHub } from '../src/realtime/hub';

it.each([new Error('SECRET-ERROR'), 'SECRET-ERROR', null])(
  'isolates a throwing subscriber without logging its error',
  (failure) => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
    const hub = new InMemoryRealtimeHub(logger);
    const good = jest.fn();
    hub.subscribe({ organisationId: 'org' }, () => {
      throw failure;
    });
    hub.subscribe({ organisationId: 'org' }, good);
    expect(() => hub.toOrganisation('org', 'document:queued', { documentId: 'doc' })).not.toThrow();
    expect(good).toHaveBeenCalledWith('document:queued', { documentId: 'doc' });
    expect(lines.join('\n')).toContain('realtime subscriber failed');
    expect(lines.join('\n')).not.toContain('SECRET-ERROR');
  },
);
