# Marketplace manifest signing

Marketplace packages are manifests naming connector types already shipped with the application; they do not install external code. The server no longer signs its own manifests or accepts the old public HMAC default. It verifies detached Ed25519 signatures using a separately provisioned publisher **public** key. The signature covers the manifest ID, connector type, label, vendor, version, summary, ordered permissions, status and revocation reason using a versioned canonical encoding (`packageSigningBytes`). Unknown fields, malformed signatures, duplicate package versions, non-Ed25519 keys and unsigned or untrusted manifests in a configured catalogue prevent startup.

**No publisher key or signed catalogue is provisioned by this repository.** Without both configured paths, the bundled catalogue is informational and all marketplace installs are blocked, in development as well as production. Existing connectors continue to operate; existing installation rows are not automatically invalidated. Rollback cannot reactivate a previous version unless that exact version is currently signed, verified, not revoked, and has matching stored permissions and connector type.

## Provisioning (publisher and operator)

1. On a trusted, isolated publisher system, generate or provision an Ed25519 key pair. Keep the private key out of the repository, application environment, container, build artifacts, logs and runtime host. The simple CLI below reads an unencrypted PEM key file; use strict file permissions and encrypted storage, and use an appropriately controlled signing workflow or HSM integration for production. The repository does not supply an HSM integration or publisher key-custody process.
2. Review every manifest and permission before signing. A catalogue is a JSON array matching `MarketplacePackageSchema` in `apps/backend/src/marketplace/catalog.ts`; every input `signature` must be `null`. For the bundled draft catalogue, the publisher can use the `--bundled` source. The offline signer requires Node, the repo and its development dependencies:

   ```sh
   # Run on the publisher's isolated system, never on the application server.
   # The output path must be outside the repository and controlled by the publisher.
   npx tsx scripts/sign-marketplace.ts --bundled /secure/publisher-private.pem > /secure/catalogue-signed.json
   # Or replace --bundled with a reviewed unsigned JSON catalogue path.
   ```

   Do not commit private keys or rely on the example path existing. Verify the public-key fingerprint through a separate trusted channel. Keep backups and rotation/revocation procedures for the publisher key under the organisation's key-management policy.

3. Distribute the signed JSON catalogue and matching Ed25519 **public** key in PEM SPKI (`BEGIN PUBLIC KEY`) to the deployment using a trusted channel. Protect both from unauthorised replacement; the public key is the trust anchor, not a secret. Configure `MARKETPLACE_CATALOGUE_PATH` and `MARKETPLACE_PUBLIC_KEY_PATH` together and restart all application instances. A bad, missing, mismatched, unsigned or modified file prevents startup rather than silently trusting it. Use a read-only mount and ensure both files are readable by the runtime user. Compose forwards both variables but does not mount files by default: add a deployment-specific read-only mount or secret/config mechanism. Never mount the private key into the runtime container.
4. Test installation, listing, revocation and rollback with the actual signed catalogue in a non-production environment before rollout. To rotate, sign the complete current catalogue with the new key, securely distribute the new public key and catalogue as a matched pair, then restart instances. Mixed deployments with different keys/catalogues can disagree, so coordinate rollout. No dual-key overlap or live reload is implemented.

## Security boundaries and remaining work

Manifest signatures do not sandbox connector code or enforce the listed permissions; the permissions are disclosures recorded with installation. The private-key custody, release approval and provenance process must be established and audited by the publisher; this code alone does not establish a publisher identity. The catalogue file and trust anchor must be protected by deployment controls. Signatures are per manifest, not over the catalogue as a whole, and there is no monotonic version, expiry, transparency log or anti-replay protection. An attacker who can replace the catalogue but not the key can replay an older valid manifest or omit a later revocation. Prevent catalogue replacement and stale-file rollout operationally until signed catalogue metadata and durable anti-rollback enforcement exist. Existing active installation records and running connectors are not automatically revalidated or disabled when trust changes; assess them during key rotation or an incident.
