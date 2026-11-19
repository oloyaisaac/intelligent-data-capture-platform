# R01 layer map — working inventory

**Status: interim, not G1 approval or reviewer sign-off.** This inventory covers tracked first-party
TypeScript/JavaScript source modules under the five workspace `src/` directories at the current
worktree; tests, styles, native projects, configuration and generated build outputs are outside its
scope. Listing a module does not certify that its imports follow the desired layer rule.

## Intended dependency direction

Clients use public shared contracts and call the backend over HTTP. The Electron main process and
preload are privileged adapters; renderer pages/components should use the preload bridge, not import
backend internals or Node APIs. Backend request adapters (`http/`) call application services, which
use domain logic and ports and receive repository/storage/realtime/provider dependencies. Repositories
own SQL and use the database port. Driver/transport/provider implementations sit at the outer edge;
entry points compose them. Shared contracts must not depend on applications. Connector interfaces and
implementations depend on shared code, not application internals.

This is an intended rule, not a claim that all boundaries pass: the HTTP layer receives the entire
`Services` graph; connector implementations execute in-process; process/CLI/provider factories
also construct adapters. The realtime route now uses the optional subscription capability on the
hub port rather than a concrete-hub cast. The offline migration
CLI is a separate entry point. See `findings.md` for outstanding issues and `dependency-graph.md`
for the limited static cycle scan. Transactional repository sets for authentication, pairing,
upload and privacy are supplied by the composition entry point, not constructed by the services.

## Module placement

Within each group the explicit paths are the modules in that layer or functional slice. Grouping
is descriptive: for example, provider interfaces and implementations coexist under `ai/providers`,
repository row types coexist with SQL adapters, and connector contracts coexist with implementations.
The filesystem layout is not itself proof of dependency direction.

### `apps/backend/src (root modules)`

- `apps/backend/src/config.ts`
- `apps/backend/src/index.ts`
- `apps/backend/src/logger.ts`

### `apps/backend/src/ai/`

- `apps/backend/src/ai/classify.ts`
- `apps/backend/src/ai/corpus-harness.ts`
- `apps/backend/src/ai/extract.ts`
- `apps/backend/src/ai/pipeline.ts`
- `apps/backend/src/ai/providers/cloud.ts`
- `apps/backend/src/ai/providers/tesseract.ts`
- `apps/backend/src/ai/providers/types.ts`

### `apps/backend/src/auth/`

- `apps/backend/src/auth/password.ts`
- `apps/backend/src/auth/tokens.ts`
- `apps/backend/src/auth/totp.ts`

### `apps/backend/src/db/`

- `apps/backend/src/db/database.ts`
- `apps/backend/src/db/encryption-migration-cli.ts`
- `apps/backend/src/db/health.ts`
- `apps/backend/src/db/index.ts`
- `apps/backend/src/db/migrate-cli.ts`
- `apps/backend/src/db/migrations.ts`
- `apps/backend/src/db/postgres.ts`
- `apps/backend/src/db/seed-cli.ts`
- `apps/backend/src/db/sqlite.ts`

### `apps/backend/src/http/`

- `apps/backend/src/http/app.ts`
- `apps/backend/src/http/guards.ts`
- `apps/backend/src/http/routes/api-key-routes.ts`
- `apps/backend/src/http/routes/auth-routes.ts`
- `apps/backend/src/http/routes/batch-routes.ts`
- `apps/backend/src/http/routes/batch-upload.ts`
- `apps/backend/src/http/routes/connector-routes.ts`
- `apps/backend/src/http/routes/document-routes.ts`
- `apps/backend/src/http/routes/export-routes.ts`
- `apps/backend/src/http/routes/legal-routes.ts`
- `apps/backend/src/http/routes/marketplace-routes.ts`
- `apps/backend/src/http/routes/organisation-routes.ts`
- `apps/backend/src/http/routes/pairing-routes.ts`
- `apps/backend/src/http/routes/privacy-routes.ts`
- `apps/backend/src/http/routes/project-routes.ts`
- `apps/backend/src/http/routes/realtime-routes.ts`
- `apps/backend/src/http/routes/review-routes.ts`
- `apps/backend/src/http/routes/template-routes.ts`
- `apps/backend/src/http/routes/workflow-routes.ts`

### `apps/backend/src/marketplace/`

- `apps/backend/src/marketplace/catalog.ts`
- `apps/backend/src/marketplace/load-catalogue.ts`

### `apps/backend/src/realtime/`

- `apps/backend/src/realtime/hub.ts`

### `apps/backend/src/repositories/`

- `apps/backend/src/repositories/apikey-repo.ts`
- `apps/backend/src/repositories/auth-repo.ts`
- `apps/backend/src/repositories/batch-repo.ts`
- `apps/backend/src/repositories/connector-repo.ts`
- `apps/backend/src/repositories/dashboard-repo.ts`
- `apps/backend/src/repositories/device-repo.ts`
- `apps/backend/src/repositories/document-repo.ts`
- `apps/backend/src/repositories/encryption-migration-repo.ts`
- `apps/backend/src/repositories/erasure-files-repo.ts`
- `apps/backend/src/repositories/maintenance-repo.ts`
- `apps/backend/src/repositories/marketplace-repo.ts`
- `apps/backend/src/repositories/privacy-repo.ts`
- `apps/backend/src/repositories/project-repo.ts`
- `apps/backend/src/repositories/review-repo.ts`
- `apps/backend/src/repositories/system-repo.ts`
- `apps/backend/src/repositories/template-repo.ts`
- `apps/backend/src/repositories/types.ts`
- `apps/backend/src/repositories/workflow-repo.ts`

### `apps/backend/src/services/`

- `apps/backend/src/services/api-key-service.ts`
- `apps/backend/src/services/auth-service.ts`
- `apps/backend/src/services/batch-service.ts`
- `apps/backend/src/services/connector-service.ts`
- `apps/backend/src/services/container.ts`
- `apps/backend/src/services/crypto.ts`
- `apps/backend/src/services/document-service.ts`
- `apps/backend/src/services/encryption-migration.ts`
- `apps/backend/src/services/erasure-files.ts`
- `apps/backend/src/services/export-service.ts`
- `apps/backend/src/services/mailer.ts`
- `apps/backend/src/services/maintenance-service.ts`
- `apps/backend/src/services/marketplace-service.ts`
- `apps/backend/src/services/organisation-service.ts`
- `apps/backend/src/services/pairing-service.ts`
- `apps/backend/src/services/privacy-service.ts`
- `apps/backend/src/services/project-service.ts`
- `apps/backend/src/services/review-service.ts`
- `apps/backend/src/services/template-service.ts`
- `apps/backend/src/services/worker.ts`
- `apps/backend/src/services/workflow-service.ts`

### `apps/backend/src/storage/`

- `apps/backend/src/storage/index.ts`

### `apps/backend/src/workflows/`

- `apps/backend/src/workflows/engine.ts`

### `apps/desktop/src (root modules)`

- `apps/desktop/src/App.tsx`
- `apps/desktop/src/main.tsx`

### `apps/desktop/src/api/`

- `apps/desktop/src/api/client.ts`

### `apps/desktop/src/components/`

- `apps/desktop/src/components/SendToDestination.tsx`
- `apps/desktop/src/components/ui.tsx`

### `apps/desktop/src/lib/`

- `apps/desktop/src/lib/charts.ts`
- `apps/desktop/src/lib/format.ts`
- `apps/desktop/src/lib/i18n.ts`
- `apps/desktop/src/lib/labels.ts`
- `apps/desktop/src/lib/locale.tsx`
- `apps/desktop/src/lib/realtime.ts`
- `apps/desktop/src/lib/review.ts`

### `apps/desktop/src/main/`

- `apps/desktop/src/main/app-protocol.ts`
- `apps/desktop/src/main/electron-main.ts`
- `apps/desktop/src/main/preload.ts`

### `apps/desktop/src/marketplace/`

- `apps/desktop/src/marketplace/MarketplacePage.tsx`

### `apps/desktop/src/pages/`

- `apps/desktop/src/pages/AcceptInvitePage.tsx`
- `apps/desktop/src/pages/AccountPage.tsx`
- `apps/desktop/src/pages/BatchesPage.tsx`
- `apps/desktop/src/pages/ConnectorsPage.tsx`
- `apps/desktop/src/pages/DashboardPage.tsx`
- `apps/desktop/src/pages/DevicesPage.tsx`
- `apps/desktop/src/pages/DocumentsPage.tsx`
- `apps/desktop/src/pages/ExportsPage.tsx`
- `apps/desktop/src/pages/LoginPage.tsx`
- `apps/desktop/src/pages/ProjectsPage.tsx`
- `apps/desktop/src/pages/ReviewPage.tsx`
- `apps/desktop/src/pages/SettingsPage.tsx`
- `apps/desktop/src/pages/TemplatesPage.tsx`

### `apps/desktop/src/workflows/`

- `apps/desktop/src/workflows/WorkflowsPage.tsx`

### `apps/mobile/src (root modules)`

- `apps/mobile/src/App.tsx`

### `apps/mobile/src/api/`

- `apps/mobile/src/api/client.ts`

### `apps/mobile/src/assist/`

- `apps/mobile/src/assist/commands.ts`
- `apps/mobile/src/assist/consent.ts`
- `apps/mobile/src/assist/guidance.ts`
- `apps/mobile/src/assist/reviewVoice.ts`
- `apps/mobile/src/assist/speechPlatform.ts`

### `apps/mobile/src/auth/`

- `apps/mobile/src/auth/keys.ts`
- `apps/mobile/src/auth/memoryStore.ts`
- `apps/mobile/src/auth/secureStore.ts`

### `apps/mobile/src/capture/`

- `apps/mobile/src/capture/QrScannerView.tsx`
- `apps/mobile/src/capture/edgeDetection.ts`
- `apps/mobile/src/capture/frameProcessor.tsx`
- `apps/mobile/src/capture/imagePipeline.ts`
- `apps/mobile/src/capture/useDocumentDetector.ts`

### `apps/mobile/src/pairing/`

- `apps/mobile/src/pairing/pairing.ts`

### `apps/mobile/src/screens/`

- `apps/mobile/src/screens/CaptureScreen.tsx`
- `apps/mobile/src/screens/PairingScreen.tsx`
- `apps/mobile/src/screens/QueueScreen.tsx`
- `apps/mobile/src/screens/ReviewScreen.tsx`
- `apps/mobile/src/screens/SignInScreen.tsx`

### `apps/mobile/src/state/`

- `apps/mobile/src/state/queueStorage.ts`
- `apps/mobile/src/state/uploadQueue.ts`

### `apps/mobile/src/ui/`

- `apps/mobile/src/ui/locale.ts`
- `apps/mobile/src/ui/theme.ts`

### `packages/connectors/src (root modules)`

- `packages/connectors/src/contract.ts`
- `packages/connectors/src/csv-connector.ts`
- `packages/connectors/src/google-sheets-connector.ts`
- `packages/connectors/src/index.ts`
- `packages/connectors/src/mysql-connector.ts`
- `packages/connectors/src/postgres-connector.ts`
- `packages/connectors/src/registry.ts`
- `packages/connectors/src/sqlite-connector.ts`

### `packages/connectors/src/crm/`

- `packages/connectors/src/crm/http.ts`
- `packages/connectors/src/crm/hubspot-connector.ts`
- `packages/connectors/src/crm/odoo-connector.ts`
- `packages/connectors/src/crm/quickbooks-connector.ts`
- `packages/connectors/src/crm/safe-http.ts`

### `packages/shared/src (root modules)`

- `packages/shared/src/constants.ts`
- `packages/shared/src/contracts.ts`
- `packages/shared/src/csv.ts`
- `packages/shared/src/dates.ts`
- `packages/shared/src/dedupe.ts`
- `packages/shared/src/errors.ts`
- `packages/shared/src/i18n.ts`
- `packages/shared/src/ids.ts`
- `packages/shared/src/index.ts`
- `packages/shared/src/money.ts`
- `packages/shared/src/review.ts`

### `packages/shared/src/udm/`

- `packages/shared/src/udm/schema.ts`

Inventory count: **165** tracked source modules. Repeat with `git ls-files` when source files change.
