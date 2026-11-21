# Filesystem deletion safety and operations

Filesystem deletion checks the configured root and each key component using `lstat` before removal.
It refuses an absent, symlinked or non-directory root, symlinks in the checked tree, non-directory
intermediate components, and a final object that is not a regular file with exactly one hard link.
A missing component _below_ an accessible root is treated as already deleted for idempotent retry.
This also affects upload and export cleanup, retention, and the privacy erasure queue. A failure in
queued erasure remains pending for retry; operators must investigate persistent failures, preserving
records and evidence. Do not replace or remove links merely to force an erasure to report success.

These are point-in-time checks, **not a security boundary or proof of deletion**. A different writer
can replace components after the check and before removal; root ancestors can be symlinks; another
mount or an empty directory can appear at the configured root or below it; and link counts cannot
identify every external, backup, provider or copied object. The code does not establish the identity
of the intended mount or file, prevent key reuse, fence old versions, or atomically check database
references and delete bytes. A missing file under an accessible but incorrect root can still be
reported complete. Operators must keep storage roots and ancestors trusted and stable, control all
writers and mounts, and use an authorized reconciliation process; see `storage-inventory.md` and
R01 evidence for remaining limitations.
An empty erasure queue or `fileDeletionStatus: complete` is not proof that historical records,
replicas, logs or backups are erased.

## Filesystem creation and reads

New writes check the configured root and each parent beneath it for observed symlinks and
non-directories, then use exclusive creation for the final path. Reads check the same parents and
reject observed symlink, hard-linked or non-regular final objects. On platforms that provide
`O_NOFOLLOW`, opening a read also refuses a final symlink substituted after the initial check;
`O_NONBLOCK`, where available, reduces the risk of hanging on a substituted FIFO. The opened file is
checked again before reading. `exists` returns false for observed unsafe entries and errors; it is
not a diagnostic or proof that a file is absent. Existing deployments that intentionally use
symlinks or hard links within the storage root may see uploads or downloads fail and must investigate.

These checks are not a sandbox. Checks and subsequent operations are separate, so parent paths and
mounts can change between them. A different regular file can be substituted, hard links can be
created after a check, and root ancestors are not checked. `O_NOFOLLOW` and `O_NONBLOCK` behavior
depends on the platform and filesystem; these tests do not validate Windows. For compatibility a
missing root is still created recursively on the first write: a missing or wrong mount can therefore
receive new files in the wrong place. Provision and monitor the intended mount and protect its
ancestors, even if writes appear to succeed. Partial writes, storage/database ambiguity, mixed
versions and external copies still require reconciliation and stronger OS-level controls.
