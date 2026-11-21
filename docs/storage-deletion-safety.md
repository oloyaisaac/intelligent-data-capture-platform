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
reported complete. Creation and reads are not protected by this deletion check. Operators must keep
storage roots and ancestors trusted and stable, control all writers and mounts, and use an authorized
reconciliation process; see `storage-inventory.md` and R01 evidence for remaining limitations.
An empty erasure queue or `fileDeletionStatus: complete` is not proof that historical records,
replicas, logs or backups are erased.
